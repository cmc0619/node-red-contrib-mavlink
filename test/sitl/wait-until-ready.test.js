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
  const profile = PROFILE['20-completion-takeoff'];
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
  const profile = PROFILE['34-formation-basics'];
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

test('real 23/29 branch: the arm ack alone no longer classifies PASS (#267)', () => {
  // The old branch keyed on results.includes('accepted') — flow-wide — plus a
  // log string match on the debug node's *name*, so a denied or unsettled goto
  // classified PASS off the arm. It now reads the goto's own record by tag.
  const profile = PROFILE['29-int-carrier-goto'];
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

test('02 requires AP mission/fence/rally success plus a loud PX4 fence failure (no empty false PASS)', () => {
  // The PX4 fence leg fails from the vehicle side — an UNSUPPORTED
  // MISSION_ACK or the transfer deadline — so the profile keys on the row's
  // `failed` result, not on any node-side wording.
  const profile = PROFILE['02-mission-fence-rally'];
  assert.ok(profile, 'profile 02 exists');
  const row = (tag, result, excerpt = '') => ({ tag, result, excerpt, detail: null, resultCode: null });
  const px4Fail = row(
    'debug:px4 fence status',
    'failed',
    "phase: 'ack'\nreason: 'vehicle rejected upload: MAV_MISSION_UNSUPPORTED'"
  );
  const emptyAp = [
    row('debug:mission status', 'failed', "phase: 'empty'"),
    row('debug:fence status', 'failed', "phase: 'empty'"),
    row('debug:rally status', 'failed', "phase: 'empty'"),
    px4Fail,
  ];
  const emptyVerdict = verdictFrom(profile, { debug: emptyAp, errors: [] }, '');
  assert.equal(emptyVerdict.status, 'FAIL', 'AP empty uploads must not PASS on the PX4 failure alone');
  assert.match(emptyVerdict.reason, /AP uploads incomplete/);

  const ok = [
    row('debug:mission status', 'succeeded'),
    row('debug:fence status', 'succeeded'),
    row('debug:rally status', 'succeeded'),
    px4Fail,
  ];
  const pass = verdictFrom(profile, { debug: ok, errors: [] }, '');
  assert.equal(pass.status, 'PASS');
  assert.equal(isSpecializedPass(pass), true);

  // A bounded abort is the same loud answer with different words — the
  // transfer machine settles the no-progress deadline and the retry ceiling
  // as phase 'aborted', with reasons spelled by transfer.js.
  for (const reason of [
    'no progress at count for 90000 ms (transfer deadline)',
    'stalled at count after 4 retries',
  ]) {
    const bounded = ok.slice(0, 3).concat(
      row('debug:px4 fence status', 'failed', `phase: 'aborted'\nreason: '${reason}'`)
    );
    assert.equal(verdictFrom(profile, { debug: bounded, errors: [] }, '').status, 'PASS',
      `${reason} is a measured bound`);
  }

  // A missing PX4 row is not a measurement.
  const missing = ok.slice(0, 3);
  assert.notEqual(verdictFrom(profile, { debug: missing, errors: [] }, '').status, 'PASS');

  // Neither is a row that died before the mission protocol ran: an empty
  // upload, a connection fault — `failed` with a non-transfer phase measured
  // nothing, and must not PASS on the AP rows' coattails (Codex, #287).
  // A synchronous send failure wears phase 'aborted' too (start() and the
  // retry path both settle a throwing send that way), so the phase alone is
  // not the discriminator — the reason is (Codex, #287, round 2).
  for (const excerpt of [
    "phase: 'empty'",
    "phase: 'error'\nreason: 'requires a Connection'",
    "phase: 'aborted'\nreason: 'count send failed: bulk queue saturated'",
    "phase: 'aborted'\nreason: 'start send failed: connection closed'",
  ]) {
    const preProtocol = ok.slice(0, 3).concat(row('debug:px4 fence status', 'failed', excerpt));
    assert.notEqual(verdictFrom(profile, { debug: preProtocol, errors: [] }, '').status, 'PASS',
      `${excerpt.split('\n')[0]} is not a mission-protocol measurement`);
  }
});

test('27/30 read the unified vocabulary — and \'succeeded\' stays banned', () => {
  // The two node families used to disagree on words: Move published
  // 'succeeded'/'timeout' where Command published 'accepted'/'unconfirmed',
  // and keying 27/30 on the wrong family's words made 27 unable to pass and
  // let 30's silence through as a measurement (#267, one carrier over). The
  // vocabulary is now one: Move's reposition path publishes the AckWaiter
  // outcome verbatim, exactly as mavlink-command does. These pins hold the
  // harness to the unified words — and hold 'succeeded' out of the branch,
  // so a producer regression to the old word reads as never-settled (FAIL),
  // not as a pass.
  const reposition = (result, detail, resultCode) => ({
    tag: 'debug:reposition status (resultCode + retries)',
    result, detail, resultCode, excerpt: '',
  });
  const arm = { tag: 'debug:arm status', result: 'accepted', detail: null, resultCode: 0, excerpt: '' };
  const run = (key, record) =>
    verdictFrom(PROFILE[key], { debug: record ? [arm, record] : [arm], errors: [] }, '');

  // 27 asserts ArduPilot accepts.
  assert.equal(run('27-move-reposition-carrier', reposition('accepted', null, 0)).status, 'PASS');
  assert.equal(run('27-move-reposition-carrier', reposition('denied', null, 2)).status, 'FAIL');

  // 30 measures: any answer PX4 gives passes, silence does not.
  assert.equal(run('30-px4-move-reposition', reposition('accepted', null, 0)).status, 'PASS');
  assert.equal(run('30-px4-move-reposition', reposition('denied', null, 2)).status, 'PASS');

  // A lost ack is 'unconfirmed' (§9) and carries no resultCode: nothing was
  // measured, on either example.
  for (const key of ['27-move-reposition-carrier', '30-px4-move-reposition']) {
    assert.equal(run(key, reposition('unconfirmed', 'ack timeout', null)).status, 'FAIL');
    // A send that threw before the wire spells 'failed', with no code.
    assert.equal(run(key, reposition('failed', 'connection closed', null)).status, 'FAIL');
    assert.equal(run(key, null).status, 'FAIL', 'no record at all');
    // The banned word: a regression to 'succeeded' must read as not-measured,
    // never as acceptance.
    assert.equal(run(key, reposition('succeeded', 'accepted', 0)).status, 'FAIL');
  }
});

test('39 requires healthy, lease-expired, and faulted — command-shaped goods do not PASS', () => {
  const profile = PROFILE['39-companion-health-lease'];
  assert.ok(profile, 'profile 39 exists');
  assert.equal(profile.injectGapMs, 6000, 'gap must outlast the 5 s lease');
  const row = (result) => ({
    tag: 'debug:health status',
    result,
    excerpt: `result: '${result}'`,
    detail: null,
    resultCode: null,
  });
  const accepted = {
    tag: 'debug:health continue',
    result: 'accepted',
    excerpt: "result: 'accepted'",
    detail: null,
    resultCode: null,
  };
  assert.equal(
    verdictFrom(profile, { debug: [accepted], errors: [] }, '').status,
    'FAIL',
    'an accepted-shaped record is not the lease story'
  );
  assert.equal(
    verdictFrom(profile, { debug: [row('healthy'), row('faulted')], errors: [] }, '').status,
    'FAIL',
    'fatal-only path skips the advertised lapse'
  );
  const pass = verdictFrom(
    profile,
    { debug: [row('healthy'), row('lease-expired'), row('faulted')], errors: [] },
    ''
  );
  assert.equal(pass.status, 'PASS');
  assert.equal(isSpecializedPass(pass), true);
});

test('40 requires armed/mode/landed feed events — command accepteds do not PASS', () => {
  const profile = PROFILE['40-transition-events'];
  assert.ok(profile, 'profile 40 exists');
  assert.equal(
    profile.prep,
    'ap-guided-arm-stabilize-1',
    'must prove GUIDED-armable then return to STABILIZE; ap-guided-1 would hide mode-changed'
  );
  const armAck = {
    tag: 'debug:arm status',
    result: 'accepted',
    excerpt: "result: 'accepted'",
    detail: null,
    resultCode: 0,
  };
  assert.equal(
    verdictFrom(profile, { debug: [armAck], errors: [] }, '').status,
    'FAIL',
    'arm accepted alone is the #267 fiction'
  );
  const feed = (event) => ({
    tag: 'debug:transition events',
    result: null,
    excerpt: `{ kind: 'transition',\n  event: '${event}',\n  sysid: 1,\n  compid: 1 }`,
    detail: null,
    resultCode: null,
  });
  const incomplete = verdictFrom(
    profile,
    { debug: [armAck, feed('armed-changed'), feed('mode-changed')], errors: [] },
    ''
  );
  assert.equal(incomplete.status, 'FAIL');
  const pass = verdictFrom(
    profile,
    {
      debug: [
        armAck,
        feed('armed-changed'),
        feed('mode-changed'),
        feed('landed-changed'),
      ],
      errors: [],
    },
    ''
  );
  assert.equal(pass.status, 'PASS');
  assert.equal(isSpecializedPass(pass), true);
});
