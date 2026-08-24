'use strict';

/**
 * Move's shared wire vocabulary, used by both carriers: the setpoint builder
 * (./index.js) and the reposition command builder (./reposition.js). The
 * Action derivation (./action.js) produces a numeric frame and a mode name;
 * nothing here reads an operator token.
 */

/** MAV_FRAME values the Action derivation produces. */
const MAV_FRAME = {
  GLOBAL: 0,
  LOCAL_NED: 1,
  GLOBAL_RELATIVE_ALT: 3,
  // Not deprecated, unlike 8 and 9 (superseded by BODY_FRD): common.xml
  // carries no successor, and it is the only local frame ArduPlane accepts.
  LOCAL_OFFSET_NED: 7,
  BODY_NED: 8,
  BODY_OFFSET_NED: 9,
  // Alt is height above the terrain under the target; the vehicle resolves it
  // from its own terrain data and refuses loudly without any (pymavlink
  // posture — we only pack the frame).
  GLOBAL_TERRAIN_ALT: 10,
};

const GLOBAL_FRAMES = new Set([
  MAV_FRAME.GLOBAL,
  MAV_FRAME.GLOBAL_RELATIVE_ALT,
  MAV_FRAME.GLOBAL_TERRAIN_ALT,
]);

/**
 * Which setpoint vectors each mode *uses* — everything else is mask-ignored.
 * A data table keyed by the names `deriveSteerMode` composes from the filled
 * field groups.
 *
 * Acceleration composes with velocity, and with position *and* velocity
 * together: type_mask carries an independent ignore bit per group, and
 * ArduPilot backs these two specifically (§14 source read, Copter-4.7.0 —
 * the PosVelAccel / VelAccel / Accel guided submodes).
 *
 * position+acceleration without velocity has no named submode on that read
 * and no §14 measurement, so it is not a row here. `mavlink-move.html`'s
 * `action` validator reds the combination at deploy.
 */
const MODES = {
  position: { position: true },
  velocity: { velocity: true },
  'position-velocity': { position: true, velocity: true },
  acceleration: { accel: true },
  'velocity-acceleration': { velocity: true, accel: true },
  'position-velocity-acceleration': { position: true, velocity: true, accel: true },
  'yaw-only': {},
};

/**
 * Shared boot clock for `time_boot_ms` (uint32, sender's ms since boot) —
 * "boot" for this sender is process start, which is `performance.now()`'s
 * time origin. Monotonic on purpose: `Date.now()` steps with NTP adjustments,
 * and a clock that can run backward breaks the jitter estimation consumers
 * hang on this field. Stream ticks and the synthesized brake packet stamp
 * fresh at send time; a stamp frozen at build would claim every tick of a
 * 4 Hz stream left at the same instant. The `>>> 0` wrap after ~49.7 days is
 * the field's own uint32 wrap.
 *
 * This stamp is the sender's, never operator intent — there is no value the
 * caller failed to give us.
 */
const bootNow = () => Math.floor(performance.now()) >>> 0;

/**
 * Operator-facing degrees to the wire's radians — the yaw twin of the
 * altitude sign flip: converted exactly once, at encode. NaN passes through,
 * because NaN floats are legal MAVLink.
 *
 * @param {*} value  degrees
 * @returns {number} radians
 */
function degreesToRadians(value) {
  return Number(value) * (Math.PI / 180);
}

module.exports = {
  MAV_FRAME,
  GLOBAL_FRAMES,
  MODES,
  bootNow,
  degreesToRadians,
};
