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
  // Acceleration composes. The wire always allowed it — type_mask carries an
  // independent ignore bit per group, and maskFor builds from `uses`, so these
  // three cost nothing but their names. What blocked them was this table, and
  // a refusal that read the gap as a rule.
  //
  // The firmware backs it (§14 source read, Copter-4.7.0): ArduPilot's
  // acceleration fields "feed real PosVelAccel / VelAccel / Accel guided
  // submodes" — position+velocity+acceleration and velocity+acceleration are
  // named submodes over there, not exotic combinations. Feed-forward
  // acceleration on a position or velocity target is the normal way to fly a
  // trajectory with a radio.
  'position-acceleration': { position: true, accel: true },
  'velocity-acceleration': { velocity: true, accel: true },
  'position-velocity-acceleration': { position: true, velocity: true, accel: true },
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
  numberOr,
  degreesToRadians,
};
