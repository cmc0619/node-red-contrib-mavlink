'use strict';

/**
 * Preset pinning tests (DESIGN.md §9 "Command presets", brief: preset pinning).
 *
 * A preset is (command, pinnedParams, exposedParams, name). These tests verify
 * that:
 *   1. Pinned params appear at their declared indices regardless of what the
 *      user provides.
 *   2. Exposed params appear at their declared indices when the user provides
 *      values.
 *   3. The pair (Arm, Disarm) pins param 1 to opposite values on the same
 *      commandId (400).
 *   4. The pair (Yaw, Rotate) pins param 4 to opposite values on the same
 *      commandId (115).
 *   5. Presets marked noAutoRetry are not idempotent (MISSION_START,
 *      PREFLIGHT_REBOOT_SHUTDOWN).
 *   6. Safety presets carry requiresConfirmation.
 *   7. Completion keys are present for the four commands that support them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPreset, buildParamArray, mergeParams, PRESETS, COMPLETION, presetGroups } = require('../../lib/command');

// ── Helpers ────────────────────────────────────────────────────────────────

function emptyUser() { return {}; }

/**
 * Build the param array for `presetId` with the given user values, and assert
 * that index `paramIndex` (1-based) equals `expected`.
 */
function assertParamAt(presetId, userParams, paramIndex, expected) {
  const preset = getPreset(presetId);
  assert.ok(preset, `preset '${presetId}' must exist`);
  const arr = buildParamArray(preset, userParams);
  assert.equal(arr[paramIndex - 1], expected,
    `preset '${presetId}' param ${paramIndex}: expected ${expected}, got ${arr[paramIndex - 1]}`);
}

// ── Arm / Disarm ───────────────────────────────────────────────────────────

test('Arm and Disarm share commandId 400', () => {
  assert.equal(getPreset('arm').commandId, 400);
  assert.equal(getPreset('disarm').commandId, 400);
});

test('Arm pins param 1 to 1', () => {
  assertParamAt('arm', emptyUser(), 1, 1);
});

test('Disarm pins param 1 to 0', () => {
  assertParamAt('disarm', emptyUser(), 1, 0);
});

test('Arm: user cannot override pinned param 1', () => {
  assertParamAt('arm', { 1: 99 }, 1, 1);
});

test('Disarm: user cannot override pinned param 1', () => {
  assertParamAt('disarm', { 1: 99 }, 1, 0);
});

test('Arm: exposed param 2 (Force) passes user value', () => {
  assertParamAt('arm', { 2: 21196 }, 2, 21196);
});

test('Arm: exposed param 2 defaults to 0 when user omits it', () => {
  assertParamAt('arm', emptyUser(), 2, 0);
});

// ── Motion-preset ownership (§6 redesign, 2026-08-12) ──────────────────────
//
// Move owns motion intents; Command curates everything else. Yaw and Rotate
// (CONDITION_YAW) are deleted — the raw MAV_CMD path keeps the capability —
// and Go To / Reposition leaves the operator surface while its row stays as
// the shared DO_REPOSITION metadata mavlink-formation builds from.

test('yaw and rotate are gone from the curated list — Move owns motion', () => {
  assert.equal(getPreset('yaw'), undefined);
  assert.equal(getPreset('rotate'), undefined);
  const offered = presetGroups().flatMap((g) => g.presets.map((p) => p.id));
  assert.ok(!offered.includes('yaw'));
  assert.ok(!offered.includes('rotate'));
});

test('reposition is library metadata, not operator surface', () => {
  // Formation builds from the row (blankParams sentinels, commandId), so it
  // must exist — and the Command editor must not offer it, or the goto is
  // duplicated across two nodes again.
  const row = getPreset('reposition');
  assert.equal(row.commandId, 192);
  assert.equal(row.listed, false);
  assert.equal(row.blankParams[1], -1, 'speed sentinel rides with the row');
  assert.ok(Number.isNaN(row.blankParams[4]), 'yaw sentinel rides with the row');
  const offered = presetGroups().flatMap((g) => g.presets.map((p) => p.id));
  assert.ok(!offered.includes('reposition'), 'the dropdown no longer offers the goto');
});

// ── Mission pause / resume ─────────────────────────────────────────────────

