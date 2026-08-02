'use strict';

/**
 * Firmware string ↔ MAV_AUTOPILOT wire code (DESIGN.md §7 HEARTBEAT binding).
 * One table, both directions — Connection binds firmware→code; Swarm maps
 * peer autopilot→firmware.
 */

const AUTOPILOT_BY_FIRMWARE = {
  ardupilot: 3, // MAV_AUTOPILOT_ARDUPILOTMEGA
  px4: 12, // MAV_AUTOPILOT_PX4
};

const FIRMWARE_BY_AUTOPILOT = Object.fromEntries(
  Object.entries(AUTOPILOT_BY_FIRMWARE).map(([firmware, code]) => [code, firmware])
);

/**
 * @param {string} firmware
 * @returns {number|null}
 */
function autopilotForFirmware(firmware) {
  return AUTOPILOT_BY_FIRMWARE[firmware] || null;
}

/**
 * @param {number} autopilot
 * @returns {string|null}
 */
function firmwareForAutopilot(autopilot) {
  return FIRMWARE_BY_AUTOPILOT[autopilot] || null;
}

module.exports = { autopilotForFirmware, firmwareForAutopilot };
