'use strict';

/**
 * Shared request/reply transfer skeleton (DESIGN.md §9 "Retry per item, with
 * a ceiling"). One owner for what the log, parameter, mission and FTP
 * machines each spelled out by hand: the settle-once promise, the per-target
 * subscription filter, the step timeout with its retry budget, and the
 * teardown.
 *
 * A concrete machine supplies:
 *   - `_messages()`          — the message names it handles.
 *   - `_begin()`             — send the opening message, through `_step`.
 *   - `_onMessage(decoded)`  — react to one inbound reply.
 *
 * and overrides the narrow hooks below only where its protocol differs:
 *   - `_acceptMessage(decoded)` — attribution gate beyond the source filter.
 *   - `_resend()`               — what a retry sends; default the step again.
 *   - `_onStepExhausted()`      — the retry ceiling is spent; default abort.
 *   - `_onReplyError(err)`      — `_onMessage` threw; default abort.
 *   - `_abort(reason)`, `_settle(outcome)`, `cancel()` — outcome shaping.
 *
 * Every collaborator (send, subscribe, clock, timers) is injected, so the
 * machines run identically against a live Connection and a scripted stub
 * with no real sockets or wall-clock waits (§13 "fixtures alone").
 */
class Transfer {
  /**
   * @param {object} opts
   * @param {(message:object)=>void} opts.send  enqueue an outbound message;
   *   the caller has already bound band and target
   * @param {(filter:object,handler:Function)=>Function} opts.subscribe
   *   connection subscription; returns an unsubscribe handle
   * @param {{sysid:number,compid:number}} opts.target
   * @param {number} opts.timeoutMs  per-step timeout before a retry
   * @param {number} opts.maxRetries  per-step retry ceiling
   * @param {(update:object)=>void} [opts.onProgress]  phase updates, surfaced
   *   by the node as status records (§9 "Progress is status, not a port")
   * @param {()=>number} [opts.now]
   * @param {typeof setTimeout} [opts.setTimeout]
   * @param {typeof clearTimeout} [opts.clearTimeout]
   */
  constructor(opts) {
    this._send = opts.send;
    this._subscribe = opts.subscribe;
    this._target = opts.target;
    this._timeoutMs = opts.timeoutMs;
    this._maxRetries = opts.maxRetries;
    this._onProgress = opts.onProgress || (() => {});
    this._now = opts.now || Date.now;
    this._setTimeout = opts.setTimeout || setTimeout;
    this._clearTimeout = opts.clearTimeout || clearTimeout;

    this._unsubs = [];
    this._timer = null;
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
   * One subscription per handled name: the filter layer matches a single
   * `message`, and an unfiltered subscription would deliver (and deep-copy)
   * the target's whole telemetry stream into a machine that discards
   * everything but its `_messages()`. Source sysid/compid narrow the filter
   * only when the target names a real one: 0 is a destination address
   * (broadcast), never a reply's source, so filtering source-equals-0 could
   * never match any real vehicle's answer. trustedOnly: an explicitly
   * untrusted frame must never step a transfer (§7 trust ruling).
   *
   * @returns {Promise<object>}
   */
  start() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._startMs = this._now();
      const handler = (decoded) => {
        if (this._settled || !this._acceptMessage(decoded)) return;
        try {
          this._onMessage(decoded);
        } catch (err) {
          this._onReplyError(err);
        }
      };
      try {
        this._unsubs = this._messages().map((name) => this._subscribe({
          message: name,
          ...(this._target.sysid !== 0 ? { sysid: this._target.sysid } : {}),
          ...(this._target.compid !== 0 ? { compid: this._target.compid } : {}),
          trustedOnly: true,
        }, handler));
        this._begin();
      } catch (err) {
        this._abort(`transfer start failed: ${err.message}`);
      }
    });
  }

  /**
   * Attribution gate for an inbound reply, beyond the source filter. Default:
   * every frame the filter passed.
   *
   * @returns {boolean}
   */
  _acceptMessage() {
    return true;
  }

  /**
   * Enter a step: send `message`, remember how to resend it, reset the retry
   * counter, and arm the timeout. Advancing to a new step clears the previous
   * step's retries, so the ceiling is per item (§9).
   *
   * @param {string} label  used in the abort reason
   * @param {object} message
   */
  _step(label, message) {
    this._stepLabel = label;
    this._stepRetries = 0;
    this._stepSend = () => this._send(message);
    this._arm();
    this._sendStep();
  }

  /**
   * Send the current step. connection.send throws on a saturated queue or a
   * dead link, and from timer context an escape crashes the process rather
   * than failing the transfer, so the throw settles the machine here.
   */
  _sendStep() {
    try {
      this._stepSend();
    } catch (err) {
      this._abort(`${this._stepLabel} send failed: ${err.message}`);
    }
  }

  /** (Re)arm the single active step timeout. */
  _arm() {
    this._clearTimer();
    this._timer = this._setTimeout(() => this._onTimeout(), this._timeoutMs);
  }

  /**
   * A step went unanswered. Resend up to the ceiling; then hand the spent
   * budget to `_onStepExhausted` (abort by default).
   */
  _onTimeout() {
    if (this._settled) return;
    // Timer context: a throw out of a resend or exhaustion override (log
    // recomputes its request, download sends a fallback) would escape the
    // timer and take the runtime with it (§2); it settles the machine instead.
    try {
      if (this._stepRetries < this._maxRetries) {
        this._stepRetries += 1;
        this._progress({ phase: 'retry', step: this._stepLabel, retry: this._stepRetries });
        this._resend();
        return;
      }
      this._onStepExhausted();
    } catch (err) {
      this._abort(`${this._stepLabel} send failed: ${err.message}`);
    }
  }

  /** What a retry sends. Default: the current step again. */
  _resend() {
    this._arm();
    this._sendStep();
  }

  /** The current step burned its retry ceiling. Default: abort naming it. */
  _onStepExhausted() {
    this._abort(`stalled at ${this._stepLabel} after ${this._maxRetries} retries`);
  }

  /**
   * `_onMessage` threw. Default: abort naming the error.
   *
   * @param {Error} err
   */
  _onReplyError(err) {
    this._abort(`reply handling failed: ${err.message}`);
  }

  /** @param {object} update */
  _progress(update) {
    if (this._settled) return;
    this._onProgress(update);
  }

  /** @param {string} reason */
  _abort(reason) {
    this._settle({ result: 'failed', phase: 'aborted', reason });
  }

  /**
   * Resolve the promise once, tearing down the timer and subscriptions.
   *
   * @param {object} outcome
   */
  _settle(outcome) {
    if (this._settled) return;
    this._settled = true;
    this._clearTimer();
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    this._resolve({ elapsed: this._now() - this._startMs, ...outcome });
  }

  /** Cancel a transfer in flight (node close). */
  cancel() {
    this._settle({ result: 'cancelled', phase: 'cancelled', reason: 'transfer cancelled' });
  }

  _clearTimer() {
    if (this._timer !== null) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

module.exports = { Transfer };