test('Pause and Resume share commandId 193', () => {
  assert.equal(getPreset('pause').commandId, 193);
  assert.equal(getPreset('resume').commandId, 193);
});

test('Pause pins param 1 (Continue) to 0', () => {
  assertParamAt('pause', emptyUser(), 1, 0);
});

test('Resume pins param 1 (Continue) to 1', () => {
  assertParamAt('resume', emptyUser(), 1, 1);
});

// ── RTL (all params pinned) ────────────────────────────────────────────────

test('RTL pins all 7 params to 0', () => {
  const preset = getPreset('rtl');
  const arr = buildParamArray(preset, emptyUser());
  for (let i = 0; i < 7; i++) {
    assert.equal(arr[i], 0, `RTL param ${i + 1} must be 0`);
  }
});

test('RTL has no exposed params', () => {
  assert.deepEqual(getPreset('rtl').exposedParams, []);
});

// ── Stop Message Interval (Interval pinned to -1) ─────────────────────────

test('Stop Message Interval pins param 2 (Interval) to -1', () => {
  assertParamAt('stop_message_interval', emptyUser(), 2, -1);
});

test('Stop Message Interval: user cannot override pinned param 2', () => {
  assertParamAt('stop_message_interval', { 2: 500000 }, 2, -1);
});

// ── noAutoRetry flags ──────────────────────────────────────────────────────

test('MISSION_START has noAutoRetry=true', () => {
  assert.equal(getPreset('mission_start').noAutoRetry, true);
});

test('PREFLIGHT_REBOOT_SHUTDOWN (reboot_autopilot) has noAutoRetry=true', () => {
  assert.equal(getPreset('reboot_autopilot').noAutoRetry, true);
});

test('Arm has noAutoRetry=false (idempotent)', () => {
  assert.equal(getPreset('arm').noAutoRetry, false);
});

// ── Safety / requiresConfirmation ─────────────────────────────────────────

test('Flight Termination requires confirmation', () => {
  assert.equal(getPreset('flight_termination').requiresConfirmation, true);
});

test('Arm does not require confirmation', () => {
  assert.equal(getPreset('arm').requiresConfirmation, false);
});

// ── Completion keys ────────────────────────────────────────────────────────

test('Arm has completion key COMPLETION.ARM', () => {
  assert.equal(getPreset('arm').completionKey, COMPLETION.ARM);
});

test('Disarm has completion key COMPLETION.DISARM', () => {
  assert.equal(getPreset('disarm').completionKey, COMPLETION.DISARM);
});

test('Takeoff has completion key COMPLETION.TAKEOFF', () => {
  assert.equal(getPreset('takeoff').completionKey, COMPLETION.TAKEOFF);
});

test('Land has completion key COMPLETION.LAND', () => {
  assert.equal(getPreset('land').completionKey, COMPLETION.LAND);
});

test('Land pins yaw (param 4) to NaN — keep current heading, never yaw-to-north (issue #98b)', () => {
  const land = getPreset('land');
  assert.ok(!land.exposedParams.includes(4), 'param 4 is not exposed (no editor field ever existed)');
  const arr = buildParamArray(land, {}); // operator supplies nothing
  assert.ok(Number.isNaN(arr[3]), 'param 4 must be NaN (keep heading), not 0 (yaw to north)');
});

test('RTL has completion key COMPLETION.LAND', () => {
  assert.equal(getPreset('rtl').completionKey, COMPLETION.LAND);
});

test('Set Mode has completion key COMPLETION.SET_MODE', () => {
  assert.equal(getPreset('set_mode').completionKey, COMPLETION.SET_MODE);
});

test('Orbit has no completion key (null)', () => {
  assert.equal(getPreset('orbit').completionKey, null);
});

// ── All presets have required fields ──────────────────────────────────────

test('every preset has the required shape fields', () => {
  for (const p of PRESETS) {
    assert.ok(typeof p.id === 'string' && p.id.length > 0, `${p.id}: id`);
    assert.ok(typeof p.group === 'string', `${p.id}: group`);
    assert.ok(typeof p.name === 'string', `${p.id}: name`);
    assert.ok(typeof p.command === 'string', `${p.id}: command`);
    assert.ok(typeof p.commandId === 'number', `${p.id}: commandId`);
    assert.ok(typeof p.pinnedParams === 'object', `${p.id}: pinnedParams`);
    assert.ok(Array.isArray(p.exposedParams), `${p.id}: exposedParams`);
    assert.ok(typeof p.requiresConfirmation === 'boolean', `${p.id}: requiresConfirmation`);
    assert.ok(typeof p.noAutoRetry === 'boolean', `${p.id}: noAutoRetry`);
    assert.ok(p.completionKey === null || typeof p.completionKey === 'string',
      `${p.id}: completionKey`);
  }
});

