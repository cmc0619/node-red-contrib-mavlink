'use strict';

const { buildCommandLong } = require('../command');
const { isBlank } = require('../addressing/resolve');
const { requireNumber } = require('./frames');

/**
 * Move's heading carrier: `MAV_CMD_CONDITION_YAW` (115) as `COMMAND_LONG`.
 *
 * This exists because **ArduPilot has no other working yaw** (§14,
 * 2026-08-13). Both of the yaw fields Move already had are inert on ArduCopter,
 * and each was established separately: `DO_REPOSITION`'s `param4` is ignored
 * outright (`set_destination(..., use_yaw=false)`, source-read 2026-08-12), and
 * a yaw-only setpoint stream measured as *heading held*, not turned (mask 2559,
 * SITL 2026-08-08 / #179). ArduPilot's own autotest yaws in guided through this
 * command (`guided_achieve_heading`), and Copter and Sub both carry handlers.
 *
 * PX4 has no `CONDITION_YAW` handler — and the runtime says nothing about that.
 * It is a legal message the vehicle will not act on, which §9 names explicitly
 * as a combo that *sends*: the driver does not editorialise about what a
 * vehicle does with a well-formed message, and PX4's own NAK is better feedback
 * than a refusal we invent. The dialog is where an operator is told (the
 * `action` validator reds Turn on a non-ArduPilot profile, naming Steer's yaw
 * field as the path that works there).
 *
 * This is deliberately *unlike* `frameForReference`'s body arm, which does
 * throw. That one has no answer to give — the two stacks read different frame
 * numbers, so no message can be built. Here the message is fully determined;
 * only the vehicle's appetite for it varies.
 */

/** MAV_CMD_CONDITION_YAW. */
const CONDITION_YAW = 115;

/**
 * common.xml's no-change values for param2 and param3: 0 rate is *the vehicle's
 * default turn rate*, 0 direction is *shortest direction*. The dialect defines
 * both, so a blank box reaches the wire as the wire's own word for "operator
 * did not choose" — unlike heading, which has no such word.
 */
const RATE_DEFAULT = 0;
const DIRECTION_SHORTEST = 0;

/**
 * Build the COMMAND_LONG / CONDITION_YAW message.
 *
 * Blank params encode the dialect's own no-change values, the `blankParams`
 * convention shared with the command presets: blank rate → 0 (the vehicle's
 * default turn rate), blank direction → 0, which common.xml defines as
 * *"shortest direction"* rather than leaving it undefined.
 *
 * Nothing here range-checks `heading`. ArduCopter answers `MAV_RESULT_FAILED`
 * for a heading outside 0–360 or a `relative` that is not exactly 0 or 1
 * (source-read 2026-08-13), so the vehicle judges it and the *editor* is what
 * keeps an operator from sending it — the driver coerces and sends (§2).
 * `relative` is a strict boolean opt-in for the same reason `changeMode` is:
 * it changes what the number means, so a truthy token must refuse rather than
 * silently pick absolute.
 *
 * @param {object} input
 * @param {number} input.heading   degrees; absolute 0 = north, or a relative offset
 * @param {*} [input.rate]         deg/s, blank = vehicle default
 * @param {*} [input.direction]    -1 ccw, 0 shortest, 1 cw
 * @param {boolean} [input.relative]  true = offset from current heading
 * @param {{sysid: number, compid: number}} input.target
 * @returns {{name: 'COMMAND_LONG', fields: object}}
 */
function buildTurnMessage(input) {
  if (input.relative !== undefined && typeof input.relative !== 'boolean') {
    throw new Error(
      `Move turn relative must be boolean true or false, got ${JSON.stringify(input.relative)}`
    );
  }

  const target = input.target;
  // Heading has no no-change encoding — it IS the command, and a blank one used
  // to fall to 0, which is a legal heading the vehicle turns to. North on a lost
  // field is the altRef failure one command over: a clean ACCEPTED for the wrong
  // thing (owner ruling, 2026-08-14). Rate and direction do have dialect
  // sentinels, and 0 is what common.xml gives them.
  const heading = requireNumber(input.heading, 'a heading');
  const rate = isBlank(input.rate) ? RATE_DEFAULT : requireNumber(input.rate, 'turn rate');
  const direction = isBlank(input.direction)
    ? DIRECTION_SHORTEST
    : requireNumber(input.direction, 'turn direction');

  return buildCommandLong(
    CONDITION_YAW,
    target.sysid,
    target.compid,
    [heading, rate, direction, input.relative === true ? 1 : 0, 0, 0, 0],
    0
  );
}


module.exports = {
  CONDITION_YAW,
  buildTurnMessage,
};
