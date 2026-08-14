'use strict';

const { buildCommandLong } = require('../command');
const { numberOr } = require('./frames');

/**
 * Move's speed carrier: `MAV_CMD_DO_CHANGE_SPEED` (178) as `COMMAND_LONG`.
 *
 * A Move action rather than a Command preset (§9 roster ruling 4): QGC presents
 * change-speed as a fly-view *guided action* beside goto and altitude change,
 * and #277 already moved motion out of Command. Unlike Turn this needs no
 * firmware derivation — DO_CHANGE_SPEED is standard across both stacks and
 * every vehicle family that moves.
 */

/** MAV_CMD_DO_CHANGE_SPEED. */
const DO_CHANGE_SPEED = 178;

/**
 * SPEED_TYPE, from the shipped dialect. Airspeed vs groundspeed is the choice
 * that matters on a plane and is meaningless on a copter, which is why it is an
 * operator field rather than something derived: the vehicle knows what it can
 * honour, and the driver does not editorialise about it (§9).
 */
const SPEED_TYPE = {
  airspeed: 0,
  groundspeed: 1,
  climb: 2,
  descent: 3,
};

/**
 * Build the COMMAND_LONG / DO_CHANGE_SPEED message.
 *
 * Blank params encode the dialect's documented sentinels, the same
 * `blankParams` convention as the command presets and the reposition carrier:
 * blank speed → −1 (*no change*), blank throttle → −1 (*no change*). Both also
 * define −2 as *return to default*, which an operator reaches by typing it —
 * it is a real value on this wire, not a sentinel we own.
 *
 * A blank speed type resolves to groundspeed: it is the reading that means
 * something on every family, where airspeed is a fixed-wing concept. Total by
 * construction like `frameForAltRef` — an unrecognised token coerces rather
 * than throwing, because there is a defined answer to give.
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
  // Shared blank-or-finite conversion (./frames.js `numberOr`): blank takes the
  // dialect's -1 "no change" sentinel, non-numeric throws.
  const speed = numberOr(input.speed, -1);
  const throttle = numberOr(input.throttle, -1);
  const type = Object.prototype.hasOwnProperty.call(SPEED_TYPE, input.speedType)
    ? SPEED_TYPE[input.speedType]
    : SPEED_TYPE.groundspeed;

  return buildCommandLong(
    DO_CHANGE_SPEED,
    target.sysid,
    target.compid,
    [type, speed, throttle, 0, 0, 0, 0],
    0
  );
}


module.exports = {
  DO_CHANGE_SPEED,
  SPEED_TYPE,
  buildSpeedMessage,
};
