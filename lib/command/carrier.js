'use strict';

/**
 * COMMAND_LONG ↔ COMMAND_INT carrier conversion (DESIGN.md §9 "The vehicle
 * answers can you do this right now", "Coordinate frames").
 *
 * A vehicle that acks `COMMAND_INT_ONLY` (8) or `COMMAND_LONG_ONLY` (7) is
 * telling us it will only accept the *other* carrier message; the spec's chain
 * rule for both is "resend in the other form". This module owns the conversion
 * so the node stays thin (§2): it converts a COMMAND_LONG param array into
 * COMMAND_INT fields and back, and builds the wire-shaped message envelope for
 * either carrier.
 *
 * COMMAND_INT differs from COMMAND_LONG in three ways this module encodes:
 *   - it carries a `frame` (MAV_FRAME) so the vehicle knows how to read x/y/z;
 *   - params 5/6 become `x`/`y`, int32 fields that hold `degE7` lat/lon for a
 *     global frame (degrees × 1e7, §9 "Coordinate frames") or metres otherwise;
 *   - param 7 becomes `z`, a float altitude that is never scaled;
 *   - it adds `current` and `autocontinue` (both mission-item fields, irrelevant
 *     to a direct command — sent as 0).
 * COMMAND_INT has no `confirmation` byte, so the retry counter that the LONG
 * carrier increments has no analogue here.
 */

/**
 * MAV_FRAME values this module references. GLOBAL is 0 and is the documented
 * default carrier frame (see {@link DEFAULT_FRAME}); GLOBAL_RELATIVE_ALT is 3.
 * @enum {number}
 */
const MAV_FRAME = {
  GLOBAL: 0,
  GLOBAL_RELATIVE_ALT: 3,
  GLOBAL_INT: 5,
  GLOBAL_RELATIVE_ALT_INT: 6,
  GLOBAL_TERRAIN_ALT: 10,
  GLOBAL_TERRAIN_ALT_INT: 11,
};

/**
 * MAV_FRAME values whose x/y carry a global lat/lon position and therefore need
 * `degE7` scaling in the INT carrier. Every other frame (local NED, body,
 * mission) carries metres and passes through unscaled. Mirrors the mission
 * item builder's table (§9 "Coordinate frames").
 * @type {Set<number>}
 */
const GLOBAL_FRAMES = new Set([
  MAV_FRAME.GLOBAL,
  MAV_FRAME.GLOBAL_RELATIVE_ALT,
  MAV_FRAME.GLOBAL_INT,
  MAV_FRAME.GLOBAL_RELATIVE_ALT_INT,
  MAV_FRAME.GLOBAL_TERRAIN_ALT,
  MAV_FRAME.GLOBAL_TERRAIN_ALT_INT,
]);

/** Scale factor from degrees to the wire `degE7` int32 (§9 "Coordinate frames"). */
const DEG_E7 = 1e7;

/**
 * Default frame for an auto-converted COMMAND_INT when no frame is supplied.
 *
 * MAV_FRAME_GLOBAL (0) is the safest documented default: it is the plain
 * absolute-altitude global frame, and a wrong frame would earn a
 * COMMAND_UNSUPPORTED_MAV_FRAME rather than silently misplacing the vehicle
 * (§9). The node lets an operator override this via `msg.mavFrame` or config.
 * @type {number}
 */
const DEFAULT_FRAME = MAV_FRAME.GLOBAL;

/**
 * @param {number} frame  a MAV_FRAME value
 * @returns {boolean} true when x/y are global lat/lon (degrees), not metres
 */
function isGlobalFrame(frame) {
  return GLOBAL_FRAMES.has(Number(frame));
}

/**
 * Scale an operator-facing degrees value into the wire `degE7` int32, guarding
 * against double-scaling.
 *
 * A latitude/longitude in decimal degrees is always within [-180, 180]; a value
 * whose magnitude already exceeds 180 is therefore already a `degE7` integer
 * (e.g. 47.1234567° arrives as 471234567) and must not be scaled again, or it
 * would land seven more orders of magnitude off (§9 "Coordinate frames").
 *
 * @param {number} value  degrees, or an already-scaled degE7 integer
 * @returns {number} int32 degE7
 */
function scaleLatLon(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) > 180) return Math.round(n);
  return Math.round(n * DEG_E7);
}

/**
 * Reverse {@link scaleLatLon}: turn a wire `degE7` int32 back into decimal
 * degrees for the LONG carrier's float param.
 *
 * @param {number} value  degE7 integer
 * @returns {number} decimal degrees
 */
function unscaleLatLon(value) {
  return (Number(value) || 0) / DEG_E7;
}

