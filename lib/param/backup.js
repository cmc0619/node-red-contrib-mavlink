'use strict';

const {
  buildParamMessage,
  createParamListCollector,
  matchesParamEcho,
  matchesParamReadReply,
  decodeParamValue,
} = require('./index');
const { LockRegistry } = require('../delivery/lock');
const { Transfer } = require('../delivery/transfer');

const locks = new LockRegistry();

/**
 * The parameter exchanges — list, read, set — on the shared transfer skeleton
 * (lib/delivery/transfer.js): one PARAM_VALUE subscription scoped to the
 * addressed vehicle, values decoded with the resolved encoding, and every
 * failure or cancel carrying how much of the work survived
 * (`_partialFields`). PARAM_* has no protocol cancellation frame, so a cancel
 * only tears down the local wait. The System node's bundle and the Param
 * node both run on these.
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

  /**
   * A PARAM_VALUE as the flow sees it: the value decoded with the resolved
   * encoding, so a PX4 INT32 of 1 reads 1, not the 1.4e-45 its bits make as a
   * float, and the position in the vehicle's table a read by index names.
   *
   * @param {{paramId: string, paramType: number, value: number, index: number}} entry
   * @returns {{paramId: string, paramType: number, value: *, index: number}}
   */
  _paramFromWire(entry) {
    const paramType = Number(entry.paramType);
    const value = decodeParamValue(entry.value, paramType, this._encoding);
    return {
      paramId: entry.paramId,
      paramType,
      value: jsonSafeValue(value),
      index: entry.index,
    };
  }
}

/**
 * One PARAM_REQUEST_LIST followed by the complete PARAM_VALUE stream. The
 * collector owns completion; a retry re-requests the whole list into the same
 * collector, so already-received indices are not lost.
 */
class ParamBackup extends ParamTransfer {
  /**
   * @param {object} opts  ParamTransfer options plus:
   * @param {(text: string) => void} [opts.warn]  out-of-range index warning
   */
  constructor(opts) {
    super(opts);
    this._collector = createParamListCollector({ warn: opts.warn });
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
    const accepted = this._collector.accept(decoded);
    if (accepted === null) return;

    if (accepted === true) {
      /**
       * Every in-range frame re-arms the step timer, a duplicate included. A
       * retry's PARAM_REQUEST_LIST restarts ArduPilot's stream at index 0, and
       * on a link the vehicle paces itself the index still missing arrives
       * only after the ones already held have streamed again (verify R14).
       * The vehicle streams once per request, so the wait stays bounded by
       * maxRetries + 1 streams.
       */
      this._arm();
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

  _partialFields() {
    return { received: this._collector.size };
  }
}

/**
 * One PARAM_REQUEST_READ, answered by the PARAM_VALUE that names the same
 * index or id, and re-sent on silence up to the retry ceiling like any step.
 */
class ParamRead extends ParamTransfer {
  /**
   * @param {object} opts  ParamTransfer options plus:
   * @param {object} opts.request  the read request buildParamMessage builds
   */
  constructor(opts) {
    super(opts);
    this._request = opts.request;
  }

  _begin() {
    this._step('read', buildParamMessage(this._request));
  }

  /** @param {object} decoded */
  _onMessage(decoded) {
    if (!matchesParamReadReply(this._request, decoded)) return;
    const fields = decoded.fields;
    this._settle({
      result: 'succeeded',
      phase: 'done',
      param: this._paramFromWire({
        paramId: fields.param_id,
        paramType: fields.param_type,
        value: fields.param_value,
        index: Number(fields.param_index),
      }),
    });
  }

  _partialFields() {
    return {};
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

    this._clearTimer();
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

  /**
   * Every send of the current PARAM_SET went unechoed. Silence cannot say
   * whether the vehicle took the value, so the set is `unconfirmed`.
   */
  _onStepExhausted() {
    this._settle({
      result: 'unconfirmed',
      phase: 'aborted',
      reason: `stalled at ${this._stepLabel} after ${this._maxRetries} retries`,
      ...this._partialFields(),
    });
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

module.exports = { ParamBackup, ParamRestore, ParamRead, locks, jsonSafeValue };
