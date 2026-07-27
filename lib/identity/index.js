'use strict';

/**
 * Local Identity helpers (DESIGN.md §7, §13).
 */

const { ROLE_PRESETS, normalizeRole, rolePreset } = require('./presets');
const { resolveIdentity, parseIdentityUint8 } = require('./resolve');
const { heartbeatFields } = require('./heartbeat');
const { bindVehicleSysid, releaseVehicleSysid, applyVehicleSysid } = require('./bind');

module.exports = {
  ROLE_PRESETS,
  normalizeRole,
  rolePreset,
  resolveIdentity,
  parseIdentityUint8,
  heartbeatFields,
  bindVehicleSysid,
  releaseVehicleSysid,
  applyVehicleSysid,
};
