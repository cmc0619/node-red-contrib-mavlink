'use strict';

const { isBlank } = require('../addressing/resolve');

/**
 * Move's attitude carrier: `SET_ATTITUDE_TARGET` (82).
 *
 * On the roster as MAVSDK's Offboard attitude and attitude-rate modes (§9).
 * It fits Move almost exactly — same addressing, and its `type_mask` works the
 * way Steer's does, so "filling fields IS the mode" transfers intact: fill an
 * attitude and the ATTITUDE_IGNORE bit clears, fill a body rate and that rate's
 * bit clears, fill thrust and THROTTLE_IGNORE clears.
 *
 * It needs a typed surface more than position does. The wire carries a
 * quaternion; an operator thinks in roll/pitch/yaw degrees. Building `q[4]`
 * here is the same convert-exactly-once-at-encode rule as degE7 and radians —
 * in `mavlink-build` you would be entering quaternion components by hand.
 *
 * **Ending a stream of these is ceasing to transmit, never a brake packet**
 * (§9 ruling 1). Steer's zero-velocity brake has no analogue here: zero thrust
 * is not a brake, it is a descent. Both stacks carry their own offboard
 * watchdog, and MAVSDK's extra stop-then-Hold is a mode change, which is
 * opt-in territory under the `changeMode` precedent. The node therefore never
 * synthesizes a final attitude message.
 */

/** ATTITUDE_TARGET_TYPEMASK, from the shipped dialect. */
const MASK = {
  BODY_ROLL_RATE_IGNORE: 1,
  BODY_PITCH_RATE_IGNORE: 2,
  BODY_YAW_RATE_IGNORE: 4,
  THROTTLE_IGNORE: 64,
  ATTITUDE_IGNORE: 128,
};

/**
 * Build the SET_ATTITUDE_TARGET message.
 *
 * Presence drives the mask, exactly like the setpoint carrier: a blank group is
 * mask-ignored, and a value — including 0 — is commanded. A blank attitude
 * still encodes the identity quaternion, because the field is four floats that
 * must hold *something*; the ATTITUDE_IGNORE bit is what makes the vehicle
 * disregard it, which is why the bit and not the value is the contract.
 *
 * @param {object} input
 * @param {*} [input.roll]       degrees
 * @param {*} [input.pitch]      degrees
 * @param {*} [input.yaw]        degrees
 * @param {*} [input.rollRate]   deg/s
 * @param {*} [input.pitchRate]  deg/s
 * @param {*} [input.yawRate]    deg/s
 * @param {*} [input.thrust]     0..1
 * @param {*} [input.timeBootMs]
 * @param {{sysid: number, compid: number}} input.target
 * @returns {{name: 'SET_ATTITUDE_TARGET', fields: object}}
 */
function buildAttitudeMessage(input) {
  const target = input.target;
  const hasAttitude = !isBlank(input.roll) || !isBlank(input.pitch) || !isBlank(input.yaw);
  const rollRate = isBlank(input.rollRate) ? undefined : numberOrThrow(input.rollRate, 'rollRate');
  const pitchRate = isBlank(input.pitchRate) ? undefined : numberOrThrow(input.pitchRate, 'pitchRate');
  const yawRate = isBlank(input.yawRate) ? undefined : numberOrThrow(input.yawRate, 'yawRate');
  const thrust = isBlank(input.thrust) ? undefined : numberOrThrow(input.thrust, 'thrust');

  let typeMask = 0;
  if (!hasAttitude) typeMask += MASK.ATTITUDE_IGNORE;
  if (rollRate === undefined) typeMask += MASK.BODY_ROLL_RATE_IGNORE;
  if (pitchRate === undefined) typeMask += MASK.BODY_PITCH_RATE_IGNORE;
  if (yawRate === undefined) typeMask += MASK.BODY_YAW_RATE_IGNORE;
  if (thrust === undefined) typeMask += MASK.THROTTLE_IGNORE;

  return {
    name: 'SET_ATTITUDE_TARGET',
    fields: {
      time_boot_ms: isBlank(input.timeBootMs) ? 0 : numberOrThrow(input.timeBootMs, 'timeBootMs'),
      target_system: target.sysid,
      target_component: target.compid,
      type_mask: typeMask,
      // A partially filled attitude is not an error: an operator commanding
      // roll alone means pitch and yaw zero, which is what the quaternion says.
      // The group is what the mask gates, not the individual axis.
      q: quaternionFromEuler(
        degreesToRadians(input.roll),
        degreesToRadians(input.pitch),
        degreesToRadians(input.yaw)
      ),
      body_roll_rate: degreesToRadians(rollRate),
      body_pitch_rate: degreesToRadians(pitchRate),
      body_yaw_rate: degreesToRadians(yawRate),
      thrust: thrust === undefined ? 0 : thrust,
    },
  };
}

/**
 * Euler (radians, roll-pitch-yaw / ZYX) to the wire's `q[4]` as [w, x, y, z] —
 * MAVLink's quaternion field order and rotation convention.
 *
 * @param {number} roll
 * @param {number} pitch
 * @param {number} yaw
 * @returns {number[]}
 */
function quaternionFromEuler(roll, pitch, yaw) {
  const cr = Math.cos(roll / 2);
  const sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ];
}

/**
 * Operator degrees to the wire's radians — blank is 0, the same treatment the
 * setpoint carrier gives a mask-ignored angle.
 *
 * @param {*} value
 * @returns {number}
 */
function degreesToRadians(value) {
  if (isBlank(value) || value === undefined) return 0;
  return numberOrThrow(value, 'angle') * (Math.PI / 180);
}

/**
 * @param {*} value
 * @param {string} name
 * @returns {number}
 */
function numberOrThrow(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Move attitude ${name} expected a finite number, got ${JSON.stringify(value)}`);
  }
  return n;
}

module.exports = {
  MASK,
  buildAttitudeMessage,
  quaternionFromEuler,
};
