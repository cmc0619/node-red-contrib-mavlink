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
  const waiter = makeWaiter(conn, { commandId: 400, targetSysid: 2, targetCompid: 1 });
  const p = waiter.start();

  // Another vehicle (sysid 1) acks the same command — must be ignored.
  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 1, 1);
  // The addressed vehicle (sysid 2) acks — settles the transaction.
  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 2, 1);

  const outcome = await p;
  assert.equal(outcome.result, 'accepted');
  assert.equal(outcome.resultCode, MAV_RESULT.ACCEPTED);
});

test('ack for a different command id is ignored', async () => {
  const conn = stubConn();
  const waiter = makeWaiter(conn, { commandId: 400, targetSysid: 1, targetCompid: 1 });
  const p = waiter.start();

  conn.injectAck({ command: 22, result: MAV_RESULT.ACCEPTED }, 1, 1);
  conn.injectAck({ command: 400, result: MAV_RESULT.DENIED }, 1, 1);

  const outcome = await p;
  assert.equal(outcome.result, 'denied');
});

test('ack from a different component is ignored when a specific compid is addressed', async () => {
  const conn = stubConn();
  const waiter = makeWaiter(conn, { commandId: 176, targetSysid: 3, targetCompid: 1 });
  const p = waiter.start();

  // Camera component (100) on the same system replies — wrong component.
  conn.injectAck({ command: 176, result: MAV_RESULT.ACCEPTED }, 3, 100);
  // Autopilot (compid 1) replies — the addressed component.
  conn.injectAck({ command: 176, result: MAV_RESULT.ACCEPTED }, 3, 1);

  const outcome = await p;
  assert.equal(outcome.result, 'accepted');
});

test('broadcast target sysid 0 accepts an ack from any source system', async () => {
  const conn = stubConn();
  const waiter = makeWaiter(conn, { commandId: 400, targetSysid: 0, targetCompid: 0 });
  const p = waiter.start();

  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 7, 42);

  const outcome = await p;
  assert.equal(outcome.result, 'accepted');
});
