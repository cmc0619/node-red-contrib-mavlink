'use strict';

/**
 * MAV_RESULT table tests (DESIGN.md §9): the tables expose stable command
 * result metadata.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAV_RESULT,
  RESULT_NAME,
} = require('../../lib/command/status-record');

// -- MAV_RESULT tables -------------------------------------------------------

test('RESULT_NAME maps every MAV_RESULT to a non-empty string', () => {
  for (const [k, v] of Object.entries(MAV_RESULT)) {
    assert.ok(RESULT_NAME[v], `MAV_RESULT.${k} (${v}) must have a RESULT_NAME`);
    assert.ok(typeof RESULT_NAME[v] === 'string' && RESULT_NAME[v].length > 0);
  }
});
