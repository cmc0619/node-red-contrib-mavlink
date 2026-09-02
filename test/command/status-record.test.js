'use strict';

/**
 * Status-record tests (DESIGN.md §9).
 *
 * Tests:
 *   - makeStatusRecord produces the expected plain-object shape
 *   - command-specific defaults are filled in
 *   - MAV_RESULT tables expose stable command result metadata
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  makeStatusRecord,
  MAV_RESULT,
  RESULT_NAME,
} = require('../../lib/command');

// -- makeStatusRecord shape --------------------------------------------------

test('makeStatusRecord returns the default plain-object shape', () => {
  const rec = makeStatusRecord('mavlink-command', { result: 'accepted' });
  assert.deepEqual(rec, {
    node: 'mavlink-command',
    result: 'accepted',
    resultCode: null,
    resultParam2: null,
    confirmedBy: 'none',
    target: null,
    elapsed: 0,
    retries: 0,
    command: null,
    commandId: null,
    detail: null,
  });
});

test('makeStatusRecord includes all required fields', () => {
  const rec = makeStatusRecord('mavlink-command', {
    result: 'accepted',
    resultCode: MAV_RESULT.ACCEPTED,
    resultParam2: 3,
    confirmedBy: 'ack',
    target: { sysid: 1, compid: 1 },
    elapsed: 1234,
    retries: 2,
    command: 'MAV_CMD_COMPONENT_ARM_DISARM',
    commandId: 400,
    detail: 'armed',
  });
  assert.equal(rec.node, 'mavlink-command');
  assert.equal(rec.result, 'accepted');
  assert.equal(rec.resultCode, 0);
  assert.equal(rec.resultParam2, 3);
  assert.equal(rec.confirmedBy, 'ack');
  assert.deepEqual(rec.target, { sysid: 1, compid: 1 });
  assert.equal(rec.elapsed, 1234);
  assert.equal(rec.retries, 2);
  assert.equal(rec.command, 'MAV_CMD_COMPONENT_ARM_DISARM');
  assert.equal(rec.commandId, 400);
  assert.equal(rec.detail, 'armed');
});

test('makeStatusRecord fills defaults for optional fields', () => {
  const rec = makeStatusRecord('mavlink-command', { result: 'timeout' });
  assert.equal(rec.resultCode, null);
  assert.equal(rec.confirmedBy, 'none');
  assert.equal(rec.target, null);
  assert.equal(rec.elapsed, 0);
  assert.equal(rec.retries, 0);
  assert.equal(rec.command, null);
  assert.equal(rec.commandId, null);
  assert.equal(rec.detail, null);
});

// -- MAV_RESULT tables -------------------------------------------------------

test('RESULT_NAME maps every MAV_RESULT to a non-empty string', () => {
  for (const [k, v] of Object.entries(MAV_RESULT)) {
    assert.ok(RESULT_NAME[v], `MAV_RESULT.${k} (${v}) must have a RESULT_NAME`);
    assert.ok(typeof RESULT_NAME[v] === 'string' && RESULT_NAME[v].length > 0);
  }
});
