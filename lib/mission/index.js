'use strict';

/**
 * mavlink-mission library (DESIGN.md §3, §9 "Mission protocol", §12 step 7).
 *
 * Three state machines over one item-transfer protocol — the only place in the
 * package where the vehicle drives the conversation. All logic lives here; the
 * `mavlink-mission` node is a thin wrapper that reads config, resolves the
 * connection/target, runs a machine, and shapes the two-output chain
 * (§2 "Nodes stay thin").
 *
 * Public surface consumed by nodes/mavlink-mission.js:
 *
 *   - {@link createMachine} — build the machine for an operation
 *   - {@link locks} — transfer lock per (conn, target, type)
 *   - {@link missionTypeValue} / {@link OPERATION}
 *   - the item/control message builders (for the Build tier plan)
 */

const types = require('./types');
const items = require('./items');
const { LockRegistry } = require('../delivery/lock');
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
 * @param {object} opts  machine options; for
 *   upload, `opts.items` is the canonical item array.
 * @returns {object}
 */
function createMachine(operation, opts) {
  switch (operation) {
    case types.OPERATION.DOWNLOAD:
      return new MissionDownload(opts);
    case types.OPERATION.UPLOAD:
      return new MissionUpload(opts);
    case types.OPERATION.CLEAR:
      return new MissionClear(opts);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

module.exports = {
  createMachine,
  locks,
  missionTypeValue: types.missionTypeValue,
  OPERATION: types.OPERATION,
  buildRequestList: items.buildRequestList,
  buildCount: items.buildCount,
  buildClearAll: items.buildClearAll,
  buildItemInt: items.buildItemInt,
};
