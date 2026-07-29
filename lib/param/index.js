'use strict';

const { paramValueFromWire, paramValueToWire } = require('../codec');

const PARAM_TYPE = {
  MAV_PARAM_TYPE_UINT8: 1,
  MAV_PARAM_TYPE_INT8: 2,
  MAV_PARAM_TYPE_UINT16: 3,
  MAV_PARAM_TYPE_INT16: 4,
  MAV_PARAM_TYPE_UINT32: 5,
  MAV_PARAM_TYPE_INT32: 6,
  MAV_PARAM_TYPE_REAL32: 9,
};

/**
 * How `param_value` (float) carries a typed parameter (DESIGN.md §11).
 * @enum {string}
 */
const PARAM_ENCODING = {
  /** Native bytes bit-cast into the float slot (PX4 / BYTEWISE capability). */
  BYTEWISE: 'bytewise',
  /** Numeric C cast to float (ArduPilot / C_CAST capability). */
  C_CAST: 'c-cast',
};

/** MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE */
const CAP_PARAM_ENCODE_BYTEWISE = 16;
/** MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_C_CAST */
const CAP_PARAM_ENCODE_C_CAST = 131072;

/**
 * Build one Param protocol message. `set` is echo-confirmed by the caller with
 * PARAM_VALUE; MAVLink has no COMMAND_ACK for params.
 *
 * @param {object} input
 * @returns {{name:string, fields: object}}
 */
function buildParamMessage(input) {
  const target = input.target;
  if (input.action === 'request-list') {
    return {
      name: 'PARAM_REQUEST_LIST',
      fields: { target_system: target.sysid, target_component: target.compid },
    };
  }
  if (input.action === 'read') {
    return {
      name: 'PARAM_REQUEST_READ',
      fields: {
        target_system: target.sysid,
        target_component: target.compid,
        param_id: normalizeParamId(input.paramId),
        param_index: input.paramIndex === undefined ? -1 : Number(input.paramIndex),
      },
    };
  }
  if (input.action !== 'set') throw new Error(`unknown param action ${JSON.stringify(input.action)}`);
  const paramType = resolveParamType(input.paramType || 'MAV_PARAM_TYPE_REAL32');
  const encoding = resolveParamEncoding({
    encoding: input.encoding,
    capabilities: input.capabilities,
    firmware: input.firmware,
  });
  return {
    name: 'PARAM_SET',
    fields: {
      target_system: target.sysid,
      target_component: target.compid,
      param_id: normalizeParamId(input.paramId),
      param_value: encodeParamValue(input.value, paramType, encoding),
      param_type: paramType,
    },
  };
}

/**
 * @param {object} request
 * @param {object} decoded
 * @returns {boolean}
 */
function matchesParamEcho(request, decoded) {
  if (!decoded || decoded.name !== 'PARAM_VALUE') return false;
  // Scope the echo to the addressed vehicle: on a multi-vehicle connection a
  // PARAM_VALUE from another system must not confirm this set. A broadcast
  // component target (0) accepts any source component.
  if (request.target) {
    const t = request.target;
    if (
      t.sysid !== undefined &&
      decoded.sysid !== undefined &&
      Number(decoded.sysid) !== Number(t.sysid)
    ) {
      return false;
    }
    if (
      t.compid !== undefined &&
      Number(t.compid) !== 0 &&
      decoded.compid !== undefined &&
      Number(decoded.compid) !== Number(t.compid)
    ) {
      return false;
    }
  }
  const fields = decoded.fields || {};
  if (trimParamId(fields.param_id) !== normalizeParamId(request.paramId)) return false;
  if (request.value === undefined) return true;
  const type = resolveParamType(request.paramType || fields.param_type || 'MAV_PARAM_TYPE_REAL32');
  const encoding = resolveParamEncoding({
    encoding: request.encoding,
    capabilities: request.capabilities,
    firmware: request.firmware,
  });
  const actual = decodeParamValue(fields.param_value, type, encoding);
  const expected = Number(request.value);
  return numericEqual(actual, expected);
}

/**
 * @returns {{accept: (decoded: object) => (object[]|null)}}
 */
function createParamListCollector() {
  const byIndex = new Map();
  let expected = null;
  return {
    accept(decoded) {
      if (!decoded || decoded.name !== 'PARAM_VALUE') return null;
      const fields = decoded.fields || {};
      const index = Number(fields.param_index);
      const count = Number(fields.param_count);
      if (!Number.isInteger(index) || index < 0 || !Number.isInteger(count) || count < 0) return null;
      expected = count;
      byIndex.set(index, {
        paramId: trimParamId(fields.param_id),
        value: fields.param_value,
        paramType: fields.param_type,
        index,
        count,
      });
      if (expected === 0 || byIndex.size < expected) return null;
      return [...byIndex.values()].sort((a, b) => a.index - b.index);
    },
  };
}

