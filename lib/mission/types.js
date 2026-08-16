'use strict';

/**
 * Mission-protocol constants (DESIGN.md §9 "Mission protocol").
 *
 * Three operations (download / upload / clear) run over one item-transfer
 * protocol, each parameterised by a `mission_type`. This module holds the
 * enums those machines and the node share and the MAV_MISSION_RESULT
 * vocabulary used to describe a `MISSION_ACK`.
 *
 * These are wire-protocol facts (MAVLink `common.xml`), not policy; the codec
 * and node consume them as an argument (§2 "One implementation per concept").
 */

/**
 * `MAV_MISSION_TYPE` — the plan a transfer operates on. Carried on every
 * mission message as the `mission_type` extension field (default 0 =
 * MISSION when a peer omits it).
 *
 * @enum {number}
 */
const MISSION_TYPE = {
  MISSION: 0,
  FENCE: 1,
  RALLY: 2,
  ALL: 255,
};

/**
 * Editor/config keys mapped to their numeric `MAV_MISSION_TYPE`. The node's
 * dropdown stores the key; the library works in numbers.
 *
 * @type {Object<string, number>}
 */
const MISSION_TYPE_BY_KEY = {
  mission: MISSION_TYPE.MISSION,
  fence: MISSION_TYPE.FENCE,
  rally: MISSION_TYPE.RALLY,
};

/** Reverse of {@link MISSION_TYPE_BY_KEY}. @type {Object<number, string>} */
const MISSION_TYPE_KEY = {
  [MISSION_TYPE.MISSION]: 'mission',
  [MISSION_TYPE.FENCE]: 'fence',
  [MISSION_TYPE.RALLY]: 'rally',
};

/**
 * Resolve an editor key or a raw number to a numeric `MAV_MISSION_TYPE`.
 *
 * @param {string|number} value  'mission' | 'fence' | 'rally' | 0 | 1 | 2
 * @returns {number}
 */
function missionTypeValue(value) {
  if (typeof value === 'number') return value;
  return MISSION_TYPE_BY_KEY[String(value).trim().toLowerCase()];
}

/**
 * The three operations this module implements. Stored in node config; compared
 * as stable strings.
 *
 * @enum {string}
 */
const OPERATION = {
  DOWNLOAD: 'download',
  UPLOAD: 'upload',
  CLEAR: 'clear',
};

/**
 * `MAV_MISSION_RESULT` — the `type` field on a `MISSION_ACK`. 0 is the only
 * success; every other value is a terminal failure the transfer reports
 * verbatim (§9 "A failed upload fails").
 *
 * @enum {number}
 */
const MAV_MISSION_RESULT = {
  ACCEPTED: 0,
  ERROR: 1,
  UNSUPPORTED_FRAME: 2,
  UNSUPPORTED: 3,
  NO_SPACE: 4,
  INVALID: 5,
  INVALID_PARAM1: 6,
  INVALID_PARAM2: 7,
  INVALID_PARAM3: 8,
  INVALID_PARAM4: 9,
  INVALID_PARAM5_X: 10,
  INVALID_PARAM6_Y: 11,
  INVALID_PARAM7: 12,
  INVALID_SEQUENCE: 13,
  DENIED: 14,
  OPERATION_CANCELLED: 15,
};

/** Numeric result → name. @type {Object<number, string>} */
const RESULT_NAME = Object.fromEntries(
  Object.entries(MAV_MISSION_RESULT).map(([name, code]) => [code, name])
);

/**
 * @param {number} code  a `MAV_MISSION_RESULT` value
 * @returns {string} the constant name, or the raw number stringified
 */
function missionResultName(code) {
  return RESULT_NAME[code] || String(code);
}

/**
 * Default per-step timeout before a retry (ms). MAVLink does not define a rate;
 * this is the common convention for a mission item request/response leg.
 * @type {number}
 */
const DEFAULT_STEP_TIMEOUT_MS = 1500;

/**
 * Default per-step retry ceiling before the transfer aborts naming the stalled
 * sequence (§9 "Retry per item, with a ceiling").
 * @type {number}
 */
const DEFAULT_MAX_RETRIES = 5;

/**
 * Transfer no-progress deadline (ms), reset whenever the transfer advances to
 * a distinct step. The per-step ceiling resets on every advance — that is
 * deliberate (§9, per item) — but upload's steps are driven by the vehicle, so
 * a peer re-requesting the *same* sequence forever resets the counter
 * indefinitely and the transfer never terminates. This is the transfer-level
 * bound behind §9 "A transfer that hangs forever is worse than one that
 * fails". Generous on purpose: it exists to end a livelock, not to race a
 * large mission over a slow link.
 * @type {number}
 */
const DEFAULT_TRANSFER_DEADLINE_MS = 60000;

module.exports = {
  MISSION_TYPE,
  MISSION_TYPE_BY_KEY,
  MISSION_TYPE_KEY,
  missionTypeValue,
  OPERATION,
  MAV_MISSION_RESULT,
  RESULT_NAME,
  missionResultName,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TRANSFER_DEADLINE_MS,
};
