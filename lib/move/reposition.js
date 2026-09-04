'use strict';

const { buildCommandInt } = require('../command');
const { isBlank } = require('../addressing/resolve');
const { degreesToRadians } = require('./frames');

/**
 * Move's reposition carrier (#239): the guided goto every reference
 * implementation converges on — MAV_CMD_DO_REPOSITION (192) sent as
 * COMMAND_INT, the only reposition command ArduPilot accepts (and only on
 * that carrier). Same node and same frame vocabulary as the setpoint carrier
 * — with the one thing no setpoint offers: a COMMAND_ACK.
 */

/** MAV_CMD_DO_REPOSITION. */
const DO_REPOSITION = 192;

/** MAV_DO_REPOSITION_FLAGS_CHANGE_MODE: transition into guided immediately. */
const REPOSITION_FLAG_CHANGE_MODE = 1;

/**
 * common.xml's no-change values for param1 and param3 — *ground speed, -1 for
 * default* and *loiter radius, 0 to ignore*. The dialect's own vocabulary for
 * "the operator did not choose", so a blank box is transmitted rather than
 * filled in. The coordinate triplet has no equivalent and refuses instead.
 */
const SPEED_DEFAULT = -1;
const RADIUS_IGNORED = 0;

/**
 * Build the COMMAND_INT / DO_REPOSITION message for Move's reposition carrier.
 *
 * Input speaks Move's vocabulary — a numeric frame, degrees, up-positive
 * altitude. Blank params encode the spec's no-change sentinels, the same
 * convention as the command presets (lib/command/presets.js `blankParams`,
 * #240): blank speed → −1 (vehicle default), blank radius → 0 (ignored),
 * blank yaw → NaN (current heading mode; an explicit 0 commands north). The
 * dialect declares param4 in radians (unlike NAV_WAYPOINT's degrees — MAVSDK
 * converts too), so the operator's degrees convert exactly once here; NaN
 * survives the scale. Lat/lon enter in degrees and scale to degE7 by frame in
 * the shared COMMAND_INT builder; alt rides `z` as an unscaled float.
 *
 * @param {object} input
 * @returns {{name: 'COMMAND_INT', fields: object}}
 */
function buildRepositionMessage(input) {
  const p = input.position;
  const target = input.target;
  const speed = isBlank(input.speed) ? SPEED_DEFAULT : Number(input.speed);
  const radius = isBlank(input.radius) ? RADIUS_IGNORED : Number(input.radius);
  const yaw = isBlank(input.yaw) ? NaN : degreesToRadians(input.yaw);
  const flags = input.changeMode ? REPOSITION_FLAG_CHANGE_MODE : 0;

  return buildCommandInt(
    DO_REPOSITION,
    target.sysid,
    target.compid,
    [speed, flags, radius, yaw, p.lat, p.lon, p.alt],
    // Pass frame through — do not Number() first: Number('') is GLOBAL (0).
    // longToIntFields leaves blank unset (§0).
    { frame: input.frame }
  );
}

module.exports = {
  DO_REPOSITION,
  REPOSITION_FLAG_CHANGE_MODE,
  buildRepositionMessage,
};
