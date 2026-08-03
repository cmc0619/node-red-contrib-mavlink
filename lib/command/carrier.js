'use strict';

const { MAV_RESULT } = require('./status-record');

/**
 * COMMAND_LONG ↔ COMMAND_INT carrier construction and conversion (DESIGN.md §9
 * "The vehicle answers can you do this right now", "Coordinate frames").
 *
 * The operator picks the carrier in the node config (a required field — §9);
 * this module builds the wire envelope for either carrier from one canonical
 * 7-element param array whose positional values are always decimal degrees.
 * A vehicle that acks `COMMAND_INT_ONLY` (8) or `COMMAND_LONG_ONLY` (7) is
 * telling us it will only accept the *other* carrier message; the spec's chain
 * rule for both is "resend in the other form", and the resend rebuilds from
 * the same canonical params — no guessing about scaling. This module owns the
 * conversion so the node stays thin (§2).
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
 * Carrier forms a command may be sent in (§9 "resend in the other form").
 * The node's required `carrier` config holds one of these values.
 * @enum {string}
 */
const CARRIER = { LONG: 'long', INT: 'int' };

/**
 * MAV_FRAME values this module references. GLOBAL is 0 and is the documented
 * default carrier frame (see {@link DEFAULT_FRAME}); GLOBAL_RELATIVE_ALT is 3.
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
 * `degE7` scaling in the INT carrier. Mirrors the mission item builder's table
 * (§9 "Coordinate frames").
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
 * MAV_FRAME values whose x/y are *not a position at all*: `MAV_FRAME_MISSION`
 * ("NOT a coordinate frame" per the dialect) and the tombstoned RESERVED
 * slots 13–19. Neither divisor applies; values pass through unscaled.
 *
 * This third set exists so the classification is *complete* over the dialect:
 * the drift test in test/command/carrier.test.js asserts every MAV_FRAME
 * entry in the bundled dialect lands in exactly one of GLOBAL_FRAMES /
 * LOCAL_FRAMES / NON_POSITION_FRAMES. That is where the dynamism lives — a
 * dialect refresh that adds a frame fails the build naming the new entry,
 * instead of silently passing it through (or worse, silently guessing a
 * divisor the deployed firmware doesn't implement yet). Frame semantics are
 * prose-only in MAVLink's XML, so they cannot be *derived* — but the XML we
 * compile can and does *enforce* that no entry goes unclassified.
 * @type {Set<number>}
 */
