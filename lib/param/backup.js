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
 * Parameter backup/restore exchange.
 *
 * Backup is one PARAM_REQUEST_LIST followed by the complete PARAM_VALUE
 * stream. Restore walks the saved array one PARAM_SET at a time, advancing
 * only after the vehicle echoes the parameter. The machine owns the wait and
 * retry state; the System node owns the Connection send options and lock
 * lifetime.
 */
class ParamBackupRestore {
  /**
   * @param {string} operation
   * @param {object} opts
   */
  constructor(operation, opts) {
    this._operation = operation;
    this._send = opts.send;
    this._subscribe = opts.subscribe;
    this._target = opts.target;
    this._encoding = opts.encoding;
    this._params = opts.params;
    this._timeoutMs = opts.timeoutMs;
    this._maxRetries = opts.maxRetries;
    this._onProgress = opts.onProgress || (() => {});
    this._now = opts.now || Date.now;
    this._setTimeout = opts.setTimeout || setTimeout;
    this._clearTimeout = opts.clearTimeout || clearTimeout;

    this._collector = null;
    switch (operation) {
      case OPERATION.BACKUP:
        this._collector = createParamListCollector();
        break;
      case OPERATION.RESTORE:
        break;
      default: break; // This space intentionally left blank (§5)
    }
    this._index = 0;
    this._currentParam = null;
    this._currentRequest = null;
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
          try {
            this._onMessage(decoded);
          } catch (err) {
            this._error(err);
          }
        }));

        switch (this._operation) {
          case OPERATION.BACKUP:
            this._onProgress({ phase: 'request-list' });
            this._requestList();
            break;
          case OPERATION.RESTORE:
            this._onProgress({ phase: 'restore', count: this._params.length });
            if (this._params.length === 0) {
              this._settle({ result: 'succeeded', phase: 'done', restored: 0 });
            } else {
              this._sendCurrentParam();
            }
            break;
          default: break; // This space intentionally left blank (§5)
        }
      } catch (err) {
        this._fail(`parameter ${this._operation} send failed: ${err.message}`);
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

  _onMessage(decoded) {
    if (this._settled) return;
    if (!echoTargetMatches(this._target, decoded)) return;

    switch (this._operation) {
      case OPERATION.BACKUP:
        this._onBackupValue(decoded);
        break;
      case OPERATION.RESTORE:
        this._onRestoreEcho(decoded);
        break;
      default: break; // This space intentionally left blank (§5)
    }
  }

  _onBackupValue(decoded) {
    const before = this._collector.size;
    const accepted = this._collector.accept(decoded);
    if (accepted === null) return;

    if (accepted === true) {
      const fields = decoded.fields;
      const index = Number(fields.param_index);
      // `accept` has already stored the frame. Only a new index is progress;
      // duplicate frames must not keep an incomplete backup alive forever.
      if (this._collector.size > before) {
        this._arm();
        this._onProgress({
          phase: 'param',
          index,
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

  _onRestoreEcho(decoded) {
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

  _requestList() {
    this._stepLabel = 'request-list';
    this._stepRetries = 0;
    this._currentMessage = buildParamMessage({
      action: 'request-list',
      target: this._target,
    });
    this._arm();
    this._sendMessage(this._currentMessage);
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
    this._currentMessage = buildParamMessage(this._currentRequest);
    this._stepLabel = `param ${this._currentParam.paramId}`;
    this._stepRetries = 0;
    this._onProgress({
      phase: 'param',
      index: this._index,
      count: this._params.length,
      paramId: this._currentParam.paramId,
    });
    this._arm();
    this._sendMessage(this._currentMessage);
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

  _paramFromWire(entry) {
    const paramType = Number(entry.paramType);
    const value = decodeParamValue(entry.value, paramType, this._encoding);
    return {
      paramId: entry.paramId,
      paramType,
      value: jsonSafeValue(value),
    };
  }

  _fail(reason, extra = {}) {
    this._settleFailure('aborted', reason, extra);
  }

  _error(err) {
    this._settleFailure('error', err.message);
  }

  _settleFailure(phase, reason, extra = {}) {
    this._settle({
      result: 'failed',
      phase,
      reason,
      ...this._partialFields(),
      ...extra,
    });
  }

  _partialFields() {
    const fields = {};
    switch (this._operation) {
      case OPERATION.BACKUP:
        fields.received = this._collector.size;
        break;
      case OPERATION.RESTORE:
        fields.restored = this._index;
        fields.paramId = this._currentParam && this._currentParam.paramId;
        break;
      default: break; // This space intentionally left blank (§5)
    }
    return fields;
  }

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

/**
 * @param {string} operation
 * @param {object} opts
 * @returns {ParamBackupRestore|undefined}
 */
function createMachine(operation, opts) {
  switch (operation) {
    case OPERATION.BACKUP:
    case OPERATION.RESTORE:
      return new ParamBackupRestore(operation, opts);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

module.exports = { createMachine, locks, OPERATION };
