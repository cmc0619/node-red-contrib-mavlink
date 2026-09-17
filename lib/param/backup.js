'use strict';

const {
  buildParamMessage,
  createParamListCollector,
  matchesParamEcho,
  echoTargetMatches,
  decodeParamValue,
} = require('./index');
const { LockRegistry } = require('../delivery/lock');
const { Transfer } = require('../delivery/transfer');

const OPERATION = { BACKUP: 'backup', RESTORE: 'restore' };
const locks = new LockRegistry();

/**
 * The two parameter bundle exchanges on the shared transfer skeleton
 * (lib/delivery/transfer.js): one PARAM_VALUE subscription, the addressed
 * vehicle's echo gate, and every failure or cancel carrying how much of the
 * work survived (`_partialFields`). PARAM_* has no protocol cancellation
 * frame, so a cancel only tears down the local wait.
 */
class ParamTransfer extends Transfer {
  /**
   * @param {object} opts  Transfer options plus:
   * @param {string} opts.encoding
   */
  constructor(opts) {
    super(opts);
    this._encoding = opts.encoding;
  }

  _messages() { return ['PARAM_VALUE']; }

  _acceptMessage(decoded) {
    return echoTargetMatches(this._target, decoded);
  }

  /** @param {Error} err */
  _onReplyError(err) {
    this._settle({ result: 'failed', phase: 'error', reason: err.message, ...this._partialFields() });
  }

  /** @param {string} reason */
  _abort(reason) {
    this._settle({ result: 'failed', phase: 'aborted', reason, ...this._partialFields() });
  }

  cancel() {
    this._settle({
      result: 'cancelled',
      phase: 'cancelled',
      reason: 'parameter transfer cancelled',
      ...this._partialFields(),
    });
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
