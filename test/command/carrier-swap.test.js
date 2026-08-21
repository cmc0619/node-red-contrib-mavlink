'use strict';

/**
 * The §9 wrong-carrier rule's one owner (`runWithCarrierSwap`) and the
 * at-most-one-in-flight slot (`cancelSlot`), tested directly. The node-level
 * end-to-end paths (mavlink-command, mavlink-payload) ride these; the tests
 * here pin the contract the nodes rely on: at most one swap per transaction,
 * fail-loud `wrongCarrier` details on the two unresolvable shapes, and a
 * release that cannot clear a newer run's handle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithCarrierSwap, CARRIER } = require('../../lib/command/carrier');
const { cancelSlot } = require('../../lib/command/ack');
const { MAV_RESULT } = require('../../lib/command/status-record');

const ACCEPTED = { resultCode: MAV_RESULT.ACCEPTED };
const DENIED = { resultCode: MAV_RESULT.DENIED };
const WANT_INT = { resultCode: MAV_RESULT.COMMAND_INT_ONLY };
const WANT_LONG = { resultCode: MAV_RESULT.COMMAND_LONG_ONLY };

test('an ack with no wrong-carrier code passes through with no swap', async () => {
  const runs = [];
  const result = await runWithCarrierSwap({
    carrier: CARRIER.LONG,
    run: (carrier) => { runs.push(carrier); return ACCEPTED; },
  });
  assert.deepEqual(runs, [CARRIER.LONG]);
  assert.equal(result.swapped, false);
  assert.equal(result.carrier, CARRIER.LONG);
  assert.equal(result.wrongCarrier, null);
  assert.equal(result.outcome, ACCEPTED);
});

test('a terminal DENIED is not a swap trigger', async () => {
  const runs = [];
  const result = await runWithCarrierSwap({
    carrier: CARRIER.INT,
    run: (carrier) => { runs.push(carrier); return DENIED; },
  });
  assert.deepEqual(runs, [CARRIER.INT]);
  assert.equal(result.swapped, false);
  assert.equal(result.wrongCarrier, null);
});

test('COMMAND_INT_ONLY on a LONG send swaps exactly once and announces it', async () => {
  const runs = [];
  const swaps = [];
  const result = await runWithCarrierSwap({
    carrier: CARRIER.LONG,
    run: (carrier) => { runs.push(carrier); return carrier === CARRIER.LONG ? WANT_INT : ACCEPTED; },
    onSwap: (outcome, from, to) => swaps.push([outcome.resultCode, from, to]),
  });
  assert.deepEqual(runs, [CARRIER.LONG, CARRIER.INT]);
  assert.deepEqual(swaps, [[MAV_RESULT.COMMAND_INT_ONLY, CARRIER.LONG, CARRIER.INT]]);
  assert.equal(result.swapped, true);
  assert.equal(result.carrier, CARRIER.INT);
  assert.equal(result.wrongCarrier, null);
  assert.equal(result.outcome, ACCEPTED);
});

test('a demand for the carrier already sent fails loud without a re-run', async () => {
  const runs = [];
  const result = await runWithCarrierSwap({
    carrier: CARRIER.INT,
    run: (carrier) => { runs.push(carrier); return WANT_INT; },
    onSwap: () => assert.fail('no swap may be announced'),
  });
  assert.deepEqual(runs, [CARRIER.INT], 'exactly one send');
  assert.equal(result.swapped, false);
  assert.match(result.wrongCarrier, /demands COMMAND_INT/);
  assert.match(result.wrongCarrier, /already sent/);
});

test('a second wrong-carrier ack after the swap fails loud — never a second swap', async () => {
  const runs = [];
  const result = await runWithCarrierSwap({
    carrier: CARRIER.LONG,
    // The vehicle contradicts itself: INT_ONLY, then LONG_ONLY.
    run: (carrier) => { runs.push(carrier); return carrier === CARRIER.LONG ? WANT_INT : WANT_LONG; },
  });
  assert.deepEqual(runs, [CARRIER.LONG, CARRIER.INT], 'at most one swap, two sends total');
  assert.equal(result.swapped, true);
  assert.match(result.wrongCarrier, /long→int/);
  assert.match(result.wrongCarrier, /command_long_only/);
  assert.match(result.wrongCarrier, /no carrier satisfies/);
});

test('cancelSlot cancels the active entry once and only once', () => {
  const slot = cancelSlot();
  let cancels = 0;
  const entry = { cancel: () => { cancels += 1; } };
  slot.active = entry;
  slot.cancel();
  assert.equal(cancels, 1);
  assert.equal(slot.active, null);
  slot.cancel();
  assert.equal(cancels, 1, 'cancel with no active entry is a no-op');
});

test('cancelSlot release is identity-guarded — a stale run cannot clear a newer handle', () => {
  const slot = cancelSlot();
  const first = { cancel: () => {} };
  const second = { cancel: () => {} };
  slot.active = first;
  assert.equal(slot.active, first);
  slot.active = second;
  slot.release(first);
  assert.equal(slot.active, second, 'releasing the superseded entry leaves the newer one');
  slot.release(second);
  assert.equal(slot.active, null);
});
