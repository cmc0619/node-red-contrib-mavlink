'use strict';

/** MAVLink log-transfer message builders. */

/** @param {{sysid:number, compid:number}} target */
function targetFields(target) {
  return { target_system: target.sysid, target_component: target.compid };
}

/**
 * Build LOG_REQUEST_LIST. The default range asks for the complete available
 * list; LOG_ENTRY carries the peer's actual indexing scheme and high id.
 *
 * @param {{sysid:number, compid:number}} target
 * @param {number} [start]
 * @param {number} [end]
 * @returns {{name:string, fields:object}}
 */
function buildRequestList(target, start = 0, end = 0xffff) {
  return {
    name: 'LOG_REQUEST_LIST',
    fields: { ...targetFields(target), start, end },
  };
}

/**
 * Build LOG_REQUEST_DATA for one offset range.
 *
 * @param {{sysid:number, compid:number}} target
 * @param {number} id
 * @param {number} ofs
 * @param {number} count
 * @returns {{name:string, fields:object}}
 */
function buildRequestData(target, id, ofs, count) {
  return {
    name: 'LOG_REQUEST_DATA',
    fields: { ...targetFields(target), id, ofs, count },
  };
}

/**
 * Build LOG_REQUEST_END, which releases the vehicle's log-transfer sender.
 *
 * @param {{sysid:number, compid:number}} target
 * @returns {{name:string, fields:object}}
 */
function buildRequestEnd(target) {
  return { name: 'LOG_REQUEST_END', fields: targetFields(target) };
}

module.exports = { buildRequestList, buildRequestData, buildRequestEnd };
