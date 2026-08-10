'use strict';

/**
 * Status-record helpers for the mavlink-command node (DESIGN.md §9).
 *
 * Every terminal outcome from an action node goes out output 1 as a status
 * record. Status records are plain objects; no marker or detection field is
 * added.
 *
 * This module wraps lib/delivery's makeStatusRecord and adds the
 * command-specific MAV_RESULT tables.
 */

const delivery = require('../delivery');

/**
 * MAV_RESULT codes (§9 "The vehicle answers can you do this right now").
 * @enum {number}
 */
const MAV_RESULT = {
  ACCEPTED: 0,
  TEMPORARILY_REJECTED: 1,
  DENIED: 2,
  UNSUPPORTED: 3,
  FAILED: 4,
  IN_PROGRESS: 5,
  CANCELLED: 6,
  COMMAND_LONG_ONLY: 7,
  COMMAND_INT_ONLY: 8,
  COMMAND_UNSUPPORTED_MAV_FRAME: 9,
  NOT_IN_CONTROL: 10,
};

/** Whether a MAV_RESULT is terminal (i.e., not IN_PROGRESS). */
const TERMINAL_RESULTS = new Set([
  MAV_RESULT.ACCEPTED,
  MAV_RESULT.TEMPORARILY_REJECTED,
  MAV_RESULT.DENIED,
  MAV_RESULT.UNSUPPORTED,
  MAV_RESULT.FAILED,
  MAV_RESULT.CANCELLED,
  MAV_RESULT.COMMAND_LONG_ONLY,
  MAV_RESULT.COMMAND_INT_ONLY,
  MAV_RESULT.COMMAND_UNSUPPORTED_MAV_FRAME,
  MAV_RESULT.NOT_IN_CONTROL,
]);

/** Whether a terminal MAV_RESULT means success (chain continues). */
const SUCCESS_RESULTS = new Set([MAV_RESULT.ACCEPTED]);

/** Human-readable result names for status records. */
const RESULT_NAME = {
  [MAV_RESULT.ACCEPTED]: 'accepted',
  [MAV_RESULT.TEMPORARILY_REJECTED]: 'temporarily_rejected',
  [MAV_RESULT.DENIED]: 'denied',
  [MAV_RESULT.UNSUPPORTED]: 'unsupported',
  [MAV_RESULT.FAILED]: 'failed',
  [MAV_RESULT.IN_PROGRESS]: 'in_progress',
  [MAV_RESULT.CANCELLED]: 'cancelled',
  [MAV_RESULT.COMMAND_LONG_ONLY]: 'command_long_only',
  [MAV_RESULT.COMMAND_INT_ONLY]: 'command_int_only',
  [MAV_RESULT.COMMAND_UNSUPPORTED_MAV_FRAME]: 'command_unsupported_mav_frame',
  [MAV_RESULT.NOT_IN_CONTROL]: 'not_in_control',
};

/**
 * Construct a command status record using lib/delivery's plain-object builder
 * (§9 "one implementation per concept").
 *
 * Fields default: resultCode=null, resultParam2=null, confirmedBy='none',
 * target=null, elapsed=0, retries=0, command=null, commandId=null, detail=null.
 *
 * @param {object} fields
 * @param {string}  fields.result  'accepted'|'failed'|'unconfirmed'|'timeout'|
 *   'cancelled'|...; matches RESULT_NAME values for ack results
 * @param {number|null}  [fields.resultCode]
 * @param {number|null}  [fields.resultParam2]  the ack's command-specific
 *   result_param2 (0 when the vehicle had nothing to report — an omitted
 *   extension decodes as 0, §14); null when nothing acked
 * @param {'ack'|'state'|'none'}  [fields.confirmedBy]
 * @param {{sysid: number, compid: number}|null}  [fields.target]
 * @param {number}  [fields.elapsed]  milliseconds
 * @param {number}  [fields.retries]
 * @param {string|null}  [fields.command]  friendly command name
 * @param {number|null}  [fields.commandId]  MAV_CMD numeric value
 * @param {string|null}  [fields.detail]  extra human-readable context
 * @returns {object}
 */
function makeStatusRecord(fields) {
  return delivery.makeStatusRecord({
    result: fields.result,
    resultCode: fields.resultCode !== undefined ? fields.resultCode : null,
    resultParam2: fields.resultParam2 !== undefined ? fields.resultParam2 : null,
    confirmedBy: fields.confirmedBy || 'none',
    target: fields.target || null,
    elapsed: fields.elapsed !== undefined ? fields.elapsed : 0,
    retries: fields.retries !== undefined ? fields.retries : 0,
    command: fields.command || null,
    commandId: fields.commandId !== undefined ? fields.commandId : null,
    detail: fields.detail || null,
  });
}

module.exports = {
  makeStatusRecord,
  MAV_RESULT,
  TERMINAL_RESULTS,
  SUCCESS_RESULTS,
  RESULT_NAME,
};
