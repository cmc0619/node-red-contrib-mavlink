'use strict';

/**
 * COMMAND_ACK waiting logic (DESIGN.md §9 "Three kinds of confirmation",
 * "The vehicle answers can you do this right now", "A missing ack is not
 * a failure").
 *
 * AckWaiter subscribes to COMMAND_ACK on a connection, matches by (commandId,
 * source sysid/compid), and handles:
 *   - IN_PROGRESS (5): keep waiting for a terminal result, up to an aggregate
 *     ceiling — unbounded re-arms would let periodic IN_PROGRESS extend the
 *     deadline forever (#248)
 *   - TEMPORARILY_REJECTED (1): back off and retry (where noAutoRetry is false)
 *   - ACCEPTED (0): terminal success
 *   - everything else: terminal failure
 *   - timeout: settle 'timeout' so the caller runs the §9 classification
 *     (peer-table check → unconfirmed)
 *
 * The confirmation byte is incremented on each retry re-transmission (MAVLink
 * spec: 0 = first transmission, 1–255 = confirmation transmissions). Carriers
 * without a confirmation byte (COMMAND_INT) ignore the counter in their sendFn
 * and re-send as-is.
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
/** IN_PROGRESS may extend the total wait to at most this multiple of timeoutMs. */
const DEFAULT_IN_PROGRESS_CEILING = 6;

/**
 * @typedef {object} AckResult
 * @property {string}  result        - result name ('accepted', 'failed', 'timeout', ...)
 * @property {number|null} resultCode - MAV_RESULT numeric value; null on timeout
 * @property {'ack'|'none'} confirmedBy
 * @property {number}  retries       - total re-transmissions beyond the first
 *   send (TEMPORARILY_REJECTED back-offs); equals the final confirmation byte
 *   on the LONG carrier
 * @property {number}  elapsed       - ms from first send to terminal
 * @property {string|null} detail    - extra human-readable context
 * @property {number|null} resultParam2 - the ack's result_param2 (MAVLink 2
 *   extension, command-specific — often the reason for a denial). An ack
 *   always supplies a number: MAVLink 2 truncation makes an omitted extension
 *   byte-identical to an explicit zero, so both decode as 0 (measured, §14).
 *   null only on a settle without a *terminal* ack — a genuine absence, and
 *   the state an IN_PROGRESS-then-timeout run reports (§9)
 */

class AckWaiter {
  /**
   * @param {object} opts
   * @param {(filter: object, handler: Function) => (() => void)} opts.subscribe
   *   Connection subscription function; returns an unsubscribe handle.
   * @param {(confirmation: number) => void} opts.sendFn
   *   Called with the confirmation counter to (re-)send the COMMAND_LONG.
   * @param {number}  opts.commandId   - MAV_CMD value being waited on
   * @param {number}  opts.targetSystem
   * @param {number}  opts.targetComponent
   * @param {number}  [opts.timeoutMs]
   * @param {number}  [opts.maxRetries]
   * @param {number}  [opts.retryIntervalMs]
   * @param {number}  [opts.inProgressCeiling]  IN_PROGRESS re-arms never extend
   *   the wait past start + timeoutMs × this (default
   *   {@link DEFAULT_IN_PROGRESS_CEILING})
   * @param {(progress: number|null, resultParam2: number) => void}
   *   [opts.onInProgress]  called on each IN_PROGRESS ack, before the re-arm.
   *   `progress` is the 0–100 percentage, null only for the spec's 255
   *   "unknown" sentinel — an omitted extension decodes as 0 (§14)
   * @param {boolean} [opts.noAutoRetry]  when true, TEMPORARILY_REJECTED is
   *   terminal — §9: commands that restart or toggle never auto-retry
   * @param {{sysid: number, compid: number}} [opts.sourceIds]  our own source
   *   identity; when set, an ack explicitly addressed to a *different* GCS
   *   (MAVLink 2 target_system/target_component extension fields) is ignored
   * @param {() => number} [opts.now]  clock source (ms)
   */
  constructor(opts) {
    this._subscribe = opts.subscribe;
    this._sendFn = opts.sendFn;
    this._commandId = opts.commandId;
    this._targetSystem = opts.targetSystem;
    this._targetComponent = opts.targetComponent;
    this._sourceIds = opts.sourceIds || null;
    this._timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this._maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    this._retryIntervalMs =
      opts.retryIntervalMs !== undefined ? opts.retryIntervalMs : DEFAULT_RETRY_INTERVAL_MS;
    this._inProgressCeiling =
      opts.inProgressCeiling !== undefined ? opts.inProgressCeiling : DEFAULT_IN_PROGRESS_CEILING;
    this._onInProgress = opts.onInProgress || null;
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

      // trustedOnly: a frame explicitly marked untrusted — accept-invalid
      // admission, the unsigned allowlist — must never settle a transaction;
      // plain unsigned links carry no mark and are unaffected (§7 trust
      // ruling #264). One filter site covers every AckWaiter caller.
      this._unsubscribe = this._subscribe(
        { message: 'COMMAND_ACK', trustedOnly: true },
        (decoded) => this._onAck(decoded)
      );

      this._arm();
      try {
        this._sendFn(this._confirmation);
      } catch (err) {
        // Connection.send throws by design (queue overflow, disabled link,
        // identity resolution on a dead link). Rejecting is right, but the
        // executor throw alone would leave the armed timeout and subscription
        // running for a transaction that already failed — and the caller's
        // finally has dropped its cancel handle by then (Codex, #237).
        this._settled = true;
        this._cleanup();
        throw err;
      }
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
    if (this._targetSystem !== undefined && this._targetSystem !== 0) {
      if (decoded.sysid !== undefined && decoded.sysid !== this._targetSystem) return false;
    }
    if (this._targetComponent !== undefined && this._targetComponent !== 0) {
      if (decoded.compid !== undefined && decoded.compid !== this._targetComponent) return false;
    }
    return true;
  }

