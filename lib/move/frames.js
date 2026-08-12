'use strict';

const { isBlank } = require('../addressing/resolve');

/**
 * Move's shared mode/frame vocabulary and coordinate guards, used by both
 * carriers: the setpoint builder (./index.js) and the reposition command
 * builder (./reposition.js). This is the wire vocabulary the Action-surface
 * derivation (./action.js) targets, not an operator surface: the node derives
 * a numeric frame (frameForAltRef, frameForReference) and a mode name
 * (deriveSteerMode, or the literal 'position'), and the retired operator
 * frame vocabulary is not read at all.
 */

/**
 * MAV_FRAME values the derivation can produce, keyed by member name. Nothing
 * else reaches the builders (§6 redesign, 2026-08-12): goto derives 0/3,
 * steer derives 1/8/9.
 */
const MAV_FRAME = {
  GLOBAL: 0,
  LOCAL_NED: 1,
  GLOBAL_RELATIVE_ALT: 3,
  BODY_NED: 8,
  BODY_OFFSET_NED: 9,
};

const GLOBAL_FRAMES = new Set([
  MAV_FRAME.GLOBAL,
  MAV_FRAME.GLOBAL_RELATIVE_ALT,
]);

/**
 * Move modes: which setpoint vectors the message *uses* (everything else is
 * mask-ignored). One vocabulary — Move, Fan-out, and payload overrides all
 * speak these names (pre-1.0: no aliases, no migrations). The reposition
 * carrier resolves the same names and refuses everything but `position`.
 */
const MODES = {
  position: { position: true },
  velocity: { velocity: true },
  'position-velocity': { position: true, velocity: true },
  acceleration: { accel: true },
  'yaw-only': {},
};

/**
 * Resolve the mode name and numeric frame. The vocabulary is numeric-only:
 * `input.frame` is a MAV_FRAME number from the Action derivation — string
 * frame names died with the operator frame surface and throw here.
 *
 * @param {object} input
 * @returns {{mode: string, frame: number}}
 */
function resolveModeAndFrame(input) {
  const mode = input.mode || 'position';
  // Own-property check, not truthiness/undefined: `mode` is runtime-boundary
  // data (`msg.payload`), and a plain object literal inherits `constructor`,
  // `toString`, `valueOf`… A mode of 'constructor' otherwise passes the guard,
  // `uses` becomes a function, every `uses.*` read is undefined, and maskFor
  // emits type_mask 3583 — the all-ignore packet the yaw-only guard exists to
  // prevent (§14 / #115).
  if (!Object.prototype.hasOwnProperty.call(MODES, mode)) {
    throw new Error(
      `unknown Move mode ${JSON.stringify(mode)} — expected one of ${Object.keys(MODES).join(', ')}`
    );
  }

  let frame = input.frame;
  if (isBlank(frame)) {
    // Builder-level safety, still exercised: blank means "nothing supplied"
    // and defaults to the frame that works everywhere.
    frame = MAV_FRAME.LOCAL_NED;
  } else if (!Object.values(MAV_FRAME).includes(Number(frame))) {
    throw new Error(`Move frame ${JSON.stringify(frame)} is not a SET_POSITION_TARGET frame`);
  } else {
    frame = Number(frame);
  }
  return { mode, frame };
}

/**
 * Refuse a global position whose lat, lon or alt is blank or out of range —
 * shared by both carriers (§10 "blank coordinates must not become 0,0").
 *
 * @param {{lat:*, lon:*, alt:*}} p
 */
function requireGlobalPosition(p) {
  if (isBlank(p.lat) || isBlank(p.lon) || isBlank(p.alt)) {
    // §10: blank coordinates must not become 0,0 — and a blank alt zero-filled
    // is the same hazard on the vertical axis: 0 m above home (frame 3, wire
    // twin 6) is the ground, and 0 m MSL (frame 0, wire twin 5) may be below it.
    throw new Error('Move global position requires lat, lon and alt (blank coordinates must not become 0,0 at ground level)');
  }
  // The degE7 int32 ceiling is ±214.7°: an out-of-range longitude still
  // scales into a garbage coordinate the vehicle would accept — same hazard
  // class as the blank guards (C4). A non-numeric value passes here as NaN
  // and fails numberOr's finite check downstream.
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (lat < -90 || lat > 90) {
    throw new Error(`Move global position lat must be within [-90, 90] degrees, got ${JSON.stringify(p.lat)}`);
  }
  if (lon < -180 || lon > 180) {
    throw new Error(`Move global position lon must be within [-180, 180] degrees, got ${JSON.stringify(p.lon)}`);
  }
}

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  if (isBlank(value)) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a finite number, got ${JSON.stringify(value)}`);
  return n;
}

/**
 * Convert operator-facing degrees to the wire's radians — the yaw twin of the
 * altitude sign flip: exactly once, at encode. `undefined` (blank, already
 * mask-ignored) encodes 0; NaN passes through — NaN floats are legal MAVLink.
 *
 * @param {*} value  degrees, or undefined when mask-ignored
 * @returns {number} radians
 */
function degreesToRadians(value) {
  if (value === undefined) return 0;
  return Number(value) * (Math.PI / 180);
}

module.exports = {
  MAV_FRAME,
  GLOBAL_FRAMES,
  MODES,
  resolveModeAndFrame,
  requireGlobalPosition,
  numberOr,
  degreesToRadians,
};
