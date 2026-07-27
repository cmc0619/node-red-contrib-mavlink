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
 * `MAV_CMD_NAV_*` navigation commands occupy 16–95 in the dialect. These are
 * the core of a mission plan.
 *
 * @param {number} cmd
 * @returns {boolean}
 */
function isNavCommand(cmd) {
  return cmd >= 16 && cmd <= 95;
}

/**
 * `MAV_CMD_CONDITION_*` (112–159) and `MAV_CMD_DO_*` (176–250) commands plan
 * inside a mission alongside navigation — a `DO_JUMP` or `CONDITION_DELAY` is a
 * legitimate mission item, so a NAV-only rule would reject a valid plan. They
 * are excluded from fence and rally, which take only their own dedicated
 * commands.
 *
 * @param {number} cmd
 * @returns {boolean}
 */
function isMissionPlanCommand(cmd) {
  return isNavCommand(cmd) || (cmd >= 112 && cmd <= 250);
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
 * Mission items must be navigation or plan (DO/CONDITION) commands, and must
 * not be fence or rally commands (§9 "Mission items are MAV_CMD_NAV_* (not
 * fence/rally)").
 *
 * @param {object[]} items
 * @returns {ValidationResult}
 */
function validateMissionItems(items) {
  return check(items, (cmd) =>
    isMissionPlanCommand(cmd) && !FENCE_COMMANDS.has(cmd) && cmd !== RALLY_COMMAND,
    'mission'
  );
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
  isMissionPlanCommand,
  validateItems,
  validateMissionItems,
  validateFenceItems,
  validateRallyItems,
};
