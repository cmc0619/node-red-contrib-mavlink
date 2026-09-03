'use strict';

/**
 * Completion-condition tests (DESIGN.md §9 "Ack is not completion").
 *
 * Focus: DO_SET_MODE completion reads the custom mode from param 2 (params[1]),
 * matching the MAV_CMD_DO_SET_MODE layout (param1 = base_mode, param2 =
 * custom_mode, param3 = custom_submode). Reading param 3 would compare against
 * the submode and confirm on the wrong field.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCompletion, waitForCompletion, COMPLETION } = require('../../lib/command');
const { StubPeerTable } = require('../../lib/command/test/stubs/connection');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function peerWithMode(sysid, compid, flightMode) {
  const pt = new StubPeerTable();
  pt.setComponent(sysid, compid, { flightMode });
  return pt;
}

test('DO_SET_MODE completion matches the requested custom mode from param 2 (params[1])', () => {
  // params = [base_mode, custom_mode, submode, 0, 0, 0, 0]
  const params = [1, 4, 0, 0, 0, 0, 0];
  const pt = peerWithMode(3, 1, 4);
  const res = checkCompletion(COMPLETION.SET_MODE, params, pt, 3, 1);
  assert.equal(res.done, true);
});

test('DO_SET_MODE completion stays pending when the active mode differs from param 2', () => {
  const params = [1, 4, 0, 0, 0, 0, 0];
  // Vehicle is in mode 9, not the requested custom mode 4.
  const pt = peerWithMode(3, 1, 9);
  const res = checkCompletion(COMPLETION.SET_MODE, params, pt, 3, 1);
  assert.equal(res.done, false);
});

test('DO_SET_MODE completion matches custom mode 0 when the vehicle is in mode 0', () => {
  // custom_mode 0 is a real mode (ArduPilot STABILIZE); a truthiness test would
  // wrongly report success the moment a peer exists. It must compare against 0.
  const params = [1, 0, 0, 0, 0, 0, 0];
  const pt = peerWithMode(3, 1, 0);
  const res = checkCompletion(COMPLETION.SET_MODE, params, pt, 3, 1);
  assert.equal(res.done, true);
});

test('DO_SET_MODE completion stays pending when custom mode 0 is requested but the vehicle is in another mode', () => {
  const params = [1, 0, 0, 0, 0, 0, 0];
  const pt = peerWithMode(3, 1, 5);
  const res = checkCompletion(COMPLETION.SET_MODE, params, pt, 3, 1);
  assert.equal(res.done, false);
});

test('a base-mode-only DO_SET_MODE is unverifiable — never done, never falsely confirmed', () => {
  // checkCompletion receives the *requested* params, sparse — the command
  // node's wire array zero-fills, and a filler 0 is indistinguishable from
  // requesting mode 0. With param 2 never supplied, state can neither
  // confirm nor deny the set: not `done` (an ack-timeout caller reporting
  // "accepted" off a merely-existing peer would be a false success, §0
  // rule 3), and flagged unverifiable so the post-ack wait settles from the
  // accepted ack instead of running into a false timeout.
  const params = [1, undefined, undefined, undefined, undefined, undefined, undefined];
  const pt = peerWithMode(3, 1, 5);
  const res = checkCompletion(COMPLETION.SET_MODE, params, pt, 3, 1);
  assert.equal(res.done, false);
  assert.equal(res.unverifiable, true);
});

test('a base-only DO_SET_MODE is unverifiable even before the peer has reported', () => {
  // Unverifiability is a property of the request, not the table. The peer
  // gate must not answer first: a set addressed at a compid the table never
  // holds (0 = all components; an autopilot acking from another id) would
  // otherwise read "peer not in table" and wait out the whole completion
  // window after an accepted ack.
  const params = [1, undefined, undefined, undefined, undefined, undefined, undefined];
  const res = checkCompletion(COMPLETION.SET_MODE, params, new StubPeerTable(), 3, 0);
  assert.equal(res.done, false);
  assert.equal(res.unverifiable, true);
});

test('waitForCompletion settles an unverifiable condition as success confirmed by the ack', async () => {
  // The wait only ever runs after an ACCEPTED ack (the complete tier), so
  // for a condition state can never speak to, the ack is the whole
  // confirmation — attributed honestly, not as 'state'.
  const params = [1, undefined, undefined, undefined, undefined, undefined, undefined];
  const pt = peerWithMode(3, 1, 5);
  const wait = waitForCompletion({
    completionKey: COMPLETION.SET_MODE,
    params,
    peerTable: pt,
    sysid: 3,
    compid: 1,
    timeoutMs: 50,
  });
  const outcome = await wait.promise;
  assert.equal(outcome.success, true);
  assert.equal(outcome.confirmedBy, 'ack');
});

// ── TAKEOFF altitude datum by frame (issue #98c) ─────────────────────────────

/** A peer whose GLOBAL_POSITION_INT carries distinct AMSL and relative alts. */
function peerWithAlts(sysid, compid, altMm, relativeAltMm) {
  const pt = new StubPeerTable();
  pt.setComponent(sysid, compid, { position: { alt: altMm, relativeAlt: relativeAltMm } });
  return pt;
}

// Home elevation 500 m: vehicle at 20 m AGL reads relative_alt 20 m, alt 520 m.
const TAKEOFF_PARAMS = [0, 0, 0, 0, 0, 0, 20]; // param7 (index 6) = 20 m target

