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

/**
 * Role membership (§14 selection-typo cluster). `custom` is the escape hatch
 * an operator *chooses*, not where a typo lands: an unknown token used to
 * silently become the custom preset and put a MAV_TYPE_GENERIC heartbeat on
 * the wire in place of the GCS or companion identity the flow meant. The
 * editor's role select always saves a member, so a non-member is hand-edit
 * damage and throws naming the vocabulary — at construction, the same
 * boundary the heartbeat-interval guard already refuses at (this node has no
 * inputs; deploy is its only door).
 *
 * @param {string} role
 * @returns {IdentityRole}
 */
function normalizeRole(role) {
  if (Object.prototype.hasOwnProperty.call(ROLE_PRESETS, role)) return role;
  throw new Error(
    `unknown Local Identity role ${JSON.stringify(role)} — expected one of ${Object.keys(ROLE_PRESETS).join(', ')}`
  );
}

/**
 * @param {IdentityRole|string} role
 * @returns {RolePreset}
 */
function rolePreset(role) {
  return ROLE_PRESETS[normalizeRole(role)];
}

module.exports = { ROLE_PRESETS, normalizeRole, rolePreset };
