'use strict';

/**
 * Control hints for `MAV_CMD_*` parameters whose backing enum the registry and
 * `.d.ts` cannot recover (DESIGN.md §4, §14).
 *
 * Message-field `enum=` links come back from the shipped `.d.ts` (a field typed
 * with an enum class). Command-*param* `enum=` links do not — the generated
 * declarations keep a param's label/description/units but drop the enum
 * reference. Rather than vendor XML for the handful of params the UI needs as
 * dropdowns, this small explicit table supplies the association. Applied into
 * `commands[cmd].params[i].enum`.
 *
 * Kept deliberately small: only params whose meaning the metadata cannot
 * otherwise express appear here.
 */

/** @type {Object<string, Object<number, string>>} MAV_CMD name -> index -> enum */
const COMMAND_PARAM_ENUMS = {
  MAV_CMD_DO_CHANGE_SPEED: { 1: 'SPEED_TYPE' },
  MAV_CMD_DO_SET_MODE: { 1: 'MAV_MODE' },
  MAV_CMD_DO_SET_ROI: { 1: 'MAV_ROI' },
  MAV_CMD_DO_MOUNT_CONFIGURE: { 1: 'MAV_MOUNT_MODE' },
  MAV_CMD_SET_CAMERA_MODE: { 2: 'CAMERA_MODE' },
  MAV_CMD_NAV_VTOL_TAKEOFF: { 2: 'VTOL_TRANSITION_HEADING' },
  MAV_CMD_DO_REPOSITION: { 5: 'MAV_FRAME' },
  MAV_CMD_IMAGE_START_CAPTURE: {},
};

/**
 * The backing enum name for one command parameter, or null when the table has
 * no hint for it.
 *
 * @param {string} commandName  MAV_CMD_* name
 * @param {number} index  param index (1..7)
 * @returns {string|null}
 */
function paramEnumHint(commandName, index) {
  const byIndex = COMMAND_PARAM_ENUMS[commandName];
  return (byIndex && byIndex[Number(index)]) || null;
}

module.exports = { COMMAND_PARAM_ENUMS, paramEnumHint };
