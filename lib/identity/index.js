'use strict';

/**
 * Local Identity helpers (DESIGN.md §7, §13).
 */

const { ROLE_PRESETS, rolePreset } = require('./presets');
const { resolveIdentity } = require('./resolve');
const { heartbeatFields } = require('./heartbeat');
const { bindVehicleSysid, releaseVehicleSysid, applyVehicleSysid } = require('./bind');

module.exports = {
  ROLE_PRESETS,
  rolePreset,
  resolveIdentity,
  heartbeatFields,
  bindVehicleSysid,
  releaseVehicleSysid,
  applyVehicleSysid,
};