const NON_POSITION_FRAMES = new Set([
  MAV_FRAME.MISSION,
  13, 14, 15, 16, 17, 18, 19, // MAV_FRAME_RESERVED_13..19 — tombstoned slots
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
 * Find one MAV_CMD definition by its numeric value.
 *
 * @param {object} bundle
 * @param {number} commandId
 * @returns {object|null}
 */
function commandByValue(bundle, commandId) {
  if (!bundle) return null;
  return Object.values(bundle.commands || {}).find(
    (command) => Number(command.value) === Number(commandId)
  ) || null;
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
 * Returns null when the bundle or command is unknown — callers fall back to
 * the historical treat-as-latlon behavior.
 *
 * @param {object} bundle  compiled dialect bundle (has `.commands` by name)
 * @param {number} commandId  MAV_CMD value
 * @returns {{5: string, 6: string}|null}
 */
function intCoordKinds(bundle, commandId) {
  if (!bundle || !bundle.commands) return null;
  const cmd = commandByValue(bundle, commandId);
  if (!cmd) return null;
  const kind = (index) => {
    if (!cmd.hasLocation) return 'raw';
    const p = (cmd.params || []).find((p) => p.index === index);
    if (p && /degE7/i.test(p.units || '')) return 'dege7';
    return 'latlon';
  };
  return { 5: kind(5), 6: kind(6) };
}

function num(value) {
  return value === undefined || value === null ? 0 : Number(value);
}

/**
 * Resolve the MAV_FRAME for an INT build from the standard precedence chain:
 * per-message override (msg.mavFrame / msg.payload.mavFrame) beats node
 * config; blank/absent yields undefined so the builder's documented default
 * (GLOBAL) applies. One implementation for the command, payload, and fanout
 * nodes (§9).
 *
 * @param {*} override  the per-message value
 * @param {*} configured  the node-config value
 * @returns {number|undefined}
 */
function resolveFrame(override, configured) {
  if (override !== undefined && override !== null && override !== '') return Number(override);
  if (configured !== undefined && configured !== null && configured !== '') return Number(configured);
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
  const n = Number(value) || 0;
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
  // No `|| 0` fallback: `intXY` has already rejected a non-finite value, so a
  // zero-default here could only mask a caller that skipped that gate (§2 — no
  // silent repair of a violated invariant).
  return Math.round(value * LOCAL_E4);
}

/**
 * Reverse {@link scaleLocalMetres}: wire int32 back into metres.
 *
 * @param {number} value  metres × 1e4
 * @returns {number} metres
 */
function unscaleLocalMetres(value) {
  return value / LOCAL_E4;
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
  const kinds = opts.coordKinds || { 5: 'latlon', 6: 'latlon' };

  /**
   * One x/y int32 from a canonical param. NaN is rejected outright: the spec
   * routes commands where NaN in param5/6 has meaning ("leave unchanged") to
   * COMMAND_LONG — int32 cannot express it, and coercing to 0 would silently
   * aim a global-frame command at null island ("blank coordinates must not
   * become 0,0", §9/§10).
   */
  const intXY = (value, kind, name) => {
    const n = num(value);
    if (!Number.isFinite(n)) {
      throw new Error(
        `COMMAND_INT ${name} must be finite — commands where NaN in param5/6 ` +
          'has meaning must be sent as COMMAND_LONG (§9)'
      );
    }
    // A real coordinate param scales by frame: degrees × 1e7 when global,
    // metres × 1e4 when the frame is a local position (§9, §14 — both halves
    // measured against SITL). Any other frame — MAV_FRAME_MISSION, or one we
    // do not classify — passes through unscaled, as it did before the local
    // rule existed. A natively-degE7 param and a non-location param5/6
    // (gimbal flags, etc.) carry what the operator entered in every frame.
    if (kind === 'latlon') {
      if (global) return scaleLatLon(n);
      if (isLocalFrame(frame)) return scaleLocalMetres(n);
    }
    return Math.round(n);
  };

  return {
    frame,
    current: opts.current !== undefined ? Number(opts.current) : 0,
    autocontinue: opts.autocontinue !== undefined ? Number(opts.autocontinue) : 0,
    param1: num(p[0]),
    param2: num(p[1]),
    param3: num(p[2]),
    param4: num(p[3]),
    x: intXY(p[4], kinds[5], 'x (param5)'),
    y: intXY(p[5], kinds[6], 'y (param6)'),
    z: num(p[6]),
  };
}

/**
 * Convert COMMAND_INT fields back into a COMMAND_LONG 7-element param array.
 *
 * The inverse of {@link longToIntFields}: param1–4 pass through; x → param5,
 * y → param6, z → param7. A coordinate param un-scales by frame — `degE7` when
 * global, metres × 1e4 when local — so a LONG→INT→LONG round trip is lossless
 * in both frames. `coordKinds` mirrors {@link longToIntFields} so a
 * natively-degE7 or non-location param5/6 passes through untouched; it
 * defaults to treating both as coordinates, matching that function's default.
 *
 * @param {object} fields  COMMAND_INT fields (frame, param1..4, x, y, z)
 * @param {object} [opts]
 * @param {{5: string, 6: string}} [opts.coordKinds]  see {@link intCoordKinds}
 * @returns {number[]} 7-element [p1..p7] array
 */
function intFieldsToLong(fields, opts = {}) {
  const f = fields || {};
  const global = isGlobalFrame(f.frame === undefined ? DEFAULT_FRAME : f.frame);
  const kinds = opts.coordKinds || { 5: 'latlon', 6: 'latlon' };
  const frame = f.frame === undefined ? DEFAULT_FRAME : f.frame;
  const fromXY = (value, kind) => {
    const n = num(value);
    if (kind !== 'latlon') return n;
    if (global) return unscaleLatLon(n);
    if (isLocalFrame(frame)) return unscaleLocalMetres(n);
    return n;
  };
  return [
    num(f.param1),
    num(f.param2),
    num(f.param3),
    num(f.param4),
    fromXY(f.x, kinds[5]),
    fromXY(f.y, kinds[6]),
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

/**
 * Given a wrong-carrier MAV_RESULT, the carrier the vehicle is asking for, or
 * null when the code is not a carrier mismatch (§9 "resend in the other form").
 *
 * `COMMAND_INT_ONLY` (8) and `COMMAND_LONG_ONLY` (7) are the vehicle saying it
 * will only accept the *other* message. Both Command and Payload act on it, so
 * the mapping lives here rather than in either node (§2 — the node stays thin).
 *
 * @param {number} resultCode  MAV_RESULT from the COMMAND_ACK
 * @returns {'long'|'int'|null}
 */
function carrierWantedBy(resultCode) {
  if (resultCode === MAV_RESULT.COMMAND_INT_ONLY) return CARRIER.INT;
  if (resultCode === MAV_RESULT.COMMAND_LONG_ONLY) return CARRIER.LONG;
  return null;
}

module.exports = {
  CARRIER,
  carrierWantedBy,
  commandByValue,
  intCoordKinds,
  resolveFrame,
  MAV_FRAME,
  GLOBAL_FRAMES,
  LOCAL_FRAMES,
  NON_POSITION_FRAMES,
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