/**
 * Convert a COMMAND_LONG 7-element param array into COMMAND_INT fields.
 *
 * Mapping (§9): param1–4 pass through unchanged; param5 → x, param6 → y,
 * param7 → z. For a global frame x/y are scaled to `degE7`; otherwise they pass
 * through rounded to int32. z is a float altitude and is never scaled.
 *
 * @param {number[]} paramArray  7-element [p1..p7] array
 * @param {object} [opts]
 * @param {number} [opts.frame]  MAV_FRAME; defaults to {@link DEFAULT_FRAME}
 * @param {number} [opts.current]  COMMAND_INT current flag (default 0)
 * @param {number} [opts.autocontinue]  COMMAND_INT autocontinue flag (default 0)
 * @returns {{frame: number, current: number, autocontinue: number,
 *   param1: number, param2: number, param3: number, param4: number,
 *   x: number, y: number, z: number}}
 */
function longToIntFields(paramArray, opts = {}) {
  const p = paramArray || [];
  const frame =
    opts.frame !== undefined && opts.frame !== null && opts.frame !== ''
      ? Number(opts.frame)
      : DEFAULT_FRAME;
  const global = isGlobalFrame(frame);
  const num = (v) => (v === undefined || v === null ? 0 : Number(v));
  return {
    frame,
    current: opts.current !== undefined ? Number(opts.current) : 0,
    autocontinue: opts.autocontinue !== undefined ? Number(opts.autocontinue) : 0,
    param1: num(p[0]),
    param2: num(p[1]),
    param3: num(p[2]),
    param4: num(p[3]),
    x: global ? scaleLatLon(num(p[4])) : Math.round(num(p[4])),
    y: global ? scaleLatLon(num(p[5])) : Math.round(num(p[5])),
    z: num(p[6]),
  };
}

/**
 * Convert COMMAND_INT fields back into a COMMAND_LONG 7-element param array.
 *
 * The inverse of {@link longToIntFields}: param1–4 pass through; x → param5,
 * y → param6 (un-scaled from `degE7` for a global frame), z → param7.
 *
 * @param {object} fields  COMMAND_INT fields (frame, param1..4, x, y, z)
 * @returns {number[]} 7-element [p1..p7] array
 */
function intFieldsToLong(fields) {
  const f = fields || {};
  const global = isGlobalFrame(f.frame === undefined ? DEFAULT_FRAME : f.frame);
  const num = (v) => (v === undefined || v === null ? 0 : Number(v));
  return [
    num(f.param1),
    num(f.param2),
    num(f.param3),
    num(f.param4),
    global ? unscaleLatLon(num(f.x)) : num(f.x),
    global ? unscaleLatLon(num(f.y)) : num(f.y),
    num(f.z),
  ];
}

/**
 * Build a COMMAND_LONG decoded-shape message ready for Connection.send().
 *
 * @param {number}   commandId
 * @param {number}   targetSysid
 * @param {number}   targetCompid
 * @param {number[]} paramArray   7-element [p1..p7]
 * @param {number}   confirmation
 * @returns {{name: 'COMMAND_LONG', fields: object}}
 */
function buildCommandLong(commandId, targetSysid, targetCompid, paramArray, confirmation) {
  const p = paramArray || [];
  const num = (v) => (v === undefined || v === null ? 0 : Number(v));
  return {
    name: 'COMMAND_LONG',
    fields: {
      target_system: targetSysid,
      target_component: targetCompid,
      command: commandId,
      confirmation,
      param1: num(p[0]),
      param2: num(p[1]),
      param3: num(p[2]),
      param4: num(p[3]),
      param5: num(p[4]),
      param6: num(p[5]),
      param7: num(p[6]),
    },
  };
}

/**
 * Build a COMMAND_INT decoded-shape message ready for Connection.send().
 *
 * @param {number}   commandId
 * @param {number}   targetSysid
 * @param {number}   targetCompid
 * @param {number[]} paramArray   7-element [p1..p7] (LONG form; converted here)
 * @param {object}   [opts]  { frame, current, autocontinue } — see longToIntFields
 * @returns {{name: 'COMMAND_INT', fields: object}}
 */
function buildCommandInt(commandId, targetSysid, targetCompid, paramArray, opts = {}) {
  const int = longToIntFields(paramArray, opts);
  return {
    name: 'COMMAND_INT',
    fields: {
      target_system: targetSysid,
      target_component: targetCompid,
      frame: int.frame,
      command: commandId,
      current: int.current,
      autocontinue: int.autocontinue,
      param1: int.param1,
      param2: int.param2,
      param3: int.param3,
      param4: int.param4,
      x: int.x,
      y: int.y,
      z: int.z,
    },
  };
}

module.exports = {
  MAV_FRAME,
  GLOBAL_FRAMES,
  DEG_E7,
  DEFAULT_FRAME,
  isGlobalFrame,
  scaleLatLon,
  unscaleLatLon,
  longToIntFields,
  intFieldsToLong,
  buildCommandLong,
  buildCommandInt,
};
