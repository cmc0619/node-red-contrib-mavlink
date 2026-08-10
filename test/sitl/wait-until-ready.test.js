'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitUntilReady } = require('../../sitl/lib/wait-until-ready');

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
}

test('early-exits when verdict becomes PASS', async () => {
  const clock = fakeClock();
  let calls = 0;
  const statuses = ['UNKNOWN', 'UNKNOWN', 'PASS'];
  const result = await waitUntilReady({
    waitMs: 10_000,
    pollMs: 500,
    now: clock.now,
    sleep: clock.sleep,
    snapshot: () => {
      calls += 1;
      return { summary: { debug: [], errors: [] }, log: `tick-${calls}` };
    },
    verdict: () => ({ status: statuses[Math.min(calls - 1, statuses.length - 1)], reason: 'x' }),
  });
  assert.equal(result.ready, true);
  assert.equal(result.verdict.status, 'PASS');
  assert.equal(calls, 3);
  assert.ok(result.waitedMs < 10_000);
});

test('does not early-exit on PARTIAL or FAIL', async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await waitUntilReady({
    waitMs: 1500,
    pollMs: 500,
    now: clock.now,
    sleep: clock.sleep,
    snapshot: () => {
      calls += 1;
      return { summary: {}, log: '' };
    },
    verdict: () =>
      calls < 3
        ? { status: calls === 1 ? 'PARTIAL' : 'FAIL', reason: 'incomplete' }
        : { status: 'PASS', reason: 'done' },
  });
  assert.equal(result.ready, true);
  assert.equal(result.verdict.status, 'PASS');
  assert.ok(calls >= 3);
});

test('readyWhen override can declare ready without PASS', async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await waitUntilReady({
    waitMs: 10_000,
    pollMs: 200,
    now: clock.now,
    sleep: clock.sleep,
    readyWhen: (_summary, log) => log.includes('marker'),
    snapshot: () => {
      calls += 1;
      return {
        summary: {},
        log: calls >= 2 ? 'marker present' : 'waiting',
      };
    },
    verdict: () => ({ status: 'PARTIAL', reason: 'still partial' }),
  });
  assert.equal(result.ready, true);
  assert.equal(result.verdict.status, 'PARTIAL');
  assert.equal(calls, 2);
});

test('timeout returns final verdict without ready', async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await waitUntilReady({
    waitMs: 1000,
    pollMs: 400,
    now: clock.now,
    sleep: clock.sleep,
    snapshot: () => {
      calls += 1;
      return { summary: {}, log: '' };
    },
    verdict: () => ({ status: 'UNKNOWN', reason: 'never' }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.verdict.status, 'UNKNOWN');
  assert.ok(result.waitedMs >= 1000);
  assert.ok(calls >= 2);
});
