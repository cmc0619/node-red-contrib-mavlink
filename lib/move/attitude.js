'use strict';

const { isBlank } = require('../addressing/resolve');
const { degreesToRadians, bootNow } = require('./frames');

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
 * One optional SET_ATTITUDE_TARGET field, resolved to the two things the wire
 * needs at once: the bytes to write, and this field's ignore bit.
 *
 * They are returned together because they must never disagree: a blank means
 * no value, an ignore bit set, and 0 written into bytes that are sent whether
 * or not anyone reads them. The 0 is not a substitution — it is legal
 * *because* the bit is set, and the bit is set right here.
 *
 * @param {*} value
 * @param {number} ignoreBit  this field's *_IGNORE bit
 * @param {function(*): number} [convert]  wire conversion, where there is one
 * @returns {{value: number, mask: number}}
 */
function optional(value, ignoreBit, convert) {
  if (isBlank(value)) return { value: 0, mask: ignoreBit };
  return { value: convert ? convert(value) : Number(value), mask: 0 };
}

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
  // Each of these has its own ignore bit, so a blank one really is "not
  // commanded" — unlike the three attitude angles, which share a single bit and
  // so share a single answer (below).
  const rollRate = optional(input.rollRate, MASK.BODY_ROLL_RATE_IGNORE, degreesToRadians);
  const pitchRate = optional(input.pitchRate, MASK.BODY_PITCH_RATE_IGNORE, degreesToRadians);
  const yawRate = optional(input.yawRate, MASK.BODY_YAW_RATE_IGNORE, degreesToRadians);
  // Thrust is already normalised 0..1 — no wire conversion, so no converter.
  const thrust = optional(input.thrust, MASK.THROTTLE_IGNORE);

  // ATTITUDE_IGNORE is one bit over the whole quaternion, so hasAttitude
  // decides whether the group is commanded at all. Ignored, it is the identity
  // quaternion — a real unit quaternion rather than zeros, because the mask
  // says nobody reads it and [0,0,0,0] is not one.
  const attitude = hasAttitude
    ? quaternionFromEuler(
      degreesToRadians(input.roll),
      degreesToRadians(input.pitch),
      degreesToRadians(input.yaw)
    )
    : [1, 0, 0, 0];

  const typeMask = (hasAttitude ? 0 : MASK.ATTITUDE_IGNORE)
    + rollRate.mask + pitchRate.mask + yawRate.mask + thrust.mask;

  return {
    name: 'SET_ATTITUDE_TARGET',
    fields: {
      // The sender's own stamp, not operator intent — the same monotonic clock
      // the setpoint builder uses (./frames.js), not a frozen 0.
      time_boot_ms: isBlank(input.timeBootMs) ? bootNow() : Number(input.timeBootMs),
      target_system: target.sysid,
      target_component: target.compid,
      type_mask: typeMask,
      q: attitude,
      body_roll_rate: rollRate.value,
      body_pitch_rate: pitchRate.value,
      body_yaw_rate: yawRate.value,
      thrust: thrust.value,
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



module.exports = {
  buildAttitudeMessage,
  quaternionFromEuler,
};
