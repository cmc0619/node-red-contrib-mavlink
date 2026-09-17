'use strict';

const { Transfer } = require('../delivery/transfer');
const { buildRequestEnd } = require('./items');

/**
 * Bounded waiter for the addressless LOG_ENTRY/LOG_DATA replies. The
 * concrete list and download machines own their protocol state and tell this
 * skeleton what the next retry request should be (`_retryStep`); every
 * settle, whatever the outcome, sends LOG_REQUEST_END once so the vehicle
 * stops streaming.
 */
class LogTransfer extends Transfer {
  constructor(opts) {
    super(opts);
    this._ended = false;
  }

  /** Reset the inactivity window after a new expected reply arrives. */
  _noteProgress() {
    if (this._settled) return;
    this._stepRetries = 0;
    this._arm();
  }

  /**
   * A retry re-asks for what is still missing, which the concrete machine
   * recomputes; a retry with no next request to compute is the end of what
   * this machine can do and settles as the stall it is.
   */
  _resend() {
    const next = this._retryStep();
    if (this._settled) return;
    if (!next) {
      this._onStepExhausted();
      return;
    }
    this._stepLabel = next.label;
    this._stepSend = () => this._send(next.message);
    this._arm();
    this._sendStep();
  }

  _onStepExhausted() {
    this._abort(`stalled at ${this._stepLabel} after ${this._stepRetries} retries`);
  }

  /** @param {Error} err */
  _onReplyError(err) {
    this._abort(`log response failed: ${err.message}`);
  }

  /** @param {object} outcome */
  _settle(outcome) {
    if (this._settled) return;
    const endError = this._sendEnd();
    super._settle(endError ? { ...outcome, endError } : outcome);
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
}

module.exports = { LogTransfer };
