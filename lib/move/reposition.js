'use strict';

const { buildCommandInt } = require('../command');
const { isBlank } = require('../addressing/resolve');
const {
  MAV_FRAME,
  resolveModeAndFrame,
  requireNumber,
  degreesToRadians,
} = require('./frames');

/**
 * Move's reposition carrier (#239): the guided goto every reference
 * implementation converges on — MAV_CMD_DO_REPOSITION (192) sent as
 * COMMAND_INT, the only reposition command ArduPilot accepts (and only on
 * that carrier). Same node, same mode/frame vocabulary, same coordinate
 * guards as the setpoint carrier — with the one thing no setpoint offers:
 * a COMMAND_ACK.
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
 * Frames DO_REPOSITION rides: COMMAND_INT's own frame field wants the
 * spec-current numbers, so GLOBAL (0) and GLOBAL_RELATIVE_ALT (3) only — no
 * *_INT twin question on this carrier. LOCAL frames refuse (ArduPilot denied
 * LOCAL in the SITL 18 frame matrix; one vocabulary per carrier keeps the
 * surface honest) and terrain is unmeasured, so it refuses too — fail closed.
 */
const REPOSITION_FRAMES = new Set([MAV_FRAME.GLOBAL, MAV_FRAME.GLOBAL_RELATIVE_ALT]);

/**
 * Build the COMMAND_INT / DO_REPOSITION message for Move's reposition carrier.
 *
 * Input speaks Move's vocabulary — mode/frame names, degrees, up-positive
 * altitude — and the refusal matrix is fail-closed named errors: setpoint-only
 * modes, non-global frames, and yaw rate all refuse rather than degrade.
 * Blank params encode the spec's no-change sentinels, the same convention as
 * the command presets (lib/command/presets.js `blankParams`, #240): blank
 * speed → −1 (vehicle default), blank radius → 0 (ignored), blank yaw → NaN
 * (current heading mode; an explicit 0 commands north). The dialect declares
 * param4 in radians (unlike NAV_WAYPOINT's degrees — MAVSDK converts too), so
 * the operator's degrees convert exactly once here; NaN survives the scale.
 * Lat/lon enter in degrees and scale to degE7 by frame in the shared
 * COMMAND_INT builder; alt rides `z` as an unscaled float.
 *
 * @param {object} input
 * @returns {{name: 'COMMAND_INT', fields: object}}
 */
function buildRepositionMessage(input) {
  const { mode, frame } = resolveModeAndFrame(input);
  if (mode !== 'position') {
    throw new Error(
      `Move reposition is position-only — mode ${JSON.stringify(mode)} is a setpoint mode; use the setpoint carrier`
    );
  }
  if (!REPOSITION_FRAMES.has(frame)) {
    const name = Object.keys(MAV_FRAME).find((k) => MAV_FRAME[k] === frame);
    throw new Error(
      `Move reposition supports frames GLOBAL and GLOBAL_RELATIVE_ALT — ${name} (${frame}) refuses on this carrier`
    );
  }
  if (!isBlank(input.yawRate)) {
    throw new Error('Move reposition has no yaw rate — DO_REPOSITION carries a yaw heading only; use the setpoint carrier');
  }
  if (input.changeMode !== undefined && typeof input.changeMode !== 'boolean') {
    // CHANGE_MODE flies the vehicle into guided — an explicit opt-in, so a
    // truthy token ("yes", 1) must refuse rather than silently drop the flag.
    throw new Error(
      `Move reposition changeMode must be boolean true or false, got ${JSON.stringify(input.changeMode)}`
    );
  }

  const p = input.position || {};
  const target = input.target;
  const speed = isBlank(input.speed) ? SPEED_DEFAULT : requireNumber(input.speed, 'goto speed');
  const radius = isBlank(input.radius)
    ? RADIUS_IGNORED
    : requireNumber(input.radius, 'loiter radius');
  const yaw = isBlank(input.yaw) ? NaN : degreesToRadians(requireNumber(input.yaw, 'goto yaw'));
  const flags = input.changeMode === true ? REPOSITION_FLAG_CHANGE_MODE : 0;

  return buildCommandInt(
    DO_REPOSITION,
    target.sysid,
    target.compid,
    // The coordinate triplet is the goto. A blank used to encode 0 — null
    // island, a real place the vehicle will fly to with a clean ACCEPTED — and
    // DO_REPOSITION has no sentinel that means "keep the current position", so
    // there is nothing honest to send for a coordinate nobody gave.
    [
      speed,
      flags,
      radius,
      yaw,
      requireNumber(p.lat, 'a latitude'),
      requireNumber(p.lon, 'a longitude'),
      requireNumber(p.alt, 'an altitude'),
    ],
    { frame }
  );
}

module.exports = {
  DO_REPOSITION,
  REPOSITION_FLAG_CHANGE_MODE,
  buildRepositionMessage,
};
