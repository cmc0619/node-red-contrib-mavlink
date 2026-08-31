'use strict';

/**
 * Local Identity role presets (DESIGN.md §7).
 *
 * Ground station suggests 255/190 and a MAV_TYPE_GCS heartbeat. Companion locks
 * sysid to the vehicle's (derived at Connection bind) and offers component 191
 * with MAV_TYPE_ONBOARD_CONTROLLER. Custom is the unopinionated escape hatch.
 *
 * Heartbeat autopilot is MAV_AUTOPILOT_INVALID for GCS and companion — the
 * autopilot field is only meaningful for flight controllers (§7 Heartbeat).
 */

/** @typedef {'gcs'|'companion'|'custom'} IdentityRole */

/**
 * @typedef {object} RolePreset
 * @property {number|null} sysid  suggested source sysid; null when derived
 * @property {number} compid  suggested source component id
 * @property {boolean} derivesSysidFromVehicle
 * @property {string} heartbeatType  MAV_TYPE_* screaming name
 * @property {string} heartbeatAutopilot  MAV_AUTOPILOT_* screaming name
 */

/** @type {Object<IdentityRole, RolePreset>} */
const ROLE_PRESETS = {
  gcs: {
    sysid: 255,
    compid: 190,
    derivesSysidFromVehicle: false,
    heartbeatType: 'MAV_TYPE_GCS',
    heartbeatAutopilot: 'MAV_AUTOPILOT_INVALID',
  },
  companion: {
    sysid: null,
    compid: 191,
    derivesSysidFromVehicle: true,
    heartbeatType: 'MAV_TYPE_ONBOARD_CONTROLLER',
    heartbeatAutopilot: 'MAV_AUTOPILOT_INVALID',
  },
  custom: {
    sysid: 255,
    compid: 190,
    derivesSysidFromVehicle: false,
    heartbeatType: 'MAV_TYPE_GENERIC',
    heartbeatAutopilot: 'MAV_AUTOPILOT_INVALID',
  },
};

module.exports = { ROLE_PRESETS };