// ── buildParamArray produces 7 elements ───────────────────────────────────

test('buildParamArray always returns a 7-element array', () => {
  for (const p of PRESETS) {
    const arr = buildParamArray(p, emptyUser());
    assert.equal(arr.length, 7, `preset '${p.id}' must produce 7 params`);
  }
});

test('a blank msg.payload override stays blank instead of coercing to 0 (Greptile #141)', () => {
  // mergeParams must not Number() a blank: msg.payload = { 5: '' } would
  // arrive as a legal coordinate 0. A flow computing coordinates and yielding
  // '' for a missing one is the exact upstream-math case this covers. The
  // distinction still matters after the coordinate guards went to the editor —
  // buildParamArray reads "absent" and "0" differently, and blank means absent.
  for (const blank of ['', '   ', '\t']) {
    const merged = mergeParams({ params: '{}' }, { 5: blank, 6: 8.5 });
    assert.equal(merged[5], undefined, `${JSON.stringify(blank)} must not become a coordinate`);
  }

  // A real override still lands, and an explicit 0 still counts as typed.
  assert.equal(mergeParams({ params: '{}' }, { 5: 47.4 })[5], 47.4);
  assert.equal(mergeParams({ params: '{}' }, { 5: 0 })[5], 0);
});

test('GCS parity: blank reposition speed and yaw encode the spec sentinels (#240)', () => {
  // QGC/MAVSDK transmit speed -1 (vehicle default) and yaw NaN (current
  // heading mode) for unspecified fields. The old zero-fill commanded 0 m/s
  // and yaw-to-north on every goto — the #98b land-yaw hazard, on the goto
  // primitive.
  const arr = buildParamArray(getPreset('reposition'), mergeParams({ params: '{"5":47.4,"6":8.5,"7":30}' }, null));
  assert.equal(arr[0], -1, 'blank speed encodes -1 (vehicle default)');
  assert.ok(Number.isNaN(arr[3]), 'blank yaw encodes NaN (keep current heading mode)');
  assert.deepEqual(arr.slice(4), [47.4, 8.5, 30]);

  // Explicit values — including 0 — are typed and win over the sentinels.
  const explicit = buildParamArray(
    getPreset('reposition'),
    mergeParams({ params: '{"1":5,"4":0,"5":47.4,"6":8.5,"7":30}' }, null)
  );
  assert.equal(explicit[0], 5);
  assert.equal(explicit[3], 0, 'an explicit 0 yaw is a command to heading 0');
});

test('GCS parity: blank change-speed fields encode -1 "no change", never a commanded zero (#240)', () => {
  const arr = buildParamArray(getPreset('change_speed'), mergeParams({ params: '{"1":1}' }, null));
  assert.deepEqual(arr.slice(0, 3), [1, -1, -1], 'blank speed and throttle are "no change"');
  const explicit = buildParamArray(getPreset('change_speed'), mergeParams({ params: '{"1":1,"2":0}' }, null));
  assert.equal(explicit[1], 0, 'an explicit 0 speed is a typed command');
});

test('GCS parity: blank takeoff yaw encodes NaN — the editor renders no yaw field (#98b class)', () => {
  const arr = buildParamArray(getPreset('takeoff'), mergeParams({ params: '{"7":25}' }, null));
  assert.ok(Number.isNaN(arr[3]), 'blank yaw encodes NaN (current heading mode)');
  assert.equal(arr[6], 25);
});

test('a raw blank string from the Fan-out path cannot clobber a sentinel with ""', () => {
  // Fan-out hands action.params to buildParamArray raw, never through
  // mergeParams — a '' there must read as absent, not as a value.
  const arr = buildParamArray(getPreset('reposition'), { 4: '', 5: 47.4, 6: 8.5, 7: 30 });
  assert.ok(Number.isNaN(arr[3]), 'a blank-string yaw still encodes the NaN sentinel');
});
