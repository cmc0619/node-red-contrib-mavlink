'use strict';

/**
 * Mission-protocol message builders (DESIGN.md §9 "Mission protocol", §9
 * "Coordinate frames").
 *
 * Two kinds of message are built here:
 *   - the small control messages that drive the conversation
 *     (`MISSION_REQUEST_LIST`, `MISSION_REQUEST_INT`, `MISSION_COUNT`,
 *     `MISSION_ACK`, `MISSION_CLEAR_ALL`);
 *   - the item payloads themselves, in the two carrier forms the vehicle may
 *     ask for — `MISSION_ITEM_INT` (integer `degE7` lat/lon) and the legacy
 *     `MISSION_ITEM` (float degrees). A `MISSION_REQUEST_INT` must be answered
 *     with `MISSION_ITEM_INT`, never a `MISSION_ITEM` (§9 "answer ... in the
 *     item format it asked for").
 *
 * **Item shape.** A canonical item is a plain object with the standard mission
 * fields — `{ frame, command, current, autocontinue, param1..param4, x, y, z }`.
 * `x`/`y` are float degrees for a global frame (matching `MISSION_ITEM`
 * semantics, the human-facing form); the INT builder scales them to `degE7`
 * integers because wire lat/lon are `int32` degrees × 10⁷ (§9). For a non-global
 * frame `x`/`y` are metres and pass through unscaled.
 */

/**
 * `MAV_FRAME` values that carry a global lat/lon position, and therefore need
 * `degE7` scaling in the INT carrier. Every other frame (local NED, body,
 * mission) carries metres and is not scaled.
 * @type {Set<number>}
 */
const GLOBAL_FRAMES = new Set([
  0, // GLOBAL
  3, // GLOBAL_RELATIVE_ALT
  5, // GLOBAL_INT
  6, // GLOBAL_RELATIVE_ALT_INT
  10, // GLOBAL_TERRAIN_ALT
  11, // GLOBAL_TERRAIN_ALT_INT
]);

/** Scale factor from degrees to the wire `degE7` integer (§9). */
const DEG_E7 = 1e7;

/**
 * @param {number} frame  a `MAV_FRAME` value
 * @returns {boolean} true when `x`/`y` are global lat/lon (degrees), not metres
 */
function isGlobalFrame(frame) {
  return GLOBAL_FRAMES.has(Number(frame));
}

/**
 * @param {{sysid: number, compid: number}} target
 * @returns {{target_system: number, target_component: number}}
 */
function targetFields(target) {
  return { target_system: target.sysid, target_component: target.compid };
}

/**
 * `MISSION_REQUEST_LIST` — opens a download (§9 "Download").
 *
 * @param {{sysid: number, compid: number}} target
 * @param {number} missionType
 * @returns {{name: string, fields: object}}
 */
function buildRequestList(target, missionType) {
  return {
    name: 'MISSION_REQUEST_LIST',
    fields: { ...targetFields(target), mission_type: missionType },
  };
}

/**
 * `MISSION_REQUEST_INT` — request one item by sequence during a download.
 * The INT form is used for our own requests; the vehicle answers with
 * `MISSION_ITEM_INT`.
 *
 * @param {{sysid: number, compid: number}} target
 * @param {number} seq
 * @param {number} missionType
 * @returns {{name: string, fields: object}}
 */
function buildRequestInt(target, seq, missionType) {
  return {
    name: 'MISSION_REQUEST_INT',
    fields: { ...targetFields(target), seq, mission_type: missionType },
  };
}

/**
 * `MISSION_COUNT` — opens an upload by declaring how many items follow (§9
 * "Upload").
 *
 * @param {{sysid: number, compid: number}} target
 * @param {number} count
 * @param {number} missionType
 * @returns {{name: string, fields: object}}
 */
function buildCount(target, count, missionType) {
  return {
    name: 'MISSION_COUNT',
    fields: { ...targetFields(target), count, mission_type: missionType },
  };
}

