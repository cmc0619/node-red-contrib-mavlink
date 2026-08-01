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

const { checkCompletion, COMPLETION } = require('../../lib/command');
const { StubPeerTable } = require('../../lib/command/test/stubs/connection');

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
