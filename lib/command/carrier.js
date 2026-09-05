'use strict';

const { isBlank } = require('../addressing/resolve');

/**
 * COMMAND_LONG ↔ COMMAND_INT carrier construction and conversion (DESIGN.md §9
 * "The vehicle answers can you do this right now", "Coordinate frames").
 *
 * The operator picks the carrier in the node config (a required field — §9);
 * this module builds the wire envelope for either carrier from one canonical
 * 7-element param array whose positional values are always decimal degrees, so
 * the node stays thin (§2).
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
 * Carrier forms a command may be sent in (§9).
 * The node's required `carrier` config holds one of these values.
 * @enum {string}
 */
const CARRIER = { LONG: 'long', INT: 'int' };

/**
 * MAV_FRAME values this module references. GLOBAL_RELATIVE_ALT is 3 and is the
 * default carrier frame (see {@link DEFAULT_FRAME}); GLOBAL is 0.
 * @enum {number}
 */
const MAV_FRAME = {
  GLOBAL: 0,
  LOCAL_NED: 1,
  MISSION: 2,
  GLOBAL_RELATIVE_ALT: 3,
  LOCAL_ENU: 4,
  GLOBAL_INT: 5,
  GLOBAL_RELATIVE_ALT_INT: 6,
  LOCAL_OFFSET_NED: 7,
  BODY_NED: 8,
  BODY_OFFSET_NED: 9,
  GLOBAL_TERRAIN_ALT: 10,
  GLOBAL_TERRAIN_ALT_INT: 11,
  BODY_FRD: 12,
  LOCAL_FRD: 20,
  LOCAL_FLU: 21,
};

/**
 * MAV_FRAME values whose x/y carry a global lat/lon position and therefore need
 * `degE7` scaling in the INT carrier. The one owner of that classification
 * (§9 "Coordinate frames"): the mission item builders import
 * {@link isGlobalFrame} from here.
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
 * Documented relative-alt frame for editors that must save an explicit
 * MAV_FRAME. ArduPilot Copter accepts only `MAV_FRAME_GLOBAL_RELATIVE_ALT` (3)
 * for COMMAND_INT takeoff — a strict equality check. The driver does **not**
 * invent this when `opts.frame` is omitted (§0); blank/omitted stays unset.
 * Pack refuses an unspoken frame (§14); the editor must save one explicitly.
 *
 * Note `GLOBAL_RELATIVE_ALT_INT` (6) is not interchangeable — the vehicle
 * check is on the numeric value.
 *
 * @type {number}
 */
const DEFAULT_FRAME = MAV_FRAME.GLOBAL_RELATIVE_ALT;

/**
 * MAV_FRAME values whose x/y are a *local position in metres* and therefore
 * scale ×1e4 in the INT carrier (§9, §14).
 *
 * All eight members are SITL-measured on PX4 (§14: same x=1234567 decoded as
 * 123.4567 under every one of them), and the set is member-for-member
 * identical to the only decoder that implements the local rule — PX4's
 * `mavlink_receiver.cpp` COMMAND_INT frame chain. This table is static
 * because the classification exists nowhere as data: MAVLink's XML gives
 * frames only a name and prose, so PX4 hardcodes this same list in C++ and
 * must edit it too if a frame is ever added. Entry values are frozen by
 * MAVLink's compatibility rules (dead slots are tombstoned, not renumbered —
 * see 13 below), so the numbers cannot rot; a future addition lands in the
 * unclassified path below until both ends implement it.
 *
 * Named explicitly rather than derived as "not global": `MAV_FRAME_MISSION`
 * (2) is neither — the dialect calls it "NOT a coordinate frame" and PX4
 * decodes it with the degE7 divisor (measured), so folding it into the local
 * bucket would corrupt it.
 *
 * Deliberately absent: 13. The bundled dialect names it `MAV_FRAME_RESERVED_13`
 * — upstream removed `BODY_FLU` for want of implementations and reserved the
 * slot. Measured: PX4's fallthrough decodes 13 with the degE7 divisor; we
 * deliberately leave it *unclassified* (metres pass through unscaled) rather
 * than matching that divisor, because inventing semantics for a reserved slot
 * is guessing either way and passthrough is the do-nothing default.
 * @type {Set<number>}
 */
const LOCAL_FRAMES = new Set([
  MAV_FRAME.LOCAL_NED,
  MAV_FRAME.LOCAL_ENU,
  MAV_FRAME.LOCAL_OFFSET_NED,
  MAV_FRAME.BODY_NED,
  MAV_FRAME.BODY_OFFSET_NED,
  MAV_FRAME.BODY_FRD,
  MAV_FRAME.LOCAL_FRD,
  MAV_FRAME.LOCAL_FLU,
]);

