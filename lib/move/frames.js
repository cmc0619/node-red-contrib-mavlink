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
 * steer derives 1/7/8/9.
 */
const MAV_FRAME = {
  GLOBAL: 0,
  LOCAL_NED: 1,
  GLOBAL_RELATIVE_ALT: 3,
  // LOCAL_OFFSET_NED: the world-axis offset from wherever the vehicle is.
  // Restored 2026-08-13 after #278 swept it out with the deprecated aliases —
  // it is not deprecated (common.xml carries no successor for it, unlike 8 and
  // 9, which are superseded by BODY_FRD), and it is the only local frame
  // ArduPlane accepts at all.
  LOCAL_OFFSET_NED: 7,
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
  // Acceleration composes with velocity, and with position *and* velocity
  // together. The wire always allowed it — type_mask carries an independent
  // ignore bit per group — and the firmware backs these two specifically
  // (§14 source read, Copter-4.7.0): ArduPilot's acceleration fields "feed
  // real PosVelAccel / VelAccel / Accel guided submodes". Those three names
  // are the whole list, and these two rows are two of them.
  //
  // position+acceleration *without* velocity is deliberately not here. It is
  // the one combination that has no named submode on the read, and no §14
  // measurement in either direction — so it is unmeasured, and unmeasured
  // stays off the surface until it isn't (the terrain-frame precedent). The
  // hazard if the read is right is the worst kind: a setpoint carries no ack,
  // so the operator sees "sent" while the vehicle holds position. Better an
  // unknown-mode refusal naming the gap than a silent hold. Measure mask 3128
  // against both stacks and this row is a one-line addition.
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
  if (isBlank(input.mode)) {
    throw new Error(
      `Move needs a mode — expected one of ${Object.keys(MODES).join(', ')}`
    );
  }
  const mode = input.mode;
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

  // No default. A blank frame used to become LOCAL_NED "the frame that works
  // everywhere", and that is what turned a lost altitude reference into a
  // SET_POSITION_TARGET_LOCAL_NED at x,y,z = 0,0,-0 — fly to the EKF origin —
  // instead of the global goto that was asked for. LOCAL_NED is a legitimate
  // frame, so nothing downstream could tell the two apart. If the caller did
  // not set it, we do not know it (owner ruling, 2026-08-14).
  if (isBlank(input.frame)) {
    throw new Error('Move needs a frame — nothing supplied, and there is no safe frame to assume');
  }
  if (!Object.values(MAV_FRAME).includes(Number(input.frame))) {
    throw new Error(`Move frame ${JSON.stringify(input.frame)} is not a SET_POSITION_TARGET frame`);
  }
  return { mode, frame: Number(input.frame) };
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

/**
 * An enum token → its wire value. No fallback parameter: a caller with a
 * documented blank sentinel says so on its own line, where it is visible.
 * Anything not a member craters (AGENTS.md — the driver never invents a value
 * you did not give it). `hasOwnProperty`, so `'constructor'` is not a member.
 *
 * @param {Object<string, number>} table
 * @param {*} value
 * @param {string} label  what to call it in the error
 * @returns {number}
 */
function enumValue(table, value, label) {
  if (Object.prototype.hasOwnProperty.call(table, value)) return table[value];
  throw new Error(
    `unknown Move ${label} ${JSON.stringify(value)} — expected one of ${Object.keys(table).join(', ')}`
  );
}


module.exports = {
  MAV_FRAME,
  GLOBAL_FRAMES,
  MODES,
  resolveModeAndFrame,
  numberOr,
  degreesToRadians,
  enumValue,
};
