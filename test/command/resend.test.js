'use strict';

/**
 * AckWaiter timeout and IN_PROGRESS ceiling tests (#248, DESIGN.md §9 "A
 * missing ack is not a failure").
 *
 * A silent ack window settles 'timeout' — the caller runs the §9
 * classification (peer-table check → unconfirmed). IN_PROGRESS re-arms the
 * window, but never past an aggregate ceiling: unbounded re-arms would let
 * periodic IN_PROGRESS extend the deadline forever.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAV_RESULT } = require('../../lib/command/status-record');
const { AckWaiter } = require('../../lib/command/ack');

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
    // Omitted target extensions decode as 0 (§14).
    injectAck(fields, sysid, compid) {
      const decoded = {
        name: 'COMMAND_ACK',
        sysid,
        compid,
        fields: { target_system: 0, target_component: 0, ...fields },
      };
      for (const { handler } of handlers.slice()) handler(decoded);
    },
  };
}

function makeWaiter(conn, opts) {
  return new AckWaiter({
    subscribe: (filter, handler) => conn.subscribe(filter, handler),
    sendFn: () => {},
    commandId: 400,
    targetSystem: 1,
    targetComponent: 1,
    sourceIds: { sysid: 255, compid: 190 },
    ...opts,
  });
}

test('a silent window with no retry budget sends once, then settles the timeout shape', async () => {
  const conn = stubConn();
  let sends = 0;
  const waiter = makeWaiter(conn, { timeoutMs: 10, maxRetries: 0, sendFn: () => { sends += 1; } });

  const outcome = await waiter.start();

  assert.equal(sends, 1, 'the command is sent exactly once');
  assert.deepEqual(
    Object.keys(outcome).sort(),
    ['detail', 'elapsed', 'result', 'resultCode', 'resultParam2', 'retries']
  );
  assert.equal(outcome.result, 'timeout');
  assert.equal(outcome.resultCode, null);
  assert.equal(outcome.confirmedBy, undefined);
  assert.equal(outcome.retries, 0);
  // No terminal ack, so no terminal resultParam2 (§14: a decoded 0 is the
  // omitted-extension value, not a vehicle statement).
  assert.equal(outcome.resultParam2, null);
  assert.equal(outcome.detail, 'no terminal COMMAND_ACK received within timeout');
});

test('repeated IN_PROGRESS cannot extend the wait past the aggregate ceiling', async () => {
  const conn = stubConn();
  // Ceiling 2 → the wait may run to 2 × timeoutMs from start, no further.
  // Without the ceiling this test never finishes: every injection re-armed
  // the full window ahead of its expiry.
  const waiter = makeWaiter(conn, { timeoutMs: 30 });
  const p = waiter.start();
  const pump = setInterval(
    () => conn.injectAck({ command: 400, result: MAV_RESULT.IN_PROGRESS }, 1, 1),
    5
  );

  const started = Date.now();
  const outcome = await p;
  clearInterval(pump);

  assert.equal(outcome.result, 'timeout');
  assert.ok(Date.now() - started < 1000, 'the wait is bounded despite continuous IN_PROGRESS');
});

test('IN_PROGRESS under the ceiling still extends the window; a late terminal ack lands', async () => {
  const conn = stubConn();
  const waiter = makeWaiter(conn, { timeoutMs: 100 });
  const p = waiter.start();

  // Keep-waiting semantics: progress at 60 ms re-arms, so ACCEPTED at 140 ms
  // — past the original window — still settles as success.
  await new Promise((resolve) => setTimeout(resolve, 60));
  conn.injectAck({ command: 400, result: MAV_RESULT.IN_PROGRESS }, 1, 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 1, 1);

  const outcome = await p;
  assert.equal(outcome.result, 'accepted');
  assert.equal(outcome.retries, 0);
});

test('IN_PROGRESS then silence settles timeout at the ceiling with a single send', async () => {
  const conn = stubConn();
  let sends = 0;
  // A retry budget is on the table and must go unspent: the vehicle answered,
  // so the frame did not drop, and re-commanding it would restart the work.
  const waiter = makeWaiter(conn, {
    timeoutMs: 30,
    maxRetries: 3,
    sendFn: () => { sends += 1; },
  });
  const p = waiter.start();
  conn.injectAck({ command: 400, result: MAV_RESULT.IN_PROGRESS }, 1, 1);

  const outcome = await p;

  assert.equal(sends, 1, 'a vehicle that answered is never re-commanded');
  assert.equal(outcome.result, 'timeout');
  assert.equal(outcome.retries, 0);
});

test('silence re-sends with the confirmation byte bumped until the budget is spent, then settles timeout', async () => {
  // The command protocol's confirmation transmissions: 0 is the first send,
  // 1–255 mark re-sends of a frame taken as dropped. Three retries is four
  // sends, then the §9 classification runs on the caller's side.
  const conn = stubConn();
  const confirmations = [];
  const waiter = makeWaiter(conn, {
    timeoutMs: 10,
    maxRetries: 3,
    sendFn: (confirmation) => { confirmations.push(confirmation); },
  });

  const outcome = await waiter.start();

  assert.deepEqual(confirmations, [0, 1, 2, 3]);
  assert.equal(outcome.result, 'timeout');
  assert.equal(outcome.retries, 3, 'the record counts every re-send');
  assert.equal(outcome.detail, 'no terminal COMMAND_ACK received within timeout');
});

test('an ack that answers a silence re-send settles with that retry count', async () => {
  const conn = stubConn();
  let sends = 0;
  const waiter = makeWaiter(conn, {
    timeoutMs: 20,
    maxRetries: 3,
    sendFn: () => { sends += 1; },
  });
  const p = waiter.start();

  // First window passes in silence → one re-send at ~20 ms; the vehicle
  // answers that one.
  await new Promise((resolve) => setTimeout(resolve, 30));
  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 1, 1);

  const outcome = await p;
  assert.equal(sends, 2);
  assert.equal(outcome.result, 'accepted');
  assert.equal(outcome.retries, 1);
  assert.equal(outcome.confirmedBy, 'ack');
});

test('a silence re-send that throws settles the transaction instead of escaping the timer', async () => {
  // Same rule as the TEMPORARILY_REJECTED retry: the re-send runs in timer
  // context with nothing above it to catch, and Connection.send throws by
  // design on a saturated band or dead link.
  const conn = stubConn();
  let sends = 0;
  const waiter = makeWaiter(conn, {
    timeoutMs: 10,
    maxRetries: 3,
    sendFn: () => {
      sends += 1;
      if (sends === 2) throw new Error('queue full');
    },
  });

  const outcome = await waiter.start();

  assert.equal(sends, 2);
  assert.equal(outcome.result, 'send failed');
  assert.equal(outcome.retries, 1);
  assert.equal(outcome.detail, 'retry send failed: queue full');
});