/**
 * `MISSION_ACK` — closes a download (we ack the vehicle's items) or is what the
 * vehicle sends to close an upload/clear.
 *
 * @param {{sysid: number, compid: number}} target
 * @param {number} missionType
 * @param {number} [type]  a `MAV_MISSION_RESULT`; defaults to ACCEPTED (0)
 * @returns {{name: string, fields: object}}
 */
function buildAck(target, missionType, type = 0) {
  return {
    name: 'MISSION_ACK',
    fields: { ...targetFields(target), type, mission_type: missionType },
  };
}

/**
 * `MISSION_CLEAR_ALL` — erases the plan of the given type (§9 "Clear").
 *
 * @param {{sysid: number, compid: number}} target
 * @param {number} missionType
 * @returns {{name: string, fields: object}}
 */
function buildClearAll(target, missionType) {
  return {
    name: 'MISSION_CLEAR_ALL',
    fields: { ...targetFields(target), mission_type: missionType },
  };
}

/**
 * Common item field set shared by both carrier forms. `x`/`y` are supplied by
 * the caller already in the correct domain for the chosen carrier.
 *
 * @param {object} item  canonical item
 * @param {{sysid: number, compid: number}} target
 * @param {number} seq
 * @param {number} missionType
 * @param {number} x
 * @param {number} y
 * @returns {object}
 */
function itemFields(item, target, seq, missionType, x, y) {
  return {
    ...targetFields(target),
    seq,
    frame: item.frame === undefined ? 0 : item.frame,
    command: item.command,
    current: item.current === undefined ? 0 : item.current,
    autocontinue: item.autocontinue === undefined ? 1 : item.autocontinue,
    param1: num(item.param1),
    param2: num(item.param2),
    param3: num(item.param3),
    param4: num(item.param4),
    x,
    y,
    z: num(item.z),
    mission_type: missionType,
  };
}

/**
 * Build a `MISSION_ITEM_INT` for `seq`. Global-frame `x`/`y` are scaled to the
 * wire `degE7` integer; other frames pass through (§9 "Coordinate frames").
 *
 * @param {object} item  canonical item
 * @param {{sysid: number, compid: number}} target
 * @param {number} seq
 * @param {number} missionType
 * @returns {{name: string, fields: object}}
 */
function buildItemInt(item, target, seq, missionType) {
  const global = isGlobalFrame(item.frame === undefined ? 0 : item.frame);
  const x = global ? Math.round(num(item.x) * DEG_E7) : num(item.x);
  const y = global ? Math.round(num(item.y) * DEG_E7) : num(item.y);
  return { name: 'MISSION_ITEM_INT', fields: itemFields(item, target, seq, missionType, x, y) };
}

/**
 * Build a legacy `MISSION_ITEM` for `seq`. `x`/`y` are float degrees (or metres)
 * and pass through unscaled.
 *
 * @param {object} item  canonical item
 * @param {{sysid: number, compid: number}} target
 * @param {number} seq
 * @param {number} missionType
 * @returns {{name: string, fields: object}}
 */
function buildItem(item, target, seq, missionType) {
  return {
    name: 'MISSION_ITEM',
    fields: itemFields(item, target, seq, missionType, num(item.x), num(item.y)),
  };
}

/**
 * Coerce an optional numeric field to a number, defaulting absent to 0. Items
 * come from the flow (not the wire), so this is shaping, not boundary
 * validation (§2 "A msg is not outside").
 *
 * @param {*} value
 * @returns {number}
 */
function num(value) {
  return value === undefined || value === null ? 0 : Number(value);
}

module.exports = {
  GLOBAL_FRAMES,
  DEG_E7,
  isGlobalFrame,
  buildRequestList,
  buildRequestInt,
  buildCount,
  buildAck,
  buildClearAll,
  buildItem,
  buildItemInt,
};
