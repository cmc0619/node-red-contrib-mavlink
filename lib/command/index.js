'use strict';

/**
 * mavlink-command library (DESIGN.md §3, §9, §12 step 6).
 *
 * Public surface consumed by nodes/mavlink-command.js:
 *
 *   - {@link makeStatusRecord} — output-1 record construction
 *   - {@link MAV_RESULT} / {@link TERMINAL_RESULTS} / {@link SUCCESS_RESULTS} /
 *     {@link RESULT_NAME} — ack result codes
 *   - {@link PRESETS} / {@link getPreset} / {@link presetGroups} /
 *     {@link buildParamArray} / {@link COMPLETION} — preset table (§9)
 *   - {@link AckWaiter} — COMMAND_ACK waiting with retry (§9)
 *   - {@link checkCompletion} / {@link waitForCompletion} — completion
 *     condition polling (§9 "Ack is not completion")
 */

const {
  makeStatusRecord,
  MAV_RESULT,
  TERMINAL_RESULTS,
  SUCCESS_RESULTS,
  RESULT_NAME,
} = require('./status-record');

const {
  PRESETS,
  PRESET_BY_ID,
  COMPLETION,
  getPreset,
  presetGroups,
  buildParamArray,
} = require('./presets');

const { AckWaiter, ackAddressedTo, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES, DEFAULT_RETRY_INTERVAL_MS } =
  require('./ack');

const {
  checkCompletion,
  waitForCompletion,
  TAKEOFF_TOLERANCE,
  LAND_ALT_THRESHOLD_M,
  DEFAULT_COMPLETION_TIMEOUT_MS,
  DEFAULT_POLL_MS,
} = require('./completion');

const {
  CARRIER,
  carrierWantedBy,
  commandByValue,
  intCoordKinds,
  resolveFrame,
  MAV_FRAME,
  GLOBAL_FRAMES,
  LOCAL_FRAMES,
  NON_POSITION_FRAMES,
  DEG_E7,
  DEFAULT_FRAME,
  isGlobalFrame,
  scaleLatLon,
  unscaleLatLon,
  longToIntFields,
  intFieldsToLong,
  buildCommandLong,
  buildCommandInt,
} = require('./carrier');

module.exports = {
  // Status records
  makeStatusRecord,
  MAV_RESULT,
  TERMINAL_RESULTS,
  SUCCESS_RESULTS,
  RESULT_NAME,

  // Presets
  PRESETS,
  PRESET_BY_ID,
  COMPLETION,
  getPreset,
  presetGroups,
  buildParamArray,
  mergeParams: require('./merge-params').mergeParams,

  // AckWaiter
  AckWaiter,
  ackAddressedTo,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_INTERVAL_MS,

  // Completion polling
  checkCompletion,
  waitForCompletion,
  TAKEOFF_TOLERANCE,
  LAND_ALT_THRESHOLD_M,
  DEFAULT_COMPLETION_TIMEOUT_MS,
  DEFAULT_POLL_MS,

  // Carrier conversion (COMMAND_LONG ↔ COMMAND_INT, §9)
  CARRIER,
  carrierWantedBy,
  commandByValue,
  intCoordKinds,
  resolveFrame,
  MAV_FRAME,
  GLOBAL_FRAMES,
  LOCAL_FRAMES,
  NON_POSITION_FRAMES,
  DEG_E7,
  DEFAULT_FRAME,
  isGlobalFrame,
  scaleLatLon,
  unscaleLatLon,
  longToIntFields,
  intFieldsToLong,
  buildCommandLong,
  buildCommandInt,
};
