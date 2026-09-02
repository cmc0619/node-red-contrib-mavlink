'use strict';

/**
 * MAV_AUTOPILOT wire code → firmware string (DESIGN.md §7 HEARTBEAT binding).
 * Fan-out maps a peer's declared autopilot to a firmware label.
 */

const FIRMWARE_BY_AUTOPILOT = {
  3: 'ardupilot', // MAV_AUTOPILOT_ARDUPILOTMEGA
  12: 'px4', // MAV_AUTOPILOT_PX4
};

/**
 * @param {number} autopilot
 * @returns {string|undefined}
 */
function firmwareForAutopilot(autopilot) {
  return FIRMWARE_BY_AUTOPILOT[autopilot];
}

module.exports = { firmwareForAutopilot };