/**
 * @param {number} frame  a MAV_FRAME value
 * @returns {boolean} true when x/y are global lat/lon (degrees), not metres
 */
function isGlobalFrame(frame) {
  return GLOBAL_FRAMES.has(Number(frame));
}

/**
 * @param {number} frame  a MAV_FRAME value
 * @returns {boolean} true when x/y are a local position in metres
 */
function isLocalFrame(frame) {
  return LOCAL_FRAMES.has(Number(frame));
}

/**
 * Lazy value→command index per bundle, keyed on its `commands` object so a
 * reloaded dialect indexes fresh. First entry wins on a duplicate value,
 * matching the linear scan this replaced.
 * @type {WeakMap<object, Map<number, object>>}
 */
const commandIndexByBundle = new WeakMap();

/**
 * Find one MAV_CMD definition by its numeric value.
 *
 * @param {object} bundle
 * @param {number} commandId
 * @returns {object|undefined}
 */
function commandByValue(bundle, commandId) {
  let index = commandIndexByBundle.get(bundle.commands);
  if (index === undefined) {
    index = new Map();
    for (const command of Object.values(bundle.commands)) {
      const value = Number(command.value);
      if (!index.has(value)) index.set(value, command);
    }
    commandIndexByBundle.set(bundle.commands, index);
  }
  return index.get(Number(commandId));
}

/**
 * Ask the dialect XML how COMMAND_INT's x/y (param5/6) carry this command's
 * values (§9 "ask the XML"). Three kinds:
 *
 *   'latlon' — a real coordinate entered in degrees; scale ×1e7 on a global
 *              frame (`hasLocation` command, param not declared degE7)
 *   'dege7'  — the XML declares the param natively degE7 (e.g.
 *              PAYLOAD_PREPARE_DEPLOY); the entered value IS the wire value
 *   'raw'    — not a location at all (gimbal manager flags, request params);
 *              never scale
 *
 * Returns null when the bundle does not carry the command — callers then
 * treat params 5 and 6 as latlon, the default `longToIntFields` carries.
 *
 * @param {object} bundle  compiled dialect bundle (has `.commands` by name)
 * @param {number} commandId  MAV_CMD value
 * @returns {{5: string, 6: string}|null}
 */
function intCoordKinds(bundle, commandId) {
  const cmd = commandByValue(bundle, commandId);
  if (!cmd) return null;
  const kind = (index) => {
    if (!cmd.hasLocation) return 'raw';
    const entry = cmd.params.find((param) => param.index === index);
    if (entry && /degE7/i.test(entry.units)) return 'dege7';
    return 'latlon';
  };
  return { 5: kind(5), 6: kind(6) };
}

/**
 * Resolve the MAV_FRAME for an INT build from the standard precedence chain:
 * per-message override (msg.mavFrame / msg.payload.mavFrame) beats node
 * config; blank/absent yields undefined (not invented — the editor saves an
 * explicit frame). One implementation for the command, payload, and fanout
 * nodes (§9).
 *
 * @param {*} override  the per-message value
 * @param {*} configured  the node-config value
 * @returns {number|undefined}
 */
function resolveFrame(override, configured) {
  if (!isBlank(override)) return Number(override);
  if (!isBlank(configured)) return Number(configured);
  return undefined;
}

/**
 * Scale an operator-facing degrees value into the wire `degE7` int32.
 *
 * The input is always decimal degrees — the operator-facing unit across every
 * action node (§9 "Coordinate frames") — so the scale is unconditional. There
 * is deliberately no "already scaled" guess here: the node knows its carrier
 * from config, so the canonical params it holds are degrees, full stop. A
 * heuristic pass-through (the old `|v| > 180` rule) could silently misread a
 * near-null-island degE7 value as degrees; certainty beats guessing.
 *
 * @param {number} value  degrees
 * @returns {number} int32 degE7
 */
function scaleLatLon(value) {
  return Math.round(Number(value) * DEG_E7);
}

/** Scale factor for COMMAND_INT local-frame x/y: metres × 10⁴ (common.xml). */
const LOCAL_E4 = 1e4;

/**
 * Scale an operator-facing local-frame offset (metres) into the wire int32.
 *
 * common.xml defines COMMAND_INT x/y as "local: x position in meters * 1e4,
 * global: latitude in degrees * 10^7" — the divisor is frame-dependent, and
 * this is the local half. Measured, not assumed (§14): PX4 decodes a
 * LOCAL_NED x of 1234567 as 123.4567 m and the same value under GLOBAL_INT as
 * 0.123457°, so the scale is real on the wire. ArduPilot denies local-frame
 * COMMAND_INT for location-bearing commands outright, so it reads no value at
 * all here and cannot be regressed by scaling.
 *
 * @param {number} value  metres
 * @returns {number} int32 metres × 1e4
 */
