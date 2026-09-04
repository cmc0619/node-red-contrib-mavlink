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
};

/**
 * Resolve an editor key to its numeric `MAV_MISSION_TYPE`; anything else is
 * forwarded as given (§5) — a number rides to the vehicle, which judges it,
 * and a garbage string rides present to the wire's finite-integer choke,
 * which refuses it naming the field. Resolving nothing here would let the
 * value serialize absent and decode as type 0 — the driver inventing MISSION.
 *
 * @param {*} value  'mission' | 'fence' | 'rally', or a raw wire value
 * @returns {*} the member for a key; anything else unchanged
 */
function missionTypeValue(value) {
  switch (value) {
    case 'mission': return MISSION_TYPE.MISSION;
    case 'fence': return MISSION_TYPE.FENCE;
    case 'rally': return MISSION_TYPE.RALLY;
    default: break; // This space intentionally left blank (§5)
  }
  return value; // nothing matched: forwarded as given (§5)
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
 * @returns {string|undefined} the constant name
 */
function missionResultName(code) {
  return RESULT_NAME[code];
}

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
  missionTypeValue,
  OPERATION,
  MAV_MISSION_RESULT,
  missionResultName,
  DEFAULT_TRANSFER_DEADLINE_MS,
};
