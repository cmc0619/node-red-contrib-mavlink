'use strict';

/**
 * Base mission transfer state machine (DESIGN.md §9 "Mission protocol"). The
 * three concrete machines — {@link module:lib/mission/download},
 * {@link module:lib/mission/upload}, {@link module:lib/mission/clear} — share
 * one skeleton: subscribe to the target's traffic, drive the conversation in
 * `MISSION_*` messages on the **Bulk** band (§7), retry a stalled step up to a
 * ceiling, abort naming the stalled sequence rather than hanging forever
 * (§9 "Retry per item, with a ceiling"), and bound the whole transfer with an
 * overall deadline the per-step machinery cannot defeat.
 *
 * A subclass implements two hooks:
 *   - `_begin()`  — send the opening message and arm the first step.
 *   - `_onMessage(decoded)` — react to one inbound message.
 *
 * The base owns the promise, the step timeout, the deadline, the retry bookkeeping,
 * subscription teardown, and `mission_type` matching. All collaborators (the
 * connection's `send`/`subscribe`, the clock, and the timers) are injected, so
 * the machines run identically against a live Connection and a scripted stub
 * with no real sockets or wall-clock waits (§13 "fixtures alone").
 */

const {
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TRANSFER_DEADLINE_MS,
  MISSION_TYPE,
} = require('./types');

/** @typedef {{ name: string, fields: object }} DecodedMessage */

/**
 * @typedef {object} TransferOutcome
 * @property {'succeeded'|'failed'|'cancelled'} result
 * @property {string} phase      terminal phase ('done', 'ack', 'aborted', ...)
 * @property {number} missionType
 * @property {number} elapsed    ms from start to settle
 * @property {number} [count]    item count where known
 * @property {object[]} [items]  downloaded items (download only)
 * @property {number} [resultCode]  MAV_MISSION_RESULT on an error ack
 * @property {string} [reason]   human-readable failure detail
 * @property {number} [seq]      stalled sequence on an abort
 */

class MissionTransfer {
  /**
   * @param {object} opts
   * @param {(message: DecodedMessage) => void} opts.send  enqueue an outbound
   *   message; the caller has already bound band (Bulk) and target.
   * @param {(filter: object, handler: Function) => (() => void)} opts.subscribe
   *   connection subscription; returns an unsubscribe handle.
   * @param {{sysid: number, compid: number}} opts.target
   * @param {number} opts.missionType  a `MAV_MISSION_TYPE`
   * @param {(update: object) => void} [opts.onProgress]  phase/count updates,
   *   surfaced by the node as status records on output 1 (§9 "Progress is
   *   status, not a port").
   * @param {number} [opts.timeoutMs]  per-step timeout before a retry
   * @param {number} [opts.maxRetries]  per-step retry ceiling
   * @param {() => number} [opts.now]  clock source (ms)
   * @param {typeof setTimeout} [opts.setTimeout]
   * @param {typeof clearTimeout} [opts.clearTimeout]
   */
  constructor(opts) {
    this._send = opts.send;
    this._subscribe = opts.subscribe;
    this._target = opts.target;
    this._missionType = opts.missionType;
    this._onProgress = opts.onProgress || (() => {});
    this._timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_STEP_TIMEOUT_MS;
    this._maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    this._now = opts.now || Date.now;
    this._setTimeout = opts.setTimeout || setTimeout;
    this._clearTimeout = opts.clearTimeout || clearTimeout;

    this._unsub = null;
    this._timer = null;
    this._deadlineTimer = null;
    this._settled = false;
    this._resolve = null;
    this._startMs = 0;

    // Current-step retry bookkeeping. `_stepSend` re-runs the step on timeout.
    this._stepLabel = null;
    this._stepSend = null;
    this._stepRetries = 0;
  }

