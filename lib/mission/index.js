'use strict';

/**
 * mavlink-mission library (DESIGN.md §3, §9 "Mission protocol", §12 step 7).
 *
 * Three state machines over one item-transfer protocol — the only place in the
 * package where the vehicle drives the conversation. All logic lives here; the
 * `mavlink-mission` node is a thin wrapper that reads config, resolves the
 * connection/target/firmware, runs a machine, and shapes the two-output chain
 * (§2 "Nodes stay thin").
 *
 * Public surface consumed by nodes/mavlink-mission.js:
 *
 *   - {@link createMachine} — build the machine for an operation
 *   - {@link MissionDownload} / {@link MissionUpload} / {@link MissionClear}
 *   - {@link validateItems} and the per-family validators (§9)
 *   - {@link locks} — transfer lock per (conn, target, type)
 *   - {@link supportedMissionTypes} — firmware gate (§11)
 *   - {@link missionTypeValue} / {@link MISSION_TYPE} / {@link OPERATION}
 *   - {@link MAV_MISSION_RESULT} / {@link missionResultName}
 *   - the item/control message builders (for the Build tier plan)
 */

const types = require('./types');
const items = require('./items');
const validate = require('./validate');
const { LockRegistry } = require('../delivery/lock');
const { MissionTransfer } = require('./transfer');
const { MissionDownload } = require('./download');
const { MissionUpload } = require('./upload');
const { MissionClear } = require('./clear');

/**
 * Process-wide mission-transfer lock used by the mavlink-mission node, keyed
 * by `(connection, target, mission_type)` — the mission type is the
 * {@link LockRegistry} scope: a fence upload and a fence download conflict,
 * a fence upload and a mission download run concurrently (§9).
 */
const locks = new LockRegistry();

/**
 * Construct the transfer machine for an operation. The returned object exposes
 * `start()` → Promise<TransferOutcome> and `cancel()` (node close).
 *
 * @param {string} operation  one of {@link OPERATION}
 * @param {object} opts  machine options (see {@link MissionTransfer}); for
 *   upload, `opts.items` is the canonical item array.
 * @returns {MissionTransfer}
 */
function createMachine(operation, opts) {
  switch (operation) {
    case types.OPERATION.DOWNLOAD:
      return new MissionDownload(opts);
    case types.OPERATION.UPLOAD:
      return new MissionUpload(opts);
    case types.OPERATION.CLEAR:
      return new MissionClear(opts);
    default:
      throw new Error(`unknown mission operation ${JSON.stringify(operation)}`);
  }
}

module.exports = {
  // Machines
  createMachine,
  MissionTransfer,
  MissionDownload,
  MissionUpload,
  MissionClear,

  // Locking
  locks,

  // Validation
  validateItems: validate.validateItems,
  validateMissionItems: validate.validateMissionItems,
  validateFenceItems: validate.validateFenceItems,
  validateRallyItems: validate.validateRallyItems,
  isNavCommand: validate.isNavCommand,
  FENCE_COMMANDS: validate.FENCE_COMMANDS,
  RALLY_COMMAND: validate.RALLY_COMMAND,

  // Types & firmware gating
  MISSION_TYPE: types.MISSION_TYPE,
  MISSION_TYPE_BY_KEY: types.MISSION_TYPE_BY_KEY,
  MISSION_TYPE_KEY: types.MISSION_TYPE_KEY,
  missionTypeValue: types.missionTypeValue,
  OPERATION: types.OPERATION,
  MAV_MISSION_RESULT: types.MAV_MISSION_RESULT,
  RESULT_NAME: types.RESULT_NAME,
  missionResultName: types.missionResultName,
  supportedMissionTypes: types.supportedMissionTypes,
  DEFAULT_STEP_TIMEOUT_MS: types.DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES: types.DEFAULT_MAX_RETRIES,

  // Message builders
  buildRequestList: items.buildRequestList,
  buildRequestInt: items.buildRequestInt,
  buildCount: items.buildCount,
  buildAck: items.buildAck,
  buildClearAll: items.buildClearAll,
  buildItem: items.buildItem,
  buildItemInt: items.buildItemInt,
  isGlobalFrame: items.isGlobalFrame,
};
