'use strict';

/**
 * Per-type mission item validation (DESIGN.md §9 "Item validation is per
 * type"). Three validators, not one with a flag: a mission carries navigation
 * (and the DO/CONDITION commands that plan alongside them), a fence carries
 * only `MAV_CMD_NAV_FENCE_*`, and a rally carries only
 * `MAV_CMD_NAV_RALLY_POINT`. Each validator's real job is to reject the *other*
 * families, so an operator cannot upload fence vertices as a mission or a
 * waypoint as a rally point.
 *
 * Validation returns a result object rather than throwing: a wrong-family item
 * is an expected terminal outcome the node reports on output 1, not an
 * exceptional control-flow event (§2 "the happy path is the code").
 */

const { MISSION_TYPE } = require('./types');

/**
 * `MAV_CMD_NAV_FENCE_*` command ids (`common.xml`). A fence item must be one
 * of these and nothing else.
 * @type {Set<number>}
 */
const FENCE_COMMANDS = new Set([
  5000, // NAV_FENCE_RETURN_POINT
  5001, // NAV_FENCE_POLYGON_VERTEX_INCLUSION
  5002, // NAV_FENCE_POLYGON_VERTEX_EXCLUSION
  5003, // NAV_FENCE_CIRCLE_INCLUSION
  5004, // NAV_FENCE_CIRCLE_EXCLUSION
]);

/** `MAV_CMD_NAV_RALLY_POINT`. @type {number} */
const RALLY_COMMAND = 5100;

/**
 * True when `cmd` falls in the 16–95 numeric window, where the core
 * `MAV_CMD_NAV_*` movement commands live. It is a window test, not a complete
 * `MAV_CMD_NAV_*` classifier: the fence (5000–5004) and rally (5100) ids are
 * `NAV_*` names too but sit outside 16–95, so this returns false for them.
 * Kept for callers that want the nav-window test on its own; the mission
 * validator no longer gates on it (see {@link validateMissionItems}).
 *
 * @param {number} cmd
 * @returns {boolean}
 */
function isNavCommand(cmd) {
  return cmd >= 16 && cmd <= 95;
}

/**
 * @typedef {object} ValidationResult
 * @property {boolean} ok
 * @property {string} [reason]  human-readable failure, naming the offending item
 * @property {number} [seq]     index of the first offending item
 */

/** @type {ValidationResult} */
const OK = { ok: true };

/**
 * Validate the items for a given mission type, dispatching to the right
 * per-family validator (§9).
 *
 * @param {object[]} items  canonical items with a numeric `command`
 * @param {number} missionType  a `MAV_MISSION_TYPE`
 * @returns {ValidationResult}
 */
function validateItems(items, missionType) {
  if (missionType === MISSION_TYPE.FENCE) return validateFenceItems(items);
  if (missionType === MISSION_TYPE.RALLY) return validateRallyItems(items);
  return validateMissionItems(items);
}

/**
 * A mission item may carry any command *except* the fence and rally families,
 * which have their own dedicated buffers. The validator's only job is to keep
 * the three families from being uploaded into each other's buffers (§9); it is
 * deliberately not an allowlist of "supported" mission commands.
 *
 * A numeric window (NAV 16–95 + DO/CONDITION 112–250) was tried and removed
 * (issue #90): the two firmwares this toolkit targets accept *different*
 * command sets — PX4's mission parser admits camera-capture and
 * `DO_VTOL_TRANSITION` (ids 530/2000/2001/2500/2501/3000) that fall outside the
 * window, ArduPilot admits a different set, and the MAVLink XML carries no
 * "mission-capable" attribute to derive it from. Every reference client agrees
 * at this layer: pymavlink's `MAVWPLoader` and MAVSDK's `MissionRaw` pass any
 * command through, and QGroundControl treats the vehicle's `MISSION_ACK` as the
 * authority on support. So do we — a command the firmware cannot run is
 * rejected by the firmware with `MAV_MISSION_UNSUPPORTED`, surfaced on output 1.
 *
 * @param {object[]} items
 * @returns {ValidationResult}
 */
function validateMissionItems(items) {
  return check(items, (cmd) => !FENCE_COMMANDS.has(cmd) && cmd !== RALLY_COMMAND, 'mission');
}

/**
 * Fence items must be `MAV_CMD_NAV_FENCE_*` (§9).
 *
 * @param {object[]} items
 * @returns {ValidationResult}
 */
function validateFenceItems(items) {
  return check(items, (cmd) => FENCE_COMMANDS.has(cmd), 'fence');
}

/**
 * Rally items must be `MAV_CMD_NAV_RALLY_POINT` (§9).
 *
 * @param {object[]} items
 * @returns {ValidationResult}
 */
function validateRallyItems(items) {
  return check(items, (cmd) => cmd === RALLY_COMMAND, 'rally');
}

/**
 * Run a per-item predicate, returning the first failure with its sequence.
 *
 * @param {object[]} items
 * @param {(cmd: number) => boolean} predicate
 * @param {string} family  name used in the failure reason
 * @returns {ValidationResult}
 */
function check(items, predicate, family) {
  for (let seq = 0; seq < items.length; seq += 1) {
    const cmd = Number(items[seq].command);
    if (!Number.isFinite(cmd)) {
      return { ok: false, seq, reason: `item ${seq} has no numeric command` };
    }
    // The wire `command` field is `uint16_t`. A non-integer or out-of-range
    // value is not a command id: `5001.9` would truncate on serialization to
    // reserved fence command `5001` — slipping past the one family-reservation
    // rule this validator exists to hold — and `-1` / `65536` would throw
    // mid-serialize instead of failing cleanly here. Reject before the family
    // test so the deferral-to-firmware only ever applies to real command ids.
    if (!Number.isInteger(cmd) || cmd < 0 || cmd > 0xffff) {
      return {
        ok: false,
        seq,
        reason: `item ${seq} command ${cmd} is not a uint16 command id (0–65535)`,
      };
    }
    if (!predicate(cmd)) {
      return {
        ok: false,
        seq,
        reason: `item ${seq} command ${cmd} is not a valid ${family} item`,
      };
    }
  }
  return OK;
}

module.exports = {
  FENCE_COMMANDS,
  RALLY_COMMAND,
  isNavCommand,
  validateItems,
  validateMissionItems,
  validateFenceItems,
  validateRallyItems,
};
