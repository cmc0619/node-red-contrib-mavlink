'use strict';

/**
 * COMMAND_ACK waiting logic (DESIGN.md §9 "Three kinds of confirmation",
 * "The vehicle answers can you do this right now", "A missing ack is not
 * a failure").
 *
 * AckWaiter subscribes to COMMAND_ACK on a connection, matches by (commandId,
 * source sysid/compid), and handles:
 *   - IN_PROGRESS (5): keep waiting for a terminal result
 *   - TEMPORARILY_REJECTED (1): back off and retry (where noAutoRetry is false)
 *   - ACCEPTED (0): terminal success
 *   - everything else: terminal failure
 *   - timeout: delegate to the caller's onTimeout callback, which checks the
 *     peer table for a completion condition (§9 "A missing ack is not a failure")
 *
 * The confirmation byte is incremented on each retry (MAVLink spec: 0 = first
 * transmission, 1–255 = confirmation transmissions).
 *
 * Not exported for direct use — the mavlink-command node constructs one per
 * in-flight transaction.
 */

const { MAV_RESULT, TERMINAL_RESULTS, SUCCESS_RESULTS, RESULT_NAME } = require('./status-record');

/** Default retry back-off interval for TEMPORARILY_REJECTED (ms). */
const DEFAULT_RETRY_INTERVAL_MS = 1000;
/** Default maximum retries before giving up. */
const DEFAULT_MAX_RETRIES = 3;
/** Default ACK wait timeout (ms). */
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * @typedef {object} AckResult
 * @property {string}  result        - result name ('accepted', 'failed', 'timeout', ...)
 * @property {number|null} resultCode - MAV_RESULT numeric value; null on timeout
 * @property {'ack'|'none'} confirmedBy
 * @property {number}  retries
 * @property {number}  elapsed       - ms from first send to terminal
 * @property {string|null} detail    - extra human-readable context
 */

class AckWaiter {
  /**
   * @param {object} opts
   * @param {(filter: object, handler: Function) => (() => void)} opts.subscribe
   *   Connection subscription function; returns an unsubscribe handle.
   * @param {(confirmation: number) => void} opts.sendFn
   *   Called with the confirmation counter to (re-)send the COMMAND_LONG.
   * @param {number}  opts.commandId   - MAV_CMD value being waited on
   * @param {number}  opts.targetSysid
   * @param {number}  opts.targetCompid
   * @param {number}  [opts.timeoutMs]
   * @param {number}  [opts.maxRetries]
   * @param {number}  [opts.retryIntervalMs]
   * @param {boolean} [opts.noAutoRetry]  when true, TEMPORARILY_REJECTED is terminal
   * @param {() => number} [opts.now]  clock source (ms)
   */
  constructor(opts) {
    this._subscribe = opts.subscribe;
    this._sendFn = opts.sendFn;
    this._commandId = opts.commandId;
    this._targetSysid = opts.targetSysid;
    this._targetCompid = opts.targetCompid;
    this._timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this._maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    this._retryIntervalMs =
      opts.retryIntervalMs !== undefined ? opts.retryIntervalMs : DEFAULT_RETRY_INTERVAL_MS;
    this._noAutoRetry = !!opts.noAutoRetry;
    this._now = opts.now || Date.now;

    this._unsubscribe = null;
    this._timeoutHandle = null;
    this._retryHandle = null;
    this._retries = 0;
    this._confirmation = 0;
    this._startMs = 0;
    this._settled = false;
    this._resolve = null;
  }

  /**
   * Begin waiting. Sends the initial command (confirmation=0) and returns a
   * Promise that resolves with an {@link AckResult} on any terminal outcome.
   *
   * @returns {Promise<AckResult>}
   */
  start() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._startMs = this._now();

      this._unsubscribe = this._subscribe(
        { message: 'COMMAND_ACK' },
        (decoded) => this._onAck(decoded)
      );

