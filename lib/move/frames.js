'use strict';

/**
 * Move's shared setpoint vocabulary, used by the setpoint builder (./index.js)
 * and the attitude builder (./attitude.js). MAV_FRAME itself is the carrier
 * module's (lib/command/carrier), the one owner of the frame table.
 */

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
  return value * (Math.PI / 180);
}

module.exports = {
  MODES,
  bootNow,
  degreesToRadians,
};
