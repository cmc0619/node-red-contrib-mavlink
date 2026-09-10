'use strict';

const {
  buildParamMessage,
  createParamListCollector,
  matchesParamEcho,
  echoTargetMatches,
  decodeParamValue,
} = require('./index');
const { LockRegistry } = require('../delivery/lock');

const OPERATION = { BACKUP: 'backup', RESTORE: 'restore' };
const locks = new LockRegistry();

/**
 * Shared plumbing for the two parameter bundle exchanges, in the shape
 * `lib/log/transfer.js` and `lib/mission/transfer.js` already use: the base
 * owns the promise, the PARAM_VALUE subscription, the step timeout, the retry
 * bookkeeping and the settle path, and each concrete machine owns its own
 * protocol.
 *
 * A concrete machine supplies:
 *   - `_begin()` — send the opening message and arm the first step.
 *   - `_onMessage(decoded)` — react to one PARAM_VALUE already scoped to the
 *     addressed vehicle.
 *   - `_partialFields()` — how much of its own work survived a failure.
 */
class ParamTransfer {
  /**
   * @param {object} opts
   * @param {(message:object)=>void} opts.send
   * @param {(filter:object,handler:Function)=>Function} opts.subscribe
   * @param {{sysid:number,compid:number}} opts.target
   * @param {string} opts.encoding
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
    this._encoding = opts.encoding;
    this._timeoutMs = opts.timeoutMs;
    this._maxRetries = opts.maxRetries;
    this._onProgress = opts.onProgress;
    this._now = opts.now || Date.now;
    this._setTimeout = opts.setTimeout || setTimeout;
    this._clearTimeout = opts.clearTimeout || clearTimeout;

    this._currentMessage = null;
    this._stepLabel = null;
    this._stepRetries = 0;
    this._timer = null;
    this._unsubs = [];
    this._settled = false;
    this._resolve = null;
    this._startMs = 0;
  }

  /**
   * Subscribe before sending the first protocol message.
   *
   * @returns {Promise<object>}
   */
  start() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._startMs = this._now();
      try {
        const filter = {
          message: 'PARAM_VALUE',
          ...(this._target.sysid !== 0 ? { sysid: this._target.sysid } : {}),
          ...(this._target.compid !== 0 ? { compid: this._target.compid } : {}),
          trustedOnly: true,
        };
        this._unsubs.push(this._subscribe(filter, (decoded) => {
          if (this._settled || !echoTargetMatches(this._target, decoded)) return;
          try {
            this._onMessage(decoded);
          } catch (err) {
            this._error(err);
          }
        }));
        this._begin();
      } catch (err) {
        this._fail(`parameter transfer send failed: ${err.message}`);
      }
    });
  }

  /**
   * Cancel an active exchange. PARAM_* has no protocol cancellation frame, so
   * cancellation only tears down the local wait and preserves completed data.
   */
  cancel() {
    if (this._settled) return;
    this._settle({
      result: 'cancelled',
      phase: 'cancelled',
      reason: 'parameter transfer cancelled',
      ...this._partialFields(),
    });
  }

  /** Enter a request step, resetting the retry count and arming the timer. */
  _step(label, message) {
    this._stepLabel = label;
    this._stepRetries = 0;
    this._currentMessage = message;
    this._arm();
    this._sendMessage(message);
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
      this._arm();
      this._sendMessage(this._currentMessage);
      return;
    }
    this._fail(`stalled at ${this._stepLabel} after ${this._maxRetries} retries`);
  }

  _sendMessage(message) {
    try {
      this._send(message);
    } catch (err) {
      this._fail(`${this._stepLabel} send failed: ${err.message}`);
    }
  }

  /** @param {string} reason */
  _fail(reason) {
    this._settleFailure('aborted', reason);
  }

  /** @param {Error} err */
  _error(err) {
    this._settleFailure('error', err.message);
  }

  _settleFailure(phase, reason) {
    this._settle({
      result: 'failed',
      phase,
      reason,
      ...this._partialFields(),
    });
  }

  /** @param {object} outcome */
  _settle(outcome) {
    if (this._settled) return;
    this._settled = true;
    this._clearTimer();
    for (const unsubscribe of this._unsubs) unsubscribe();
    this._unsubs = [];
    this._resolve({ elapsed: this._now() - this._startMs, ...outcome });
  }

  _arm() {
    this._clearTimer();
    this._timer = this._setTimeout(() => this._onTimeout(), this._timeoutMs);
  }

  _clearTimer() {
    if (this._timer !== null) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

/**
 * One PARAM_REQUEST_LIST followed by the complete PARAM_VALUE stream. The
 * collector owns completion; a retry re-requests the whole list into the same
 * collector, so already-received indices are not lost.
 */
class ParamBackup extends ParamTransfer {
  constructor(opts) {
    super(opts);
    this._collector = createParamListCollector();
  }

  _begin() {
    this._onProgress({ phase: 'request-list' });
    this._step('request-list', buildParamMessage({
      action: 'request-list',
      target: this._target,
    }));
  }

  /** @param {object} decoded */
  _onMessage(decoded) {
    const before = this._collector.size;
    const accepted = this._collector.accept(decoded);
    if (accepted === null) return;

    if (accepted === true) {
      const fields = decoded.fields;
      // `accept` has already stored the frame. Only a new index is progress;
      // duplicate frames must not keep an incomplete backup alive forever.
      if (this._collector.size > before) {
        this._arm();
        this._onProgress({
          phase: 'param',
          index: Number(fields.param_index),
          count: Number(fields.param_count),
        });
      }
      return;
    }

    const params = accepted.map((entry) => this._paramFromWire(entry));
    this._settle({
      result: 'succeeded',
      phase: 'done',
      count: params.length,
      params,
    });
  }

  _paramFromWire(entry) {
    const paramType = Number(entry.paramType);
    const value = decodeParamValue(entry.value, paramType, this._encoding);
    return {
      paramId: entry.paramId,
      paramType,
      value: jsonSafeValue(value),
    };
  }

  _partialFields() {
    return { received: this._collector.size };
  }
}

/**
 * Walk the saved array one PARAM_SET at a time, advancing only after the
 * vehicle echoes the parameter. A failure reports the confirmed prefix and the
 * parameter it stopped on.
 */
class ParamRestore extends ParamTransfer {
  constructor(opts) {
    super(opts);
    this._params = opts.params;
    this._index = 0;
    this._currentParam = null;
    this._currentRequest = null;
  }

  _begin() {
    this._onProgress({ phase: 'restore', count: this._params.length });
    if (this._params.length === 0) {
      this._settle({ result: 'succeeded', phase: 'done', restored: 0 });
      return;
    }
    this._sendCurrentParam();
  }

  /** @param {object} decoded */
  _onMessage(decoded) {
    if (!this._currentRequest || !matchesParamEcho(this._currentRequest, decoded)) return;

    const completed = this._currentParam;
    this._clearTimer();
    this._onProgress({
      phase: 'param',
      index: this._index,
      count: this._params.length,
      paramId: completed.paramId,
    });
    this._index += 1;

    if (this._index >= this._params.length) {
      this._settle({
        result: 'succeeded',
        phase: 'done',
        restored: this._index,
      });
      return;
    }
    this._sendCurrentParam();
  }

  _sendCurrentParam() {
    if (this._settled) return;
    this._currentParam = this._params[this._index];
    this._currentRequest = {
      action: 'set',
      target: this._target,
      paramId: this._currentParam.paramId,
      paramType: this._currentParam.paramType,
      value: this._currentParam.value,
      encoding: this._encoding,
    };
    this._onProgress({
      phase: 'param',
      index: this._index,
      count: this._params.length,
      paramId: this._currentParam.paramId,
    });
    this._step(`param ${this._currentParam.paramId}`, buildParamMessage(this._currentRequest));
  }

  _partialFields() {
    return { restored: this._index, paramId: this._currentParam?.paramId };
  }
}

/**
 * Keep PARAM_VALUE's nonfinite float values and negative zero through JSON and
 * file nodes. JSON.stringify turns them into null or positive zero, which
 * would change a later numeric PARAM_SET.
 *
 * @param {*} value
 * @returns {*}
 */
function jsonSafeValue(value) {
  if (typeof value !== 'number') return value;
  if (Object.is(value, -0)) return '-0';
  if (!Number.isFinite(value)) return String(value);
  return value;
}

module.exports = { ParamBackup, ParamRestore, locks, OPERATION, jsonSafeValue };