test('TAKEOFF completion compares relative_alt for COMMAND_LONG (no frame)', () => {
  const pt = peerWithAlts(1, 1, 520000, 20000);
  const res = checkCompletion(COMPLETION.TAKEOFF, TAKEOFF_PARAMS, pt, 1, 1); // frame undefined
  assert.equal(res.done, true, '20 m relative ≥ 20 m target');
});

test('TAKEOFF completion compares relative_alt for a relative frame (GLOBAL_RELATIVE_ALT_INT = 6)', () => {
  const pt = peerWithAlts(1, 1, 520000, 20000);
  const res = checkCompletion(COMPLETION.TAKEOFF, TAKEOFF_PARAMS, pt, 1, 1, 6);
  assert.equal(res.done, true);
  assert.match(res.detail, /rel/);
});

test('TAKEOFF completion compares AMSL for an absolute frame (GLOBAL_INT = 5) — no false timeout', () => {
  // The bug: comparing the 520 m AMSL target against 20 m relative_alt would
  // never satisfy, timing out a successful takeoff. With the AMSL datum the
  // 520 m reading meets the 520 m target.
  const amslParams = [0, 0, 0, 0, 0, 0, 520];
  const pt = peerWithAlts(1, 1, 520000, 20000);
  const res = checkCompletion(COMPLETION.TAKEOFF, amslParams, pt, 1, 1, 5);
  assert.equal(res.done, true, 'AMSL 520 m ≥ 520 m target');
  assert.match(res.detail, /AMSL/);
});

test('TAKEOFF completion stays pending on an absolute frame until the AMSL target is reached', () => {
  const amslParams = [0, 0, 0, 0, 0, 0, 520];
  const pt = peerWithAlts(1, 1, 505000, 5000); // only 5 m up: 505 m AMSL
  const res = checkCompletion(COMPLETION.TAKEOFF, amslParams, pt, 1, 1, 5);
  assert.equal(res.done, false);
});

// ── waitForCompletion cancel handle (accepted-risk M1) ───────────────────────

/** Peer table that counts every poll's peer lookup and never satisfies. */
function countingPeerTable() {
  const counter = { polls: 0 };
  counter.table = { getComponent() { counter.polls++; return undefined; } };
  return counter;
}

test('waitForCompletion cancel settles promptly with cancelled: true and clears both timers', async () => {
  const counter = countingPeerTable();
  const wait = waitForCompletion({
    completionKey: COMPLETION.ARM,
    params: [1, 0, 0, 0, 0, 0, 0],
    peerTable: counter.table,
    sysid: 1,
    compid: 1,
    pollMs: 5,
    timeoutMs: 1000,
  });

  wait.cancel();
  const outcome = await wait.promise;
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.success, false);
  assert.equal(outcome.confirmedBy, 'none');

  // Cleared timers: no poll runs after cancel, and no timeout is pending to
  // hold the process open for the remaining timeoutMs.
  const pollsAtCancel = counter.polls;
  await sleep(25);
  assert.equal(counter.polls, pollsAtCancel, 'no late poll after cancel');
});

test('waitForCompletion settles once: a second cancel after cancel is a no-op', async () => {
  const counter = countingPeerTable();
  const wait = waitForCompletion({
    completionKey: COMPLETION.ARM,
    params: [1, 0, 0, 0, 0, 0, 0],
    peerTable: counter.table,
    sysid: 1,
    compid: 1,
    pollMs: 5,
    timeoutMs: 1000,
  });

  wait.cancel();
  wait.cancel();
  const outcome = await wait.promise;
  assert.equal(outcome.cancelled, true);
});

test('waitForCompletion settles once: cancel after a normal settle does not rewrite the outcome', async () => {
  const pt = new StubPeerTable();
  pt.setComponent(1, 1, { armed: true }); // ARM satisfied on the immediate poll
  const wait = waitForCompletion({
    completionKey: COMPLETION.ARM,
    params: [1, 0, 0, 0, 0, 0, 0],
    peerTable: pt,
    sysid: 1,
    compid: 1,
    pollMs: 5,
    timeoutMs: 1000,
  });

  wait.cancel();
  const outcome = await wait.promise;
  assert.equal(outcome.success, true, 'first settle wins');
  assert.equal(outcome.cancelled, undefined);
});

test('TAKEOFF completion reports missing AMSL position data for an absolute frame', () => {
  // relative_alt present but alt absent: an absolute frame cannot derive the
  // climb target without AMSL, so it must stay pending rather than fall back to
  // the relative datum and confirm on the wrong number.
  const amslParams = [0, 0, 0, 0, 0, 0, 520];
  const pt = peerWithAlts(1, 1, undefined, 20000);
  const res = checkCompletion(COMPLETION.TAKEOFF, amslParams, pt, 1, 1, 5);
  assert.equal(res.done, false);
  assert.match(res.detail, /no AMSL position data/);
});


test('LAND completion without position: disarmed in MAV_STATE_STANDBY is landed', () => {
  const pt = new StubPeerTable();
  pt.setComponent(3, 1, { armed: false, systemStatus: 3 });
  const res = checkCompletion(COMPLETION.LAND, [0, 0, 0, 0, 0, 0, 0], pt, 3, 1);
  assert.equal(res.done, true);
});

test('LAND completion without position: disarmed in MAV_STATE_POWEROFF (7) is not landed', () => {
  // Neither stack reports POWEROFF on landing; a vehicle shutting down is not
  // a completed LAND.
  const pt = new StubPeerTable();
  pt.setComponent(3, 1, { armed: false, systemStatus: 7 });
  const res = checkCompletion(COMPLETION.LAND, [0, 0, 0, 0, 0, 0, 0], pt, 3, 1);
  assert.equal(res.done, false);
});