/**
 * Resolve param wire encoding.
 *
 * Priority (DESIGN.md §11):
 *   1. explicit `encoding` (`bytewise` | `c-cast`) — present-but-invalid rejects
 *   2. AUTOPILOT_VERSION.capabilities bits
 *   3. named firmware — PX4 → bytewise; else C-cast. Absent firmware throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.encoding]
 * @param {number|null} [opts.capabilities]
 * @param {string} [opts.firmware]
 * @returns {'bytewise'|'c-cast'}
 */
function resolveParamEncoding(opts = {}) {
  // Dynamic msg override: only an absent value falls through. A present string
  // outside the two legal encodings is a caller error (do not silently pick
  // the opposite encoding via capabilities/firmware).
  if (opts.encoding != null && opts.encoding !== '') {
    const explicit = normalizeEncoding(opts.encoding);
    if (!explicit) {
      throw new Error(
        `unsupported param encoding ${JSON.stringify(String(opts.encoding))} (use bytewise or c-cast)`
      );
    }
    return explicit;
  }

  if (opts.capabilities != null && opts.capabilities !== '') {
    const caps = Number(opts.capabilities);
    if (Number.isFinite(caps)) {
      // Spec: a component sets one of these. Prefer bytewise if both appear.
      if ((caps & CAP_PARAM_ENCODE_BYTEWISE) !== 0) return PARAM_ENCODING.BYTEWISE;
      if ((caps & CAP_PARAM_ENCODE_C_CAST) !== 0) return PARAM_ENCODING.C_CAST;
    }
  }

  if (opts.firmware == null || opts.firmware === '') {
    throw new Error('param encoding unresolved: no override, capabilities, or firmware');
  }
  return opts.firmware === 'px4' ? PARAM_ENCODING.BYTEWISE : PARAM_ENCODING.C_CAST;
}

/**
 * @param {*} encoding
 * @returns {'bytewise'|'c-cast'|null}
 */
function normalizeEncoding(encoding) {
  if (encoding === PARAM_ENCODING.BYTEWISE || encoding === PARAM_ENCODING.C_CAST) {
    return encoding;
  }
  return null;
}

/**
 * @param {*} value
 * @param {number} paramType
 * @param {string} encodingOrFirmware  resolved encoding, or legacy firmware name
 * @returns {number}
 */
function encodeParamValue(value, paramType, encodingOrFirmware) {
  const encoding = encodingFromArg(encodingOrFirmware);
  if (encoding === PARAM_ENCODING.BYTEWISE) return paramValueToWire(value, paramType);
  return Number(value);
}

/**
 * @param {*} value
 * @param {number} paramType
 * @param {string} encodingOrFirmware
 * @returns {number}
 */
function decodeParamValue(value, paramType, encodingOrFirmware) {
  const encoding = encodingFromArg(encodingOrFirmware);
  if (encoding === PARAM_ENCODING.BYTEWISE) return paramValueFromWire(value, paramType);
  return Number(value);
}

/**
 * Accept a resolved encoding or a legacy firmware string (`px4` → bytewise).
 *
 * @param {*} arg
 * @returns {'bytewise'|'c-cast'}
 */
function encodingFromArg(arg) {
  const asEncoding = normalizeEncoding(arg);
  if (asEncoding) return asEncoding;
  return resolveParamEncoding({ firmware: arg });
}

/**
 * @param {number|string} paramType
 * @returns {number}
 */
function resolveParamType(paramType) {
  if (typeof paramType === 'number') return paramType;
  const s = String(paramType).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (!PARAM_TYPE[s]) throw new Error(`unknown MAV_PARAM_TYPE ${JSON.stringify(paramType)}`);
  return PARAM_TYPE[s];
}

/**
 * @param {*} paramId
 * @returns {string}
 */
function normalizeParamId(paramId) {
  const id = trimParamId(paramId);
  if (!id) throw new Error('param id is required');
  if (id.length > 16) throw new Error(`param id '${id}' exceeds MAVLink PARAM_ID length 16`);
  return id;
}

/**
 * @param {*} value
 * @returns {string}
 */
function trimParamId(value) {
  return String(value || '').replace(/\u0000+$/g, '').trim();
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
function numericEqual(a, b) {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  return Math.abs(a - b) <= 1e-6;
}

module.exports = {
  PARAM_TYPE,
  PARAM_ENCODING,
  CAP_PARAM_ENCODE_BYTEWISE,
  CAP_PARAM_ENCODE_C_CAST,
  buildParamMessage,
  matchesParamEcho,
  createParamListCollector,
  resolveParamEncoding,
  encodeParamValue,
  decodeParamValue,
};
