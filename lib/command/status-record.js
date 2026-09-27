'use strict';

/**
 * The MAV_RESULT tables the acked nodes report with (DESIGN.md §9). Records
 * themselves are built by lib/delivery's makeStatusRecord.
 */

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

module.exports = {
  MAV_RESULT,
  RESULT_NAME,
};
