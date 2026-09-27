'use strict';

/**
 * Per-item retry ceiling and abort (DESIGN.md §9 "Retry per item, with a
 * ceiling, then abort the whole transfer with the sequence number that
 * stalled", §13), plus the upload deadline the per-step ceiling cannot
 * defeat. Uses a fake clock so the timeouts fire deterministically.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MissionDownload } = require('../../lib/mission/download');
const { MissionUpload } = require('../../lib/mission/upload');
const { MISSION_TYPE } = require('../../lib/mission/types');
const { StubConnection, FakeTimers, fakeDeps } = require('./stubs/connection');

const TARGET = { sysid: 1, compid: 1 };

test('download retries a stalled item to the ceiling then aborts naming the sequence', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  let itemRequests = 0;

  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 2, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      // Item 0 is never answered — the vehicle has gone silent mid-transfer.
      itemRequests += 1;
    }
  });

  const machine = new MissionDownload({
    send: (m) => stub.send(m),
    subscribe: (f, h) => stub.subscribe(f, h),
    onProgress: () => {},
    target: TARGET,
    missionType: MISSION_TYPE.MISSION,
    maxRetries: 3,
    timeoutMs: 1000,
    ...fakeDeps(clock),
  });

  const done = machine.start();
  // First request already sent synchronously; drive the retry timers.
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'aborted');
  assert.equal(outcome.seq, 0, 'abort names the stalled sequence');
  assert.match(outcome.reason, /item 0/);
  // 1 initial request + 3 retries = 4 attempts, then abort.
  assert.equal(itemRequests, 4);
  assert.equal(clock.pending(), 0, 'no timer left armed after abort');
});

test('upload retries a stalled count then aborts', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();

  // The vehicle never requests anything after the count is declared.
  stub.onSend(() => {});

  const machine = new MissionUpload({
    send: (m) => stub.send(m),
    subscribe: (f, h) => stub.subscribe(f, h),
    onProgress: () => {},
    target: TARGET,
    missionType: MISSION_TYPE.MISSION,
    items: [{ frame: 3, command: 16, x: 1, y: 2, z: 3 }],
    maxRetries: 2,
    timeoutMs: 500,
    ...fakeDeps(clock),
  });

  const done = machine.start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'aborted');
  // 1 initial count + 2 retries = 3 count sends.
  assert.equal(stub.sent.filter((s) => s.message.name === 'MISSION_COUNT').length, 3);
  assert.equal(stub.sentNames().includes('MISSION_CLEAR_ALL'), false);
});

test('a livelocked upload — same-seq re-requests forever — terminates at the no-progress deadline (#246)', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();

  // The vehicle re-requests seq 0 every 500 ms, always inside the 1000 ms step
  // timeout. Every re-request opens a fresh step, so the per-item retry
  // ceiling never accumulates — without the deadline this ping-pong runs
  // forever. Re-entering the *same* step is not progress, so it never resets
  // the deadline either: the livelock stays bounded by the step budget,
  // 1000 ms × (2 retries + 1).
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } });
    } else if (message.name === 'MISSION_ITEM_INT') {
      clock.setTimeout(
        () => deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } }),
        500
      );
    }
  });

  const machine = new MissionUpload({
    send: (m) => stub.send(m),
    subscribe: (f, h) => stub.subscribe(f, h),
    onProgress: () => {},
    target: TARGET,
    missionType: MISSION_TYPE.MISSION,
    items: [{ frame: 3, command: 16, x: 1, y: 2, z: 3 }],
    maxRetries: 2,
    timeoutMs: 1000,
    ...fakeDeps(clock),
  });

  const done = machine.start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'aborted');
  assert.match(outcome.reason, /no progress .* \(transfer deadline\)/);
  assert.equal(outcome.elapsed, 3000);
  // The livelock really was live: the same item kept being re-answered.
  assert.ok(stub.sent.filter((s) => s.message.name === 'MISSION_ITEM_INT').length >= 5);
  assert.equal(clock.pending(), 0, 'no timer left armed after the deadline abort');
});

test('a livelocked upload — alternating re-requests of two answered items — terminates at the no-progress deadline', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();

  // Same ping-pong as above, but the vehicle alternates seq 0 and seq 1, so
  // every re-request is a *distinct* step label. Progress is the frontier —
  // a sequence never answered before — not the label, so once both items
  // have been answered no re-request re-arms the deadline.
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } });
    } else if (message.name === 'MISSION_ITEM_INT') {
      const next = message.fields.seq === 0 ? 1 : 0;
      clock.setTimeout(
        () => deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: next, mission_type: 0 } }),
        500
      );
    }
  });

  const machine = new MissionUpload({
    send: (m) => stub.send(m),
    subscribe: (f, h) => stub.subscribe(f, h),
    onProgress: () => {},
    target: TARGET,
    missionType: MISSION_TYPE.MISSION,
    items: [
      { frame: 3, command: 16, x: 1, y: 2, z: 3 },
      { frame: 3, command: 16, x: 4, y: 5, z: 6 },
    ],
    maxRetries: 2,
    timeoutMs: 1000,
    ...fakeDeps(clock),
  });

  const done = machine.start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'aborted');
  assert.match(outcome.reason, /no progress .* \(transfer deadline\)/);
  // Item 1 was the last frontier: its first answer re-armed the deadline once.
  assert.equal(outcome.elapsed, 3000 + 500);
  assert.ok(stub.sent.filter((s) => s.message.name === 'MISSION_ITEM_INT').length >= 5);
  assert.equal(clock.pending(), 0, 'no timer left armed after the deadline abort');
});

test('an upload advancing distinct items past the deadline is not aborted (#249)', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();

  // A large mission over a slow link: the vehicle requests every item, but
  // each request comes 20 s after the last answer. The walk runs well past
  // the 50 s deadline (25 s × 2 attempts) — and must finish, because the
  // deadline bounds a transfer making *no* progress, not a slow one (§9).
  const items = Array.from({ length: 6 }, (_, i) => ({ frame: 3, command: 16, x: i, y: i, z: 10 }));
  stub.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } });
      return;
    }
    if (message.name !== 'MISSION_ITEM_INT') return;
    const next = Number(message.fields.seq) + 1;
    clock.setTimeout(() => deliver(next < items.length
      ? { name: 'MISSION_REQUEST_INT', fields: { seq: next, mission_type: 0 } }
      : { name: 'MISSION_ACK', fields: { type: 0, mission_type: 0 } }), 20000);
  });

  const machine = new MissionUpload({
    send: (m) => stub.send(m),
    subscribe: (f, h) => stub.subscribe(f, h),
    onProgress: () => {},
    target: TARGET,
    missionType: MISSION_TYPE.MISSION,
    items,
    maxRetries: 1,
    timeoutMs: 25000,
    ...fakeDeps(clock),
  });

  const done = machine.start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.count, items.length);
  assert.ok(
    outcome.elapsed > 50000,
    `the transfer ran past the deadline (${outcome.elapsed} ms) and still completed`
  );
  assert.equal(clock.pending(), 0, 'no timer left armed after the transfer');
});

test('the deadline is the configured step budget, so it never cuts a retry short (R31)', async () => {
  // A silent vehicle, 20 s × (5 retries + 1): every configured attempt goes
  // out before the transfer fails. A fixed 60 s deadline stopped it after 3.
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend(() => {});

  const machine = new MissionUpload({
    send: (m) => stub.send(m),
    subscribe: (f, h) => stub.subscribe(f, h),
    onProgress: () => {},
    target: TARGET,
    missionType: MISSION_TYPE.MISSION,
    items: [{ frame: 3, command: 16, x: 1, y: 2, z: 3 }],
    maxRetries: 5,
    timeoutMs: 20000,
    ...fakeDeps(clock),
  });

  const done = machine.start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.elapsed, 120000);
  assert.equal(stub.sent.filter((s) => s.message.name === 'MISSION_COUNT').length, 6);
  assert.equal(clock.pending(), 0);
});
