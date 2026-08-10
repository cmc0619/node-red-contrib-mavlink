'use strict';

/**
 * AckWaiter correlation tests (DESIGN.md §9 "The vehicle answers can you do
 * this right now", review finding: ACK source correlation).
 *
 * A COMMAND_ACK must settle a transaction only when it carries the awaited
 * command id AND comes from the vehicle the command was addressed to. On a
 * multi-vehicle connection every peer's ack arrives on the same subscription,
 * so matching the command id alone would let one vehicle settle another's
 * transaction.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { AckWaiter, MAV_RESULT } = require('../../lib/command');

/**
 * Minimal connection stub: records subscriptions and injects COMMAND_ACKs with
 * a controllable source (sysid, compid).
 */
function stubConn() {
  const handlers = [];
  return {
    subscribe(filter, handler) {
      const entry = { filter, handler };
      handlers.push(entry);
      return () => {
        const i = handlers.indexOf(entry);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    injectAck(fields, sysid, compid) {
      const decoded = { name: 'COMMAND_ACK', sysid, compid, fields };
      for (const { handler } of handlers.slice()) handler(decoded);
    },
  };
}

function makeWaiter(conn, opts) {
  return new AckWaiter({
    subscribe: (filter, handler) => conn.subscribe(filter, handler),
    sendFn: () => {},
    timeoutMs: 5000,
    ...opts,
  });
}

test('ack from a different sysid does not settle the transaction; the addressed one does', async () => {
  const conn = stubConn();
  const waiter = makeWaiter(conn, { commandId: 400, targetSystem: 2, targetComponent: 1 });
  const p = waiter.start();

  // Another vehicle (sysid 1) acks DENIED — must be ignored (not settle).
  conn.injectAck({ command: 400, result: MAV_RESULT.DENIED }, 1, 1);
  // The addressed vehicle (sysid 2) acks ACCEPTED — settles the transaction.
  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 2, 1);

  const outcome = await p;
  assert.equal(outcome.result, 'accepted');
  assert.equal(outcome.resultCode, MAV_RESULT.ACCEPTED);
});

test('an ack explicitly addressed to another GCS is ignored; ours and MAVLink 1 acks settle (§9)', async () => {
  const conn = stubConn();
  const waiter = makeWaiter(conn, {
    commandId: 400,
    targetSystem: 2,
    targetComponent: 1,
    sourceIds: { sysid: 250, compid: 190 },
  });
  const p = waiter.start();

  // The vehicle answers another station's identical command — addressed to
  // GCS 255, not us. Must not settle our wait, even as DENIED.
  conn.injectAck(
    { command: 400, result: MAV_RESULT.DENIED, target_system: 255, target_component: 190 },
    2, 1
  );
  // Our own answer, addressed to 250/190, settles it.
  conn.injectAck(
    { command: 400, result: MAV_RESULT.ACCEPTED, target_system: 250, target_component: 190 },
    2, 1
  );
  const outcome = await p;
  assert.equal(outcome.result, 'accepted');

  // A MAVLink 1 ack carries no target fields — unaddressed passes the gate.
  const conn2 = stubConn();
  const waiter2 = makeWaiter(conn2, {
    commandId: 400,
    targetSystem: 2,
    targetComponent: 1,
    sourceIds: { sysid: 250, compid: 190 },
  });
  const p2 = waiter2.start();
  conn2.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 2, 1);
  const outcome2 = await p2;
  assert.equal(outcome2.result, 'accepted');
});

test('ack for a different command id is ignored', async () => {
  const conn = stubConn();
  const waiter = makeWaiter(conn, { commandId: 400, targetSystem: 1, targetComponent: 1 });
  const p = waiter.start();

  conn.injectAck({ command: 22, result: MAV_RESULT.ACCEPTED }, 1, 1);
  conn.injectAck({ command: 400, result: MAV_RESULT.DENIED }, 1, 1);

  const outcome = await p;
  assert.equal(outcome.result, 'denied');
});

test('ack from a different component is ignored when a specific compid is addressed', async () => {
  const conn = stubConn();
  const waiter = makeWaiter(conn, { commandId: 176, targetSystem: 3, targetComponent: 1 });
  const p = waiter.start();

  // Camera component (100) on the same system replies DENIED — wrong component.
  conn.injectAck({ command: 176, result: MAV_RESULT.DENIED }, 3, 100);
  // Autopilot (compid 1) replies ACCEPTED — the addressed component.
  conn.injectAck({ command: 176, result: MAV_RESULT.ACCEPTED }, 3, 1);

  const outcome = await p;
  assert.equal(outcome.result, 'accepted');
});

test('broadcast target sysid 0 accepts an ack from any source system', async () => {
  const conn = stubConn();
  const waiter = makeWaiter(conn, { commandId: 400, targetSystem: 0, targetComponent: 0 });
  const p = waiter.start();

  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 7, 42);

  const outcome = await p;
  assert.equal(outcome.result, 'accepted');
});

