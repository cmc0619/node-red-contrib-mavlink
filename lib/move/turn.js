'use strict';

const { buildCommandLong } = require('../command');
const { numberOr } = require('./frames');

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
 * PX4 has no `CONDITION_YAW` handler, so Turn is firmware-derived and fails
 * closed there — the same class of refusal as `frameForReference`'s body arm:
 * not input-vetting, simply no right answer to give. The error names the escape
 * that does work on PX4, which is Steer's own yaw field (measured honoured
 * there, where ArduPilot merely holds heading).
 */

/** MAV_CMD_CONDITION_YAW. */
const CONDITION_YAW = 115;

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
 * @param {*} input.firmware       vehicle profile firmware
 * @param {{sysid: number, compid: number}} input.target
 * @returns {{name: 'COMMAND_LONG', fields: object}}
 */
function buildTurnMessage(input) {
  if (input.firmware !== 'ardupilot') {
    throw new Error(
      'Move turn needs a Vehicle Profile with firmware ardupilot — CONDITION_YAW is an ' +
      'ArduPilot command and PX4 has no handler for it (§14). On PX4, yaw with a Steer ' +
      'setpoint: its yaw field is honoured there'
    );
  }
  if (input.relative !== undefined && typeof input.relative !== 'boolean') {
    throw new Error(
      `Move turn relative must be boolean true or false, got ${JSON.stringify(input.relative)}`
    );
  }

  // numberOr is the shared blank-or-finite conversion (./frames.js): blank
  // takes the fallback, anything non-numeric throws. A blank heading falls to
  // 0 = north, which is what the editor's required-field rule already prevents
  // reaching from a dialog.
  const target = input.target;
  const heading = numberOr(input.heading, 0);
  const rate = numberOr(input.rate, 0);
  const direction = numberOr(input.direction, 0);

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
