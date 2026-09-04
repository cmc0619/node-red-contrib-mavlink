'use strict';

/**
 * mavlink-command library (DESIGN.md §3, §9, §12 step 6).
 *
 * Public surface consumed by nodes/mavlink-command.js:
 *
 *   - {@link makeStatusRecord} — output-1 record construction
 *   - {@link MAV_RESULT} — ack result codes
 *   - {@link getPreset} / {@link presetGroups} / {@link buildParamArray} —
 *     preset table (§9)
 *   - {@link AckWaiter} — COMMAND_ACK waiting with retry (§9)
 *   - {@link checkCompletion} / {@link waitForCompletion} — completion
 *     condition polling (§9 "Ack is not completion")
 */

const { makeStatusRecord, MAV_RESULT } = require('./status-record');

const { getPreset, presetGroups, buildParamArray } = require('./presets');

const { AckWaiter, ackAddressedTo, ackWaiterFor, ackRecordFields, sendFnFor, cancelSlot } = require('./ack');

const {
  checkCompletion,
  waitForCompletion,
} = require('./completion');

const {
  CARRIER,
  commandByValue,
  intCoordKinds,
  resolveFrame,
  DEFAULT_FRAME,
  isGlobalFrame,
  scaleLatLon,
  buildCommandLong,
  buildCommandInt,
} = require('./carrier');

module.exports = {
  // Status records
  makeStatusRecord,
  MAV_RESULT,

  // Presets
  getPreset,
  presetGroups,
  buildParamArray,
  mergeParams: require('./merge-params').mergeParams,

  // AckWaiter
  AckWaiter,
  ackAddressedTo,
  ackWaiterFor,
  ackRecordFields,
  sendFnFor,
  cancelSlot,

  // Completion polling
  checkCompletion,
  waitForCompletion,

  // Carrier conversion (COMMAND_LONG ↔ COMMAND_INT, §9)
  CARRIER,
  commandByValue,
  intCoordKinds,
  resolveFrame,
  DEFAULT_FRAME,
  isGlobalFrame,
  scaleLatLon,
  buildCommandLong,
  buildCommandInt,
};
