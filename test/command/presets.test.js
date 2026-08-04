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

const { getPreset, buildParamArray, blankLocationRefusal, PRESETS, COMPLETION } = require('../../lib/command');

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

// ── Yaw / Rotate ───────────────────────────────────────────────────────────

test('Yaw and Rotate share commandId 115', () => {
  assert.equal(getPreset('yaw').commandId, 115);
  assert.equal(getPreset('rotate').commandId, 115);
});

test('Yaw pins param 4 (Relative) to 0 (absolute)', () => {
  assertParamAt('yaw', emptyUser(), 4, 0);
});

test('Rotate pins param 4 (Relative) to 1 (relative)', () => {
  assertParamAt('rotate', emptyUser(), 4, 1);
});

test('Yaw: user cannot override pinned param 4', () => {
  assertParamAt('yaw', { 4: 99 }, 4, 0);
});

test('Rotate: user cannot override pinned param 4', () => {
  assertParamAt('rotate', { 4: 99 }, 4, 1);
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

test('location presets refuse blank lat/lon rather than sending 0,0 (#88)', () => {
  // buildParamArray fills absent params with 0, so a blank latitude became a
  // legal coordinate in the Gulf of Guinea and the vehicle flew to it. The
  // guard reads the operator's input, before that zero-fill.
  const reposition = getPreset('reposition');
  assert.match(
    blankLocationRefusal(reposition, { 1: 5, 5: '', 6: 8.5 }),
    /requires latitude and longitude/
  );
  assert.equal(blankLocationRefusal(reposition, { 5: 47.4, 6: 8.5 }), null);

  // An explicit 0 is a real coordinate, deliberately typed, and passes.
  assert.equal(blankLocationRefusal(reposition, { 5: 0, 6: 0 }), null);

  // Orbit carries the same rule.
  assert.match(
    blankLocationRefusal(getPreset('orbit'), { 5: 47.4 }),
    /requires latitude and longitude/
  );
});

test('Set Home only needs coordinates when it is not using the current position (#88)', () => {
  const setHome = getPreset('set_home');

  // param1 = 1 is "use current position": the vehicle ignores lat/lon entirely,
  // so demanding them would refuse a perfectly ordinary Set Home.
  assert.equal(blankLocationRefusal(setHome, { 1: 1 }), null);

  // param1 = 0 means the coordinates are the home position, so they must exist.
  assert.match(blankLocationRefusal(setHome, { 1: 0 }), /requires latitude and longitude/);
  // A blank flag is 0 — "no" — and still demands coordinates.
  assert.match(blankLocationRefusal(setHome, {}), /requires latitude and longitude/);
  assert.equal(blankLocationRefusal(setHome, { 1: 0, 5: 47.4, 6: 8.5 }), null);
});

test('presets without a location are untouched by the guard (#88)', () => {
  // Takeoff and Land are hasLocation *and* isDestination in the dialect, yet
  // blank coordinates there are the normal "here" case — which is why the rule
  // lives on the preset rather than being read from those XML flags.
  for (const id of ['takeoff', 'land', 'arm', 'disarm']) {
    const preset = getPreset(id);
    if (!preset) continue;
    assert.equal(blankLocationRefusal(preset, {}), null, `${id} must not require coordinates`);
  }
});
