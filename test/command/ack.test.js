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
