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

test('early-exits when verdict becomes specialized PASS', async () => {
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
    verdict: () => ({
      status: statuses[Math.min(calls - 1, statuses.length - 1)],
      reason: 'Lucy: spread + sphere pitch steps + peel land succeeded',
    }),
  });
  assert.equal(result.ready, true);
  assert.equal(result.verdict.status, 'PASS');
  assert.equal(calls, 3);
  assert.ok(result.waitedMs < 10_000);
});

test('does not early-exit on generic results: PASS (first ack)', async () => {
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
    verdict: () => ({ status: 'PASS', reason: 'results: accepted' }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.verdict.status, 'PASS');
  assert.equal(result.verdict.reason, 'results: accepted');
  assert.ok(result.waitedMs >= 1000);
  assert.ok(calls >= 2);
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
    // Distinct status only on the post-deadline snapshot proves the final eval ran.
    verdict: () =>
      clock.now() >= 1000
        ? { status: 'FAIL', reason: 'deadline snapshot' }
        : { status: 'UNKNOWN', reason: 'never' },
  });
  assert.equal(result.ready, false);
  assert.equal(result.verdict.status, 'FAIL');
  assert.equal(result.verdict.reason, 'deadline snapshot');
  assert.ok(result.waitedMs >= 1000);
  assert.ok(calls >= 2);
});

// ── Coupling pins: the gate against the REAL verdictFrom ─────────────────────
//
// isSpecializedPass excludes generic PASSes by their reason string, which
// verdictFrom's fallback tail composes in another file. Every test above
// stubs that string, so rewording the tail would silently reopen #254's
// first-ack early exit (measured: example 01 froze at 0.1 s) with the suite
// still green. These pins drive the real functions end to end (#252 lesson:
// stubs go green over fictions the real path cannot produce).

const { isSpecializedPass } = require('../../sitl/lib/wait-until-ready');
const { PROFILE, verdictFrom } = require('../../sitl/run-example-suite');

test('real generic tail: first-ack PASS is not a specialized PASS (#254 P1)', () => {
  // Example 01 the moment the arm acks, takeoff still climbing: exactly the
  // snapshot that froze the run at 0.1 s.
  const profile = PROFILE['01-completion-takeoff'];
  assert.ok(profile, 'profile 01 exists');
  const summary = {
    debug: [{ tag: 'arm status', result: 'accepted', excerpt: "result: 'accepted'" }],
    errors: [],
  };
  const verdict = verdictFrom(profile, summary, '');
  assert.equal(verdict.status, 'PASS', 'generic tail still PASSes on one good result');
  assert.equal(
    isSpecializedPass(verdict),
    false,
    'the gate must recognize the real generic reason — if this fails, the tail reason and the gate regex have drifted apart'
  );
});

test('real specialized PASS reasons never collide with the generic exclusion', () => {
  // A specialized branch whose reason started with "results:" would be barred
  // from early exit — harmless — but the reverse drift (generic reason no
  // longer matching) reopens the hole. Pin the one live "results:" producer.
  const profile = PROFILE['26-formation-basics'];
  assert.ok(profile, 'profile 26 exists');
  const summary = {
    debug: [
      { tag: 'line status', result: 'succeeded', excerpt: '' },
      { tag: 'circle status', result: 'succeeded', excerpt: '' },
    ],
    errors: [],
  };
  const verdict = verdictFrom(profile, summary, '');
  assert.equal(verdict.status, 'PASS');
  assert.equal(isSpecializedPass(verdict), true, 'conjunctive terminal PASS early-exits');
});

test('real 17/19 branch: the arm ack alone no longer classifies PASS (#267)', () => {
  // The old branch keyed on results.includes('accepted') — flow-wide — plus a
  // log string match on the debug node's *name*, so a denied or unsettled goto
  // classified PASS off the arm. It now reads the goto's own record by tag.
  const profile = PROFILE['17-int-carrier-goto'];
  assert.ok(profile, 'profile 17 exists');
  // Did the example test the thing? With no goto record it never exercised its
  // subject, so it failed to test the thing — FAIL, not half credit. Safe
  // mid-poll: waitUntilReady early-exits on specialized PASS only, so a FAIL
  // keeps polling and the deadline recomputes.
  const armOnly = { debug: [{ tag: 'arm status', result: 'accepted', excerpt: '' }], errors: [] };
  const unsettled = verdictFrom(profile, armOnly, '');
  assert.equal(unsettled.status, 'FAIL', 'arm alone is not the story');
  assert.match(unsettled.reason, /never settled|not measured/);
  assert.equal(isSpecializedPass(unsettled), false, 'a FAIL must not early-exit the wait');

  const gotoDenied = {
    debug: [
      { tag: 'arm status', result: 'accepted', excerpt: '' },
      { tag: 'goto status', result: 'denied', excerpt: '' },
    ],
    errors: [],
  };
  const denied = verdictFrom(profile, gotoDenied, '');
  assert.equal(denied.status, 'FAIL', 'a denied goto is a failure, not a fall-through');
  assert.match(denied.reason, /denied/);

  const gotoOk = {
    debug: [
      { tag: 'arm status', result: 'accepted', excerpt: '' },
      { tag: 'goto status', result: 'accepted', excerpt: '' },
    ],
    errors: [],
  };
  const ok = verdictFrom(profile, gotoOk, '');
  assert.equal(ok.status, 'PASS');
  assert.equal(isSpecializedPass(ok), true, 'goto-accepted PASS stays early-exit eligible');
});

test('37/38 read mavlink-move\'s status vocabulary, not mavlink-command\'s', () => {
  // The two node families do not agree on words. An accepted reposition is
  // published by completeResult as result 'succeeded' (detail 'accepted'); a
  // lost ack is 'timeout', not 'timed-out'; a terminal MAV_RESULT is 'failed'
  // carrying its resultCode. Keying these examples on the Command node's
  // 'accepted'/'timed-out' made 37 unable to pass at all and let 38's silence
  // through as a measurement — the exact fiction the branch exists to stop.
  const reposition = (result, detail, resultCode) => ({
    tag: 'debug:reposition status (resultCode + retries)',
    result, detail, resultCode, excerpt: '',
  });
  const arm = { tag: 'debug:arm status', result: 'accepted', detail: null, resultCode: 0, excerpt: '' };
  const run = (key, record) =>
    verdictFrom(PROFILE[key], { debug: record ? [arm, record] : [arm], errors: [] }, '');

  // 37 asserts ArduPilot accepts.
  assert.equal(run('37-move-reposition-carrier', reposition('succeeded', 'accepted', 0)).status, 'PASS');
  assert.equal(run('37-move-reposition-carrier', reposition('failed', 'denied', 2)).status, 'FAIL');

  // 38 measures: any answer PX4 gives passes, silence does not.
  assert.equal(run('38-px4-move-reposition', reposition('succeeded', 'accepted', 0)).status, 'PASS');
  assert.equal(run('38-px4-move-reposition', reposition('failed', 'denied', 2)).status, 'PASS');

  // A timeout carries no resultCode: nothing was measured, on either example.
  for (const key of ['37-move-reposition-carrier', '38-px4-move-reposition']) {
    assert.equal(run(key, reposition('timeout', 'ack timeout', null)).status, 'FAIL');
    // A send that threw before the wire also spells 'failed', but with no code.
    assert.equal(run(key, reposition('failed', 'connection closed', null)).status, 'FAIL');
    assert.equal(run(key, null).status, 'FAIL', 'no record at all');
  }
});