  /**
   * Arm the ack-window timeout. Called after every send.
   *
   * @param {number} [ms]  window length; defaults to the configured timeout
   */
  _arm(ms = this._timeoutMs) {
    this._clearTimeout();
    this._timeoutHandle = setTimeout(() => this._onTimeout(), ms);
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
    if (!ackAddressedTo(fields, this._sourceIds)) return;

    const result = fields.result;

    if (result === MAV_RESULT.IN_PROGRESS) {
      // A takeoff answers IN_PROGRESS repeatedly over seconds (§9): report the
      // vehicle's own progress before the re-arm, so a caller's badge can move
      // while the wait does not.
      if (this._onInProgress) {
        // 255 is the spec's "unknown" sentinel, not a percentage.
        const progress = fields.progress === 255 ? null : fields.progress;
        this._onInProgress(progress, fields.result_param2);
      }
      // Re-arm the timeout — the vehicle is still working — but never past the
      // aggregate ceiling (start + timeoutMs × inProgressCeiling): unbounded
      // re-arms let periodic IN_PROGRESS extend the deadline forever (#248).
      // At or past the ceiling the currently armed window is left to expire.
      const remaining =
        this._startMs + this._timeoutMs * this._inProgressCeiling - this._now();
      if (remaining > 0) this._arm(Math.min(this._timeoutMs, remaining));
      return;
    }

    if (result === MAV_RESULT.TEMPORARILY_REJECTED && !this._noAutoRetry) {
      // Back off and retry if we have retries left.
      if (this._retries < this._maxRetries) {
        // One pending retry at a time: vehicles re-ack on lossy links, and a
        // duplicate rejection is already answered by the retry in flight —
        // scheduling another would orphan its timer past _clearRetry's reach.
        if (this._retryHandle !== null) return;
        this._clearTimeout();
        this._retries += 1;
        this._confirmation += 1;
        this._retryHandle = setTimeout(() => {
          this._retryHandle = null;
          // Timer context: nothing above this catches. sendFn reaches
          // Connection.send, which throws by design — QueueOverflowError at the
          // Control band cap, or identity resolution failing on a dead link —
          // and a throw escaping here is an uncaughtException, not a failed
          // command. Settle the transaction instead, on exactly the saturated
          // or dropped link where the retry is most likely to be the one that
          // throws. The initial send is inside the start() executor, so it
          // rejects rather than escaping.
          this._arm();
          try {
            this._sendFn(this._confirmation);
          } catch (err) {
            this._settle({
              result: 'send failed',
              resultCode: null,
              confirmedBy: 'none',
              retries: this._retries,
              elapsed: this._now() - this._startMs,
              resultParam2: null,
              detail: `retry send failed: ${err && err.message ? err.message : String(err)}`,
            });
          }
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
        resultParam2: fields.result_param2,
        detail: result === MAV_RESULT.NOT_IN_CONTROL
          ? 'another GCS holds authority'
          : null,
      });
    }
  }

  /**
   * Called when the ack window closes. Resolves with the timeout marker — the
   * caller decides what to do next (check peer table etc).
   */
  _onTimeout() {
    if (this._settled) return;
    this._settle({
      result: 'timeout',
      resultCode: null,
      confirmedBy: 'none',
      retries: this._retries,
      elapsed: this._now() - this._startMs,
      // No terminal ack, so no terminal detail: `resultParam2` carries the
      // *terminal* ack's field, and an IN_PROGRESS ack's copy is already
      // delivered live through onInProgress. Promoting it here would report a
      // decoded 0 — the omitted-extension value (§14) — as if the vehicle had
      // stated it (Codex, declined).
      resultParam2: null,
      detail: 'no terminal COMMAND_ACK received within timeout',
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
        resultParam2: null,
        detail: 'node closed during transaction',
      });
    }
  }
}