  /**
   * Run the transfer to a terminal outcome. Subscribes, then invokes the
   * subclass `_begin()`; a scripted stub may deliver its first reply
   * synchronously inside that call, so the promise resolver is wired first.
   *
   * @returns {Promise<TransferOutcome>}
   */
  start() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._startMs = this._now();
      this._unsub = this._subscribe(
        { sysid: this._target.sysid, compid: this._target.compid },
        (decoded) => {
          if (!this._settled) this._onMessage(decoded);
        }
      );
      // Transfer-level deadline, independent of the per-step ceiling. The
      // ceiling resets on every step advance — and upload's steps are driven
      // by the vehicle, so a peer re-requesting the same sequence forever
      // resets it indefinitely. This timer is the bound that ends that
      // livelock (§9 "A transfer that hangs forever is worse than one that
      // fails").
      this._deadlineTimer = this._setTimeout(
        () =>
          this._abort(
            `transfer deadline (${DEFAULT_TRANSFER_DEADLINE_MS} ms) exceeded at ${this._stepLabel}`,
            this._stalledSeq()
          ),
        DEFAULT_TRANSFER_DEADLINE_MS
      );
      // _step() arms the step timer before its first send, so a throw out of
      // _begin() would leave this machine armed and subscribed while the
      // promise rejected: the caller sees the failure, nothing cancels the
      // machine, and the live timer later re-fires the same throwing send from
      // timer context — a crash, not a leak. Abort settles it, which clears the
      // timer, unsubscribes, and resolves the same failed outcome shape a
      // stalled step produces.
      try {
        this._begin();
      } catch (err) {
        this._abort(
          `${this._stepLabel || 'start'} send failed: ${err && err.message ? err.message : String(err)}`,
          this._stalledSeq()
        );
      }
    });
  }

  /**
   * True when a message's `mission_type` matches the transfer's. An absent
   * field defaults to MISSION (0), matching the wire default — so a legacy peer
   * that omits it is treated as a mission and mismatched for fence/rally (§9
   * "The `mission_type` on every message must match the one requested").
   *
   * @param {object} fields
   * @returns {boolean}
   */
  _typeMatches(fields) {
    const t = fields.mission_type === undefined ? MISSION_TYPE.MISSION : Number(fields.mission_type);
    return t === this._missionType;
  }

  /**
   * Enter a step: send `message`, remember how to resend it, reset the retry
   * counter, and arm the timeout. Advancing to a new step clears the previous
   * step's retries, so the ceiling is per item (§9).
   *
   * @param {string} label  used in the abort reason
   * @param {DecodedMessage} message
   */
  _step(label, message) {
    this._stepLabel = label;
    this._stepRetries = 0;
    this._stepSend = () => this._send(message);
    this._arm();
    this._stepSend();
  }

  /** (Re)arm the single active step timeout. */
  _arm() {
    this._clearTimer();
    this._timer = this._setTimeout(() => this._onTimeout(), this._timeoutMs);
  }

  /**
   * A step went unanswered. Resend up to the ceiling; then abort the whole
   * transfer naming the stalled step (§9 "abort the whole transfer with the
   * sequence number that stalled").
   */
  _onTimeout() {
    if (this._settled) return;
    if (this._stepRetries < this._maxRetries) {
      this._stepRetries += 1;
      this._onProgress({
        phase: 'retry',
        step: this._stepLabel,
        retry: this._stepRetries,
        missionType: this._missionType,
      });
      this._arm();
      // Timer context — see AckWaiter's retry send. connection.send throws on a
      // saturated Bulk queue or a dead link, and an escape here crashes the
      // process rather than failing the transfer.
      try {
        this._stepSend();
      } catch (err) {
        this._abort(
          `${this._stepLabel} send failed: ${err && err.message ? err.message : String(err)}`,
          this._stalledSeq()
        );
      }
      return;
    }
    this._onStepExhausted();
  }

  /**
   * The current step burned its retry ceiling. Default: abort the whole
   * transfer naming the stalled step (§9). Download overrides this once, to
   * fall back from `MISSION_REQUEST_INT` to the legacy `MISSION_REQUEST`
   * against a pre-INT autopilot before giving up.
   */
  _onStepExhausted() {
    this._abort(
      `stalled at ${this._stepLabel} after ${this._maxRetries} retries`,
      this._stalledSeq()
    );
  }

  /**
   * The sequence number a subclass considers stalled, for the abort record.
   * Overridden where a numeric sequence exists.
   *
   * @returns {number|undefined}
   */
  _stalledSeq() {
    return undefined;
  }

  /**
   * Abort with a failure outcome. Subclasses never turn an abort into a
   * different operation — a failed upload must not degrade into a clear (§9).
   *
   * @param {string} reason
   * @param {number} [seq]
   */
  _abort(reason, seq) {
    this._settle({ result: 'failed', phase: 'aborted', reason, seq });
  }

  /**
   * Resolve the promise once, tearing down the timer and subscription.
   *
   * @param {Partial<TransferOutcome>} outcome
   */
  _settle(outcome) {
    if (this._settled) return;
    this._settled = true;
    this._clearTimer();
    if (this._deadlineTimer !== null) {
      this._clearTimeout(this._deadlineTimer);
      this._deadlineTimer = null;
    }
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    this._resolve({
      missionType: this._missionType,
      elapsed: this._now() - this._startMs,
      ...outcome,
    });
  }

  /**
   * Cancel a transfer in flight (node close). Resolves with a cancelled
   * outcome so the awaiting node can clean up.
   */
  cancel() {
    if (this._settled) return;
    this._settle({ result: 'cancelled', phase: 'cancelled', reason: 'transfer cancelled' });
  }

  _clearTimer() {
    if (this._timer !== null) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * @abstract Send the opening message and arm the first step.
   */
  _begin() {
    throw new Error('MissionTransfer._begin is abstract');
  }

  /**
   * @abstract React to one inbound decoded message.
   * @param {DecodedMessage} _decoded
   */
  _onMessage(_decoded) {
    throw new Error('MissionTransfer._onMessage is abstract');
  }
}

module.exports = { MissionTransfer };
