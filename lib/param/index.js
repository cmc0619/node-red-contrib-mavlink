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
 * Build one Param protocol message. `set` is echo-confirmed by the caller with
 * PARAM_VALUE; MAVLink has no COMMAND_ACK for params.
 *
 * @param {object} input
 * @returns {{name:string, fields: object}}
 */
function buildParamMessage(input) {
  const target = normalizeTarget(input.target);
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
  return {
    name: 'PARAM_SET',
    fields: {
      target_system: target.sysid,
      target_component: target.compid,
      param_id: normalizeParamId(input.paramId),
      param_value: encodeParamValue(input.value, paramType, input.firmware),
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
  const fields = decoded.fields || {};
  if (trimParamId(fields.param_id) !== normalizeParamId(request.paramId)) return false;
  if (request.value === undefined) return true;
  const type = resolveParamType(request.paramType || fields.param_type || 'MAV_PARAM_TYPE_REAL32');
  const actual = decodeParamValue(fields.param_value, type, request.firmware);
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
 * @param {*} value
 * @param {number} paramType
 * @param {string} firmware
 * @returns {number}
 */
function encodeParamValue(value, paramType, firmware) {
  if (firmware === 'px4') return paramValueToWire(value, paramType);
  return Number(value);
}

/**
 * @param {*} value
 * @param {number} paramType
 * @param {string} firmware
 * @returns {number}
 */
function decodeParamValue(value, paramType, firmware) {
  if (firmware === 'px4') return paramValueFromWire(value, paramType);
  return Number(value);
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

/**
 * @param {{sysid?:number, compid?:number}} target
 * @returns {{sysid:number, compid:number}}
 */
function normalizeTarget(target) {
  return {
    sysid: target && target.sysid !== undefined ? Number(target.sysid) : 1,
    compid: target && target.compid !== undefined ? Number(target.compid) : 1,
  };
}

module.exports = {
  PARAM_TYPE,
  buildParamMessage,
  matchesParamEcho,
  createParamListCollector,
  encodeParamValue,
  decodeParamValue,
};
