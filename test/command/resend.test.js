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

test('a silent window sends once, then settles the timeout shape', async () => {
  const conn = stubConn();
  let sends = 0;
  const waiter = makeWaiter(conn, { timeoutMs: 10, sendFn: () => { sends += 1; } });

  const outcome = await waiter.start();

  assert.equal(sends, 1, 'the command is sent exactly once');
  assert.deepEqual(
    Object.keys(outcome).sort(),
    ['confirmedBy', 'detail', 'elapsed', 'result', 'resultCode', 'resultParam2', 'retries']
  );
  assert.equal(outcome.result, 'timeout');
  assert.equal(outcome.resultCode, null);
  assert.equal(outcome.confirmedBy, 'none');
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
  const waiter = makeWaiter(conn, { timeoutMs: 30, inProgressCeiling: 2 });
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
  const waiter = makeWaiter(conn, {
    timeoutMs: 30,
    inProgressCeiling: 2,
    sendFn: () => { sends += 1; },
  });
  const p = waiter.start();
  conn.injectAck({ command: 400, result: MAV_RESULT.IN_PROGRESS }, 1, 1);

  const outcome = await p;

  assert.equal(sends, 1, 'a vehicle that answered is never re-commanded');
  assert.equal(outcome.result, 'timeout');
  assert.equal(outcome.retries, 0);
});
