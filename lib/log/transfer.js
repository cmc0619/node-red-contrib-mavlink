'use strict';

const { buildRequestEnd } = require('./items');

/**
 * Common bounded waiter for the addressless LOG_ENTRY/LOG_DATA replies.
 *
 * Log replies have no mission_type and no destination identity to echo. The
 * Connection subscription therefore narrows by the vehicle source and the
 * callback repeats that source gate before a reply can advance the machine.
 * The concrete list and download machines own their protocol state and tell
 * this skeleton what the next retry request should be.
 */
class LogTransfer {
  /**
   * @param {object} opts
   * @param {(message:object)=>void} opts.send
   * @param {(filter:object,handler:Function)=>Function} opts.subscribe
   * @param {{sysid:number,compid:number}} opts.target
   * @param {number} opts.timeoutMs
   * @param {number} opts.maxRetries
   * @param {(update:object)=>void} opts.onProgress
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
    this._onProgress = opts.onProgress;
    this._now = opts.now || Date.now;
    this._setTimeout = opts.setTimeout || setTimeout;
    this._clearTimeout = opts.clearTimeout || clearTimeout;

    this._unsubs = [];
    this._timer = null;
    this._settled = false;
    this._resolve = null;
    this._startMs = 0;
    this._stepLabel = null;
    this._stepRetries = 0;
    this._ended = false;
  }

  /** @returns {Promise<object>} */
  start() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._startMs = this._now();
      const handler = (decoded) => {
        if (this._settled || !this._sourceMatches(decoded)) return;
        try {
          this._onMessage(decoded);
        } catch (err) {
          this._abort(`log response failed: ${err.message}`);
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
        this._abort(`log transfer send failed: ${err.message}`);
      }
    });
  }

  /** @returns {boolean} exact source match; component zero is a wildcard. */
  _sourceMatches(decoded) {
    if (this._target.sysid !== 0 && Number(decoded.sysid) !== Number(this._target.sysid)) {
      return false;
    }
    return this._target.compid === 0
      || Number(decoded.compid) === Number(this._target.compid);
  }

  /**
   * Enter a request step. A concrete retry hook may replace the message with
   * a recomputed missing range while retaining the retry count.
   *
   * @param {string} label
   * @param {object} message
   */
  _step(label, message) {
    this._stepLabel = label;
    this._stepRetries = 0;
    this._arm();
    this._sendStep(message);
  }

  _arm() {
    this._clearTimer();
    this._timer = this._setTimeout(() => this._onTimeout(), this._timeoutMs);
  }

  /** Reset the inactivity window after a new expected reply arrives. */
  _noteProgress() {
    if (this._settled) return;
    this._stepRetries = 0;
    this._arm();
  }

  _sendStep(message) {
    try {
      this._send(message);
    } catch (err) {
      this._abort(`${this._stepLabel} send failed: ${err.message}`);
    }
  }

  _onTimeout() {
    if (this._settled) return;
    if (this._stepRetries < this._maxRetries) {
      this._stepRetries += 1;
      this._onProgress({
        phase: 'retry',
        step: this._stepLabel,
        retry: this._stepRetries,
      });
      const next = this._retryStep();
      if (!next || this._settled) return;
      this._stepLabel = next.label;
      this._arm();
      this._sendStep(next.message);
      return;
    }
    this._abort(`stalled at ${this._stepLabel} after ${this._maxRetries} retries`);
  }

  /** @param {string} reason */
  _abort(reason) {
    this._settle({ result: 'failed', phase: 'aborted', reason });
  }

  /** @param {object} outcome */
  _settle(outcome) {
    if (this._settled) return;
    this._settled = true;
    const endError = this._sendEnd();
    this._clearTimer();
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    const resolved = { elapsed: this._now() - this._startMs, ...outcome };
    if (endError) resolved.endError = endError;
    this._resolve(resolved);
  }

  cancel() {
    this._settle({ result: 'cancelled', phase: 'cancelled', reason: 'transfer cancelled' });
  }

  _sendEnd() {
    if (this._ended) return null;
    this._ended = true;
    try {
      this._send(buildRequestEnd(this._target));
    } catch (err) {
      return `LOG_REQUEST_END send failed: ${err.message}`;
    }
    return null;
  }

  _clearTimer() {
    if (this._timer !== null) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

module.exports = { LogTransfer };
