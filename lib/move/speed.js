'use strict';

const { buildCommandLong } = require('../command/carrier');
const { isBlank } = require('../addressing/resolve');

/**
 * Move's speed carrier: `MAV_CMD_DO_CHANGE_SPEED` (178) as `COMMAND_LONG`.
 *
 * A Move action rather than a Command preset (§9 roster ruling 4): QGC presents
 * change-speed as a fly-view *guided action* beside goto and altitude change,
 * and motion left Command for Move. Unlike Turn this needs no
 * firmware derivation — DO_CHANGE_SPEED is standard across both stacks and
 * every vehicle family that moves.
 */

/** MAV_CMD_DO_CHANGE_SPEED. */
const DO_CHANGE_SPEED = 178;

/**
 * common.xml's own "no change" for param2 and param3. Named because they are
 * the dialect's vocabulary, not a default we chose: a blank box has to reach
 * the wire as *something*, and this is the only encoding that means the
 * operator left the parameter alone (−2, *return to default*, is a different
 * instruction the operator reaches by typing it).
 */
const SPEED_UNCHANGED = -1;
const THROTTLE_UNCHANGED = -1;

/**
 * SPEED_TYPE, from the shipped dialect. Airspeed vs groundspeed is the choice
 * that matters on a plane and is meaningless on a copter, which is why it is an
 * operator field rather than something derived: the vehicle knows what it can
 * honour, and the driver does not editorialise about it (§9).
 *
 * @param {*} value  'airspeed' | 'groundspeed' | 'climb' | 'descent'
 * @returns {number} the dialect's SPEED_TYPE value; NaN for a non-member
 */
function speedTypeValue(value) {
  switch (value) {
    case 'airspeed': return 0;
    case 'groundspeed': return 1;
    case 'climb': return 2;
    case 'descent': return 3;
    default: break; // This space intentionally left blank (§5)
  }
  return NaN; // nothing matched: no behavior selected (§5)
}

/**
 * Build the COMMAND_LONG / DO_CHANGE_SPEED message.
 *
 * Blank params encode the dialect's documented sentinels, the same
 * `blankParams` convention as the command presets and the reposition carrier:
 * blank speed → −1 (*no change*), blank throttle → −1 (*no change*). Both also
 * define −2 as *return to default*, which an operator reaches by typing it —
 * it is a real value on this wire, not a sentinel we own.
 *
 * `speedType` resolves through the affirmative speedTypeValue dispatch.
 * DO_CHANGE_SPEED param1 has no dialect "unchanged" encoding the way param2
 * (speed) has −1, so there is no sentinel to spend on a token that is not a
 * member — the editor's select is what keeps one from being saved, and a
 * non-member rides as NaN, the float wire's word for not-used.
 *
 * @param {object} input
 * @param {*} [input.speed]      m/s; blank = no change (−1)
 * @param {*} [input.throttle]   %; blank = no change (−1)
 * @param {*} [input.speedType]  'airspeed' | 'groundspeed' | 'climb' | 'descent'
 * @param {{sysid: number, compid: number}} input.target
 * @returns {{name: 'COMMAND_LONG', fields: object}}
 */
function buildSpeedMessage(input) {
  const target = input.target;
  // -1 is common.xml's own "no change" for both params, so a blank box is
  // transmitted as the wire's word for unset rather than as a value we picked:
  // the operator changing groundspeed alone leaves throttle alone, and there is
  // no other way to say that on DO_CHANGE_SPEED.
  const speed = isBlank(input.speed) ? SPEED_UNCHANGED : Number(input.speed);
  const throttle = isBlank(input.throttle) ? THROTTLE_UNCHANGED : Number(input.throttle);

  return buildCommandLong(
    DO_CHANGE_SPEED,
    target.sysid,
    target.compid,
    [speedTypeValue(input.speedType), speed, throttle, 0, 0, 0, 0],
    0
  );
}




module.exports = {
  buildSpeedMessage,
};