function scaleLocalMetres(value) {
  return Math.round(value * LOCAL_E4);
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
 * @param {number} [opts.frame]  MAV_FRAME; blank/omitted is left unset (not invented)
 * @param {number} [opts.current]  COMMAND_INT current flag (default 0)
 * @param {number} [opts.autocontinue]  COMMAND_INT autocontinue flag (default 0)
 * @returns {{frame?: number, current: number, autocontinue: number,
 *   param1: number, param2: number, param3: number, param4: number,
 *   x: number, y: number, z: number}}
 */
function longToIntFields(paramArray, opts = {}) {
  // Spoken → Number(frame). Blank/omitted → leave unset (do not invent
  // DEFAULT_FRAME). Bare Number(opts.frame) would turn null/'' into 0.
  let frame;
  if (!isBlank(opts.frame)) frame = Number(opts.frame);
  const global = isGlobalFrame(frame);
  const kinds = opts.coordKinds || { 5: 'latlon', 6: 'latlon' };

  /**
   * One x/y int32 from a canonical param. Absent stays unset (builder does
   * not invent 0). Pack refuses unspoken/non-finite core ints (§14).
   */
  const intXY = (value, kind) => {
    if (isBlank(value)) return undefined;
    const n = Number(value);
    // A real coordinate param scales by frame: degrees × 1e7 when global,
    // metres × 1e4 when the frame is a local position (§9, §14 — both halves
    // measured against SITL). Any other frame — MAV_FRAME_MISSION, or one we
    // do not classify — passes through unscaled, as it did before the local
    // rule existed. A natively-degE7 param and a non-location param5/6
    // (gimbal flags, etc.) carry what the operator entered in every frame.
    switch (kind) {
      case 'latlon':
        if (global) return scaleLatLon(n);
        if (isLocalFrame(frame)) return scaleLocalMetres(n);
        return Math.round(n);
      case 'dege7': return Math.round(n);
      case 'raw': return Math.round(n);
      default: break; // This space intentionally left blank (§5)
    }
    return NaN; // nothing matched: no behavior selected (§5)
  };

  return {
    frame,
    current: opts.current !== undefined ? Number(opts.current) : 0,
    autocontinue: opts.autocontinue !== undefined ? Number(opts.autocontinue) : 0,
    // Floats: Number() of whatever the canonical array holds — a blank reads
    // as 0, byte-identical to the field's unset default.
    param1: Number(paramArray[0]),
    param2: Number(paramArray[1]),
    param3: Number(paramArray[2]),
    param4: Number(paramArray[3]),
    x: intXY(paramArray[4], kinds[5]),
    y: intXY(paramArray[5], kinds[6]),
    z: Number(paramArray[6]),
  };
}

/**
 * Build a COMMAND_LONG decoded-shape message ready for Connection.send().
 *
 * @param {number}   commandId
 * @param {number}   targetSystem
 * @param {number}   targetComponent
 * @param {number[]} paramArray   7-element [p1..p7]
 * @param {number}   confirmation
 * @returns {{name: 'COMMAND_LONG', fields: object}}
 */
function buildCommandLong(commandId, targetSystem, targetComponent, paramArray, confirmation) {
  return {
    name: 'COMMAND_LONG',
    fields: {
      target_system: targetSystem,
      target_component: targetComponent,
      command: commandId,
      confirmation,
      param1: paramArray[0],
      param2: paramArray[1],
      param3: paramArray[2],
      param4: paramArray[3],
      param5: paramArray[4],
      param6: paramArray[5],
      param7: paramArray[6],
    },
  };
}

/**
 * Build a COMMAND_INT decoded-shape message ready for Connection.send().
 *
 * @param {number}   commandId
 * @param {number}   targetSystem
 * @param {number}   targetComponent
 * @param {number[]} paramArray   7-element [p1..p7] (LONG form; converted here)
 * @param {object}   [opts]  { frame, current, autocontinue } — see longToIntFields
 * @returns {{name: 'COMMAND_INT', fields: object}}
 */
function buildCommandInt(commandId, targetSystem, targetComponent, paramArray, opts = {}) {
  const int = longToIntFields(paramArray, opts);
  return {
    name: 'COMMAND_INT',
    fields: {
      target_system: targetSystem,
      target_component: targetComponent,
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
  CARRIER,
  commandByValue,
  intCoordKinds,
  resolveFrame,
  MAV_FRAME,
  GLOBAL_FRAMES,
  LOCAL_FRAMES,
  DEG_E7,
  DEFAULT_FRAME,
  isGlobalFrame,
  scaleLatLon,
  longToIntFields,
  buildCommandLong,
  buildCommandInt,
};