test('a retry send that throws settles the transaction instead of escaping the timer', async () => {
  // Connection.send throws synchronously by design — QueueOverflowError once
  // the Control band hits its cap, or identity resolution failing on a dead
  // link. The retry fires from a setTimeout, where nothing above it catches, so
  // an escape is an uncaughtException rather than a failed command — and it
  // lands on precisely the saturated or dropped link that provoked the retry.
  const conn = stubConn();
  let sends = 0;
  const waiter = makeWaiter(conn, {
    commandId: 400,
    targetSystem: 1,
    targetComponent: 1,
    maxRetries: 2,
    retryIntervalMs: 1,
    sendFn: () => {
      sends += 1;
      if (sends > 1) throw new Error('queue overflow on control band');
    },
  });

  const p = waiter.start();
  // TEMPORARILY_REJECTED is the one result that schedules a retry send.
  conn.injectAck({ command: 400, result: MAV_RESULT.TEMPORARILY_REJECTED }, 1, 1);

  const outcome = await p;
  assert.equal(outcome.result, 'send failed');
  assert.match(outcome.detail, /queue overflow/);
  assert.equal(sends, 2, 'the retry was attempted');
});

test('an initial send that throws rejects AND cleans up — no timer or subscription outlives it (Codex, #237)', async () => {
  // Connection.send throws by design (queue overflow, disabled link). The
  // rejection is the contract; the leak was the armed timeout and ack
  // subscription surviving it — the caller's finally drops its cancel handle
  // on rejection, so nothing else could ever clear them.
  let unsubscribed = 0;
  const waiter = new AckWaiter({
    subscribe: () => () => { unsubscribed += 1; },
    sendFn: () => { throw new Error('connection disabled'); },
    commandId: 400,
    targetSystem: 1,
    targetComponent: 1,
    timeoutMs: 5000,
  });

  await assert.rejects(waiter.start(), /connection disabled/);
  assert.equal(unsubscribed, 1, 'the ack subscription is released');
  assert.equal(waiter._timeoutHandle, null, 'the armed timeout is cleared');
  assert.equal(waiter._settled, true, 'settled — a late timeout cannot resurrect the transaction');
});

// -- progress / result_param2 surfacing (§9) ---------------------------------

test('resultParam2 rides every ack-confirmed settle; null when the frame lacks the field', async () => {
  const conn = stubConn();
  const accepted = makeWaiter(conn, { commandId: 400, targetSystem: 1, targetComponent: 1 });
  const acceptedPromise = accepted.start();
  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED, result_param2: 7 }, 1, 1);
  assert.equal((await acceptedPromise).resultParam2, 7);

  // A denial's result_param2 is usually the *why* — the reason a bare
  // 'denied' throws away.
  const denied = makeWaiter(conn, { commandId: 400, targetSystem: 1, targetComponent: 1 });
  const deniedPromise = denied.start();
  conn.injectAck({ command: 400, result: MAV_RESULT.DENIED, result_param2: -3 }, 1, 1);
  const deniedOutcome = await deniedPromise;
  assert.equal(deniedOutcome.result, 'denied');
  assert.equal(deniedOutcome.resultParam2, -3);

  // MAVLink 1 / a frame without the extension decodes as undefined; records
  // carry null, never undefined.
  const old = makeWaiter(conn, { commandId: 400, targetSystem: 1, targetComponent: 1 });
  const oldPromise = old.start();
  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 1, 1);
  assert.equal((await oldPromise).resultParam2, null);
});

test('a settle with no ack carries resultParam2 null', async () => {
  const conn = stubConn();
  const waiter = makeWaiter(conn, { commandId: 400, targetSystem: 1, targetComponent: 1, timeoutMs: 10 });
  const outcome = await waiter.start();
  assert.equal(outcome.result, 'timeout');
  assert.equal(outcome.resultParam2, null);

  const cancelled = makeWaiter(conn, { commandId: 400, targetSystem: 1, targetComponent: 1 });
  const cancelledPromise = cancelled.start();
  cancelled.cancel();
  assert.equal((await cancelledPromise).resultParam2, null);
});

test('onInProgress reports (progress, resultParam2) per IN_PROGRESS ack; 255 and absent are null', async () => {
  const conn = stubConn();
  const reported = [];
  const waiter = makeWaiter(conn, {
    commandId: 400,
    targetSystem: 1,
    targetComponent: 1,
    onInProgress: (progress, resultParam2) => reported.push([progress, resultParam2]),
  });
  const p = waiter.start();

  conn.injectAck({ command: 400, result: MAV_RESULT.IN_PROGRESS, progress: 0, result_param2: 2 }, 1, 1);
  conn.injectAck({ command: 400, result: MAV_RESULT.IN_PROGRESS, progress: 45 }, 1, 1);
  // 255 is the spec's "unknown" sentinel, not a percentage.
  conn.injectAck({ command: 400, result: MAV_RESULT.IN_PROGRESS, progress: 255 }, 1, 1);
  // No extension fields at all.
  conn.injectAck({ command: 400, result: MAV_RESULT.IN_PROGRESS }, 1, 1);
  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 1, 1);

  assert.equal((await p).result, 'accepted');
  assert.deepEqual(reported, [[0, 2], [45, null], [null, null], [null, null]]);
});

test('IN_PROGRESS without an onInProgress callback behaves exactly as before', async () => {
  const conn = stubConn();
  const waiter = makeWaiter(conn, { commandId: 400, targetSystem: 1, targetComponent: 1, timeoutMs: 30 });
  const p = waiter.start();
  conn.injectAck({ command: 400, result: MAV_RESULT.IN_PROGRESS, progress: 10 }, 1, 1);
  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 1, 1);
  const outcome = await p;
  assert.equal(outcome.result, 'accepted');
  assert.equal(outcome.confirmedBy, 'ack');
});
