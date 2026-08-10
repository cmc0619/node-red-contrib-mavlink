'use strict';

/**
 * AckWaiter timeout retransmit and IN_PROGRESS ceiling tests (#248, DESIGN.md
 * §9 "A missing ack is not a failure").
 *
 * Retransmit precedes the §9 timeout classification: a silent ack window is
 * re-sent up to DEFAULT_MAX_RESENDS times, and only the final window's close
 * settles 'timeout' — with the same terminal shape as before, the attempt
 * count riding the existing `retries` field (it counts all re-transmissions,
 * so it stays equal to the final LONG confirmation byte; no new field).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { AckWaiter, MAV_RESULT } = require('../../lib/command');
const { DEFAULT_MAX_RESENDS, DEFAULT_IN_PROGRESS_CEILING } = require('../../lib/command/ack');

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
    commandId: 400,
    targetSystem: 1,
    targetComponent: 1,
    ...opts,
  });
}

test('the resend and ceiling defaults are pinned to their literals', () => {
  // Pinned to the literal — a constant compared to itself passes at any value
  // (the DEFAULT_FRAME lesson, §14). 3 is MAVSDK parity.
  assert.equal(DEFAULT_MAX_RESENDS, 3);
  assert.equal(DEFAULT_IN_PROGRESS_CEILING, 6);
});

test('a silent window re-sends 3 times with incremented confirmation, then settles the unchanged timeout shape', async () => {
  const conn = stubConn();
  const confirmations = [];
  const waiter = makeWaiter(conn, {
    timeoutMs: 10,
    sendFn: (confirmation) => confirmations.push(confirmation),
  });

  const outcome = await waiter.start();

  assert.deepEqual(confirmations, [0, 1, 2, 3], 'each re-send increments the confirmation byte');
  // Terminal shape byte-identical to the pre-#248 settle, except `retries` now
  // carries the re-transmission count — deliberately no new field.
  assert.deepEqual(
    Object.keys(outcome).sort(),
    ['confirmedBy', 'detail', 'elapsed', 'result', 'resultCode', 'retries']
  );
  assert.equal(outcome.result, 'timeout');
  assert.equal(outcome.resultCode, null);
  assert.equal(outcome.confirmedBy, 'none');
  assert.equal(outcome.retries, 3);
  assert.equal(outcome.detail, 'no COMMAND_ACK received within timeout');
});

test('an ack landing after a re-send settles normally, retries counting the re-sends', async () => {
  const conn = stubConn();
  let sends = 0;
  const waiter = makeWaiter(conn, {
    timeoutMs: 10,
    sendFn: () => {
      sends += 1;
      // The vehicle hears the second transmission and accepts.
      if (sends === 2) conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 1, 1);
    },
  });

  const outcome = await waiter.start();

  assert.equal(outcome.result, 'accepted');
  assert.equal(outcome.resultCode, MAV_RESULT.ACCEPTED);
  assert.equal(outcome.confirmedBy, 'ack');
  assert.equal(outcome.retries, 1, 'one re-send preceded the ack');
  assert.equal(sends, 2, 'no further transmission after the ack');
});

test('onResend reports each attempt as (attempt, max)', async () => {
  const conn = stubConn();
  const reported = [];
  const waiter = makeWaiter(conn, {
    timeoutMs: 10,
    onResend: (attempt, max) => reported.push([attempt, max]),
  });

  await waiter.start();

  assert.deepEqual(reported, [[1, 3], [2, 3], [3, 3]]);
});

test('noAutoRetry commands never re-send: one window, then timeout (§9 — restart/toggle commands)', async () => {
  const conn = stubConn();
  let sends = 0;
  const waiter = makeWaiter(conn, {
    timeoutMs: 10,
    noAutoRetry: true,
    sendFn: () => { sends += 1; },
  });

  const outcome = await waiter.start();

  assert.equal(sends, 1, 'a lost PREFLIGHT_REBOOT must not be re-sent');
  assert.equal(outcome.result, 'timeout');
  assert.equal(outcome.retries, 0);
});

test('a re-send that throws settles the transaction instead of escaping the timer', async () => {
  // Same rule as the TEMPORARILY_REJECTED retry: the re-send fires from a
  // setTimeout where nothing above catches, on exactly the saturated or
  // dropped link most likely to make Connection.send throw.
  const conn = stubConn();
  let sends = 0;
  const waiter = makeWaiter(conn, {
    timeoutMs: 10,
    sendFn: () => {
      sends += 1;
      if (sends > 1) throw new Error('queue overflow on control band');
    },
  });

  const outcome = await waiter.start();

  assert.equal(outcome.result, 'send failed');
  assert.match(outcome.detail, /resend failed: queue overflow/);
  assert.equal(outcome.retries, 1);
});

test('repeated IN_PROGRESS cannot extend the wait past the aggregate ceiling', async () => {
  const conn = stubConn();
  // Ceiling 2 → the wait may run to 2 × timeoutMs from start, no further.
  // Without the ceiling this test never finishes: every injection re-armed
  // the full window ahead of its expiry.
  const waiter = makeWaiter(conn, { timeoutMs: 30, inProgressCeiling: 2, maxResends: 0 });
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
  const waiter = makeWaiter(conn, { timeoutMs: 100, maxResends: 0 });
  const p = waiter.start();

  // Keep-waiting semantics unchanged: progress at 60 ms re-arms, so ACCEPTED
  // at 140 ms — past the original window — still settles as success.
  await new Promise((resolve) => setTimeout(resolve, 60));
  conn.injectAck({ command: 400, result: MAV_RESULT.IN_PROGRESS }, 1, 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  conn.injectAck({ command: 400, result: MAV_RESULT.ACCEPTED }, 1, 1);

  const outcome = await p;
  assert.equal(outcome.result, 'accepted');
  assert.equal(outcome.retries, 0);
});
