'use strict';

/**
 * Per-item retry ceiling and abort (DESIGN.md §9 "Retry per item, with a
 * ceiling, then abort the whole transfer with the sequence number that
 * stalled", §13). Uses a fake clock so the timeouts fire deterministically.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MissionDownload, MissionUpload, MISSION_TYPE } = require('../../lib/mission');
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
