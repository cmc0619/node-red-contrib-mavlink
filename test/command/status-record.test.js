'use strict';

/**
 * Status-record tests (DESIGN.md §9, brief: "status-record refuse").
 *
 * Tests:
 *   - makeStatusRecord produces the expected shape with the marker field
 *   - isStatusRecord correctly identifies records and non-records
 *   - The miswire guard in the command node logic:
 *     a status record passed as input must be identified and refused
 *   - A plain message object is NOT a status record
 *   - Various edge cases: null, primitives, objects without the marker
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  makeStatusRecord,
  isStatusRecord,
  MAV_RESULT,
  MARKER,
  TERMINAL_RESULTS,
  SUCCESS_RESULTS,
  RESULT_NAME,
} = require('../../lib/command');

// ── makeStatusRecord shape ─────────────────────────────────────────────────

test('makeStatusRecord carries the marker field', () => {
  const rec = makeStatusRecord({ result: 'accepted' });
  assert.equal(rec[MARKER], true);
});

test('makeStatusRecord includes all required fields', () => {
  const rec = makeStatusRecord({
    result: 'accepted',
    resultCode: MAV_RESULT.ACCEPTED,
    confirmedBy: 'ack',
    target: { sysid: 1, compid: 1 },
    elapsed: 1234,
    retries: 2,
    command: 'MAV_CMD_COMPONENT_ARM_DISARM',
    commandId: 400,
    detail: 'armed',
  });
  assert.equal(rec.result, 'accepted');
  assert.equal(rec.resultCode, 0);
  assert.equal(rec.confirmedBy, 'ack');
  assert.deepEqual(rec.target, { sysid: 1, compid: 1 });
  assert.equal(rec.elapsed, 1234);
  assert.equal(rec.retries, 2);
  assert.equal(rec.command, 'MAV_CMD_COMPONENT_ARM_DISARM');
  assert.equal(rec.commandId, 400);
  assert.equal(rec.detail, 'armed');
});

test('makeStatusRecord fills defaults for optional fields', () => {
  const rec = makeStatusRecord({ result: 'timeout' });
  assert.equal(rec.resultCode, null);
  assert.equal(rec.confirmedBy, 'none');
  assert.equal(rec.target, null);
  assert.equal(rec.elapsed, 0);
  assert.equal(rec.retries, 0);
  assert.equal(rec.command, null);
  assert.equal(rec.commandId, null);
  assert.equal(rec.detail, null);
});

// ── isStatusRecord identification ─────────────────────────────────────────

test('isStatusRecord returns true for a status record', () => {
  const rec = makeStatusRecord({ result: 'accepted' });
  assert.equal(isStatusRecord(rec), true);
});

test('isStatusRecord returns false for null', () => {
  assert.equal(isStatusRecord(null), false);
});

test('isStatusRecord returns false for a plain object without marker', () => {
  assert.equal(isStatusRecord({ payload: 'hello' }), false);
});

test('isStatusRecord returns false for a number', () => {
  assert.equal(isStatusRecord(42), false);
});

test('isStatusRecord returns false for a string', () => {
  assert.equal(isStatusRecord('accepted'), false);
});

test('isStatusRecord returns false for an object with marker set to false', () => {
  assert.equal(isStatusRecord({ [MARKER]: false }), false);
});

test('isStatusRecord returns false for an array', () => {
  assert.equal(isStatusRecord([]), false);
});

test('isStatusRecord returns false for undefined', () => {
  assert.equal(isStatusRecord(undefined), false);
});

// ── Miswire guard simulation ───────────────────────────────────────────────
// Simulate the guard logic at the node boundary without instantiating Node-RED.

function simulateInput(msg) {
  if (msg.payload === false) return { action: 'suppress' };
  if (isStatusRecord(msg)) return { action: 'miswire' };
  return { action: 'proceed' };
}

test('miswire guard: a status record on input returns action=miswire', () => {
  const rec = makeStatusRecord({ result: 'accepted', commandId: 400 });
  const result = simulateInput(rec);
  assert.equal(result.action, 'miswire');
});

test('miswire guard: a plain message on input returns action=proceed', () => {
  const result = simulateInput({ payload: { 1: 1 } });
  assert.equal(result.action, 'proceed');
});

test('miswire guard: an inject-default timestamp payload returns action=proceed', () => {
  // The commonest flow: inject node wired directly → payload is a timestamp.
  const result = simulateInput({ payload: Date.now() });
  assert.equal(result.action, 'proceed');
});

test('miswire guard: null payload is not a status record', () => {
  const result = simulateInput({ payload: null });
  assert.equal(result.action, 'proceed');
});

test('miswire guard: an empty object payload is not a status record', () => {
  const result = simulateInput({ payload: {} });
  assert.equal(result.action, 'proceed');
});

// The miswire guard emits a status record naming the miswire itself.
test('a miswire status record is itself a status record', () => {
  const miswire = makeStatusRecord({
    result: 'miswire',
    detail: 'input is a status record — check wiring',
    commandId: 400,
  });
  assert.equal(isStatusRecord(miswire), true);
  assert.equal(miswire.result, 'miswire');
});

// ── MAV_RESULT tables ──────────────────────────────────────────────────────

test('TERMINAL_RESULTS contains ACCEPTED, not IN_PROGRESS', () => {
  assert.equal(TERMINAL_RESULTS.has(MAV_RESULT.ACCEPTED), true);
  assert.equal(TERMINAL_RESULTS.has(MAV_RESULT.IN_PROGRESS), false);
});

test('SUCCESS_RESULTS contains only ACCEPTED', () => {
  assert.equal(SUCCESS_RESULTS.has(MAV_RESULT.ACCEPTED), true);
  assert.equal(SUCCESS_RESULTS.size, 1);
});

test('RESULT_NAME maps every MAV_RESULT to a non-empty string', () => {
  for (const [k, v] of Object.entries(MAV_RESULT)) {
    assert.ok(RESULT_NAME[v], `MAV_RESULT.${k} (${v}) must have a RESULT_NAME`);
    assert.ok(typeof RESULT_NAME[v] === 'string' && RESULT_NAME[v].length > 0);
  }
});

// ── Status record cannot be confused with a normal message ─────────────────

test('a COMMAND_ACK decoded message is not a status record', () => {
  const ack = {
    name: 'COMMAND_ACK',
    sysid: 1,
    compid: 1,
    fields: { command: 400, result: 0 },
  };
  assert.equal(isStatusRecord(ack), false);
});

test('a COMMAND_LONG built message is not a status record', () => {
  const cmd = {
    name: 'COMMAND_LONG',
    fields: {
      target_system: 1,
      target_component: 1,
      command: 400,
      confirmation: 0,
      param1: 1,
      param2: 0,
      param3: 0,
      param4: 0,
      param5: 0,
      param6: 0,
      param7: 0,
    },
  };
  assert.equal(isStatusRecord(cmd), false);
});
