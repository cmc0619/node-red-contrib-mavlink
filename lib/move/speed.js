'use strict';

const { buildCommandLong } = require('../command');
const { isBlank } = require('../addressing/resolve');
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
 * something on every family, where airspeed is a fixed-wing concept. An
 * *unrecognised* token is a different thing and **throws** (owner ruling,
 * 2026-08-14: *"if a flow sends nonsense then it deserves to fail"*). This
 * used to coerce to groundspeed, which silently answered a question nobody
 * asked: `msg.payload.speedType` overrides the editor-validated config, so a
 * typo'd `'airsped'` became a groundspeed command with nothing to say so.
 *
 * That is not the trusted-`msg` rule bending. A number off `msg` is taken as
 * given because every number is a legal value; an enum token that is not in
 * the enum has no meaning at all, so there is no safe default to coerce
 * *to* — which is the refusal arm of the coerce-vs-refuse test, and the same
 * answer `resolveMoveAction` already gives an unknown action.
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
  const type = speedTypeValue(input.speedType);

  return buildCommandLong(
    DO_CHANGE_SPEED,
    target.sysid,
    target.compid,
    [type, speed, throttle, 0, 0, 0, 0],
    0
  );
}


/**
 * SPEED_TYPE token → wire value. Blank is the documented sentinel; anything
 * else must be in the enum.
 *
 * @param {*} value
 * @returns {number}
 */
function speedTypeValue(value) {
  if (isBlank(value)) return SPEED_TYPE.groundspeed;
  if (Object.prototype.hasOwnProperty.call(SPEED_TYPE, value)) return SPEED_TYPE[value];
  throw new Error(
    `unknown Move speed type ${JSON.stringify(value)} — expected one of `
    + `${Object.keys(SPEED_TYPE).join(', ')}`
  );
}


module.exports = {
  DO_CHANGE_SPEED,
  SPEED_TYPE,
  buildSpeedMessage,
};