/**
 * AckWaiter `sendFn` for a pre-built carrier message. Only the LONG carrier has
 * a confirmation byte, and the encoder's contract above stamps the retry
 * counter into it on every (re-)send; COMMAND_INT declares no such field and
 * must not grow one on retries (§9), so it rides as built. One owner for the
 * ternary every acked pre-built send needs (mavlink-move, mavlink-payload).
 *
 * @param {{send: Function}} connection  Connection node
 * @param {{name: string, fields: object}} message  built carrier message
 * @param {object} sendOptions  Connection.send options (band/target/identityId)
 * @returns {(confirmation: number) => void}
 */
function sendFnFor(connection, message, sendOptions) {
  return (confirmation) => connection.send(
    message.name === 'COMMAND_LONG'
      ? { ...message, fields: { ...message.fields, confirmation } }
      : message,
    sendOptions
  );
}

/**
 * At-most-one-in-flight slot for a cancellable transaction (an {@link
 * AckWaiter} or a completion wait). Owns the cancel-previous boilerplate every
 * acked node repeats: a new input cancels the slot before starting, the run
 * assigns `slot.active`, its finally calls `release`, and close calls
 * `cancel` so a redeploy settles the wait as 'cancelled'.
 *
 * @returns {{active: ?{cancel: Function}, cancel: Function,
 *   release: function(object): void}}
 */
function cancelSlot() {
  return {
    active: null,
    cancel() {
      if (!this.active) return;
      this.active.cancel();
      this.active = null;
    },
    // Guarded on identity: a run must not clear a newer run's handle.
    release(entry) {
      if (this.active === entry) this.active = null;
    },
  };
}

/**
 * Whether an ack is addressed to this station. MAVLink 2 COMMAND_ACK carries
 * target_system/target_component extension fields naming the GCS the ack
 * answers; on a shared link two stations issuing the same MAV_CMD to the same
 * vehicle would otherwise settle each other's waits with the wrong result.
 * Only an ack *explicitly addressed elsewhere* is rejected: absent fields
 * (MAVLink 1) or 0 mean unaddressed and pass, and a null `sourceIds` (the
 * sending identity could not resolve) leaves the gate off. One gate, shared
 * by AckWaiter and Fan-out's broadcast confirm (§9/§10).
 *
 * @param {object} fields  decoded COMMAND_ACK fields
 * @param {{sysid: number, compid: number}|null} sourceIds  our own source ids
 * @returns {boolean}
 */
function ackAddressedTo(fields, sourceIds) {
  if (!sourceIds) return true;
  if (
    fields.target_system !== undefined &&
    Number(fields.target_system) !== 0 &&
    Number(fields.target_system) !== Number(sourceIds.sysid)
  ) {
    return false;
  }
  if (
    fields.target_component !== undefined &&
    Number(fields.target_component) !== 0 &&
    Number(fields.target_component) !== Number(sourceIds.compid)
  ) {
    return false;
  }
  return true;
}

module.exports = {
  AckWaiter,
  ackAddressedTo,
  sendFnFor,
  cancelSlot,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_INTERVAL_MS,
};