      this._arm();
      this._sendFn(this._confirmation);
    });
  }

  /**
   * Whether an incoming ack came from the vehicle this transaction addressed.
   *
   * The source system must equal the command target unless we broadcast
   * (target sysid 0). The source component must equal the target component
   * unless the command was addressed to all components (target compid 0) or
   * the ack carries no usable source component.
   *
   * @param {object} decoded  decoded COMMAND_ACK message
   * @returns {boolean}
   */
  _matchesSource(decoded) {
    if (this._targetSysid !== undefined && this._targetSysid !== 0) {
      if (decoded.sysid !== undefined && decoded.sysid !== this._targetSysid) return false;
    }
    if (this._targetCompid !== undefined && this._targetCompid !== 0) {
      if (decoded.compid !== undefined && decoded.compid !== this._targetCompid) return false;
    }
    return true;
  }

  /**
   * Arm the overall timeout. Called after every send.
   */
  _arm() {
    this._clearTimeout();
    this._timeoutHandle = setTimeout(() => this._onTimeout(), this._timeoutMs);
  }

  /**
   * Handle an incoming COMMAND_ACK.
   *
   * @param {object} decoded  decoded COMMAND_ACK message
   */
  _onAck(decoded) {
    if (this._settled) return;
    const fields = decoded.fields;

    // Correlate on the command id AND the answering vehicle. On a multi-vehicle
    // connection every peer's COMMAND_ACK arrives on the same subscription, so
    // matching command alone lets one vehicle's ack settle another's
    // transaction. The ack's source (decoded.sysid/compid) is the vehicle we
    // addressed; a broadcast target (0) accepts any source in that dimension.
    if (fields.command !== this._commandId) return;
    if (!this._matchesSource(decoded)) return;

    const result = fields.result;

    if (result === MAV_RESULT.IN_PROGRESS) {
      // Re-arm the timeout: the vehicle is still working.
      this._arm();
      return;
    }

    if (result === MAV_RESULT.TEMPORARILY_REJECTED && !this._noAutoRetry) {
      // Back off and retry if we have retries left.
      if (this._retries < this._maxRetries) {
        this._clearTimeout();
        this._retries += 1;
        this._confirmation += 1;
        this._retryHandle = setTimeout(() => {
          this._arm();
          this._sendFn(this._confirmation);
        }, this._retryIntervalMs);
        return;
      }
      // Out of retries — fall through to terminal failure.
    }

    if (TERMINAL_RESULTS.has(result)) {
      const resultName = RESULT_NAME[result] || String(result);
      this._settle({
        result: SUCCESS_RESULTS.has(result) ? 'accepted' : resultName,
        resultCode: result,
        confirmedBy: 'ack',
        retries: this._retries,
        elapsed: this._now() - this._startMs,
        detail: result === MAV_RESULT.NOT_IN_CONTROL
          ? 'another GCS holds authority'
          : null,
      });
    }
  }

  /**
   * Called when the wait timeout fires. Unsubscribes and resolves with a
   * timeout marker — the caller decides what to do next (check peer table etc).
   */
  _onTimeout() {
    if (this._settled) return;
    this._settle({
      result: 'timeout',
      resultCode: null,
      confirmedBy: 'none',
      retries: this._retries,
      elapsed: this._now() - this._startMs,
      detail: 'no COMMAND_ACK received within timeout',
    });
  }

  /**
   * Resolve the promise and clean up.
   *
   * @param {AckResult} outcome
   */
  _settle(outcome) {
    if (this._settled) return;
    this._settled = true;
    this._cleanup();
    this._resolve(outcome);
  }

  _clearTimeout() {
    if (this._timeoutHandle !== null) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  _clearRetry() {
    if (this._retryHandle !== null) {
      clearTimeout(this._retryHandle);
      this._retryHandle = null;
    }
  }

  _cleanup() {
    this._clearTimeout();
    this._clearRetry();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  /**
   * Cancel and clean up without resolving (called on node close mid-flight).
   */
  cancel() {
    if (this._settled) return;
    this._settled = true;
    this._cleanup();
    if (this._resolve) {
      this._resolve({
        result: 'cancelled',
        resultCode: MAV_RESULT.CANCELLED,
        confirmedBy: 'none',
        retries: this._retries,
        elapsed: this._now() - this._startMs,
        detail: 'node closed during transaction',
      });
    }
  }
}

module.exports = { AckWaiter, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES, DEFAULT_RETRY_INTERVAL_MS };
