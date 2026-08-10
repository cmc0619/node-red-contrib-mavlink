'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRepositionMessage, resolveMoveCarrier } = require('../../lib/move');

const target = { sysid: 5, compid: 1 };
const goodPosition = { lat: 47.1234567, lon: 8.5, alt: 25 };

/** A valid reposition input; override per test. */
function input(overrides = {}) {
  return {
    mode: 'position',
    frame: 'GLOBAL_RELATIVE_ALT',
    target,
    position: goodPosition,
    ...overrides,
  };
}

test('reposition builds COMMAND_INT / DO_REPOSITION with degE7 coordinates and float alt', () => {
  const message = buildRepositionMessage(input());
  assert.equal(message.name, 'COMMAND_INT');
  assert.equal(message.fields.command, 192);
  assert.equal(message.fields.target_system, 5);
  assert.equal(message.fields.target_component, 1);
  // Direct commands, not mission items.
  assert.equal(message.fields.current, 0);
  assert.equal(message.fields.autocontinue, 0);
  // deg → degE7 int32 in x/y; alt stays a float in z (§ "Coordinate frames").
  assert.equal(message.fields.x, 471234567);
  assert.equal(message.fields.y, 85000000);
  assert.equal(message.fields.z, 25);
});

test('reposition frame mapping: GLOBAL → 0, GLOBAL_RELATIVE_ALT → 3, aliases resolve to the canon', () => {
  assert.equal(buildRepositionMessage(input({ frame: 'GLOBAL' })).fields.frame, 0);
  assert.equal(buildRepositionMessage(input({ frame: 'GLOBAL_RELATIVE_ALT' })).fields.frame, 3);
  // The deprecated *_INT spellings and numbers are MAVLink's protocol surface
  // and resolve to the spec-current numbers COMMAND_INT wants.
  assert.equal(buildRepositionMessage(input({ frame: 'GLOBAL_INT' })).fields.frame, 0);
  assert.equal(buildRepositionMessage(input({ frame: 'GLOBAL_RELATIVE_ALT_INT' })).fields.frame, 3);
  assert.equal(buildRepositionMessage(input({ frame: 5 })).fields.frame, 0);
  assert.equal(buildRepositionMessage(input({ frame: 6 })).fields.frame, 3);
});

test('reposition refusal matrix: setpoint modes refuse with named errors', () => {
  // Reposition implies position semantics — every setpoint-only mode refuses,
  // and an unknown mode (force included: removed, not aliased) still throws
  // through the shared vocabulary.
  for (const mode of ['velocity', 'position-velocity', 'acceleration', 'yaw-only']) {
    assert.throws(
      () => buildRepositionMessage(input({ mode })),
      /Move reposition is position-only/,
      `mode ${mode} must refuse`
    );
  }
  assert.throws(() => buildRepositionMessage(input({ mode: 'force' })), /unknown Move mode/);
});

test('reposition refusal matrix: local and terrain frames refuse naming the frame', () => {
  for (const frame of ['LOCAL_NED', 'LOCAL_OFFSET_NED', 'BODY_NED', 'BODY_OFFSET_NED', 'GLOBAL_TERRAIN_ALT']) {
    assert.throws(
      () => buildRepositionMessage(input({ frame })),
      new RegExp(`GLOBAL and GLOBAL_RELATIVE_ALT — ${frame}`),
      `frame ${frame} must refuse`
    );
  }
  // A blank frame resolves the Move default LOCAL_NED and refuses the same way
  // — fail closed, never a silent global guess.
  assert.throws(() => buildRepositionMessage(input({ frame: undefined })), /LOCAL_NED/);
  assert.throws(() => buildRepositionMessage(input({ frame: 'WARP' })), /unknown Move frame/);
});

test('reposition refusal matrix: yaw rate has no DO_REPOSITION field', () => {
  assert.throws(
    () => buildRepositionMessage(input({ yawRate: 10 })),
    /no yaw rate/
  );
  // Blank yaw rate (config default '') passes.
  assert.equal(buildRepositionMessage(input({ yawRate: '' })).name, 'COMMAND_INT');
});

test('reposition reuses the shared blank/range coordinate guards (§10)', () => {
  for (const position of [
    { lat: '', lon: 8, alt: 10 },
    { lat: 47, lon: 8 }, // blank alt: no documented sentinel, ground level refuses
  ]) {
    assert.throws(
      () => buildRepositionMessage(input({ position })),
      /blank coordinates must not become 0,0/
    );
  }
  assert.throws(
    () => buildRepositionMessage(input({ position: { lat: 90.1, lon: 8, alt: 10 } })),
    /lat must be within \[-90, 90\]/
  );
  assert.throws(
    () => buildRepositionMessage(input({ position: { lat: 47, lon: -180.1, alt: 10 } })),
    /lon must be within \[-180, 180\]/
  );
  // A non-numeric coordinate refuses with the finite-number error, not the
  // carrier module's COMMAND_LONG advice.
  assert.throws(
    () => buildRepositionMessage(input({ position: { lat: 'abc', lon: 8, alt: 10 } })),
    /expected a finite number/
  );
});

test('reposition blank sentinels: speed −1, radius 0, yaw NaN; explicit values win (presets convention)', () => {
  // Blank encodes the spec's no-change sentinel — what QGC/MAVSDK transmit
  // for unspecified fields (lib/command/presets.js blankParams, #240).
  const blanks = buildRepositionMessage(input());
  assert.equal(blanks.fields.param1, -1, 'blank speed → vehicle default');
  assert.equal(blanks.fields.param2, 0, 'flags default clear');
  assert.equal(blanks.fields.param3, 0, 'blank radius → ignored');
  assert.ok(Number.isNaN(blanks.fields.param4), 'blank yaw → NaN keeps the current heading mode');

  const explicit = buildRepositionMessage(input({ speed: 0, radius: 80, yaw: 0 }));
  assert.equal(explicit.fields.param1, 0, 'explicit 0 speed is a value, not the sentinel');
  assert.equal(explicit.fields.param3, 80);
  assert.equal(explicit.fields.param4, 0, 'explicit 0 yaw commands north, never NaN');

  // The dialect declares DO_REPOSITION param4 in radians (unlike
  // NAV_WAYPOINT's degrees); the operator's degrees convert exactly once here.
  const yawed = buildRepositionMessage(input({ yaw: 90 }));
  assert.ok(Math.abs(yawed.fields.param4 - Math.PI / 2) < 1e-12, '90° encodes π/2 rad');

  // Non-numeric optional params refuse rather than encode garbage.
  assert.throws(() => buildRepositionMessage(input({ speed: 'fast' })), /expected a finite number/);
  assert.throws(() => buildRepositionMessage(input({ radius: 'big' })), /expected a finite number/);
  assert.throws(() => buildRepositionMessage(input({ yaw: 'north' })), /expected a finite number/);
});

test('reposition CHANGE_MODE is a strict boolean opt-in', () => {
  // MAV_DO_REPOSITION_FLAGS_CHANGE_MODE flies the vehicle into guided — a
  // mode change, so only an explicit boolean true sets it.
  assert.equal(buildRepositionMessage(input()).fields.param2, 0);
  assert.equal(buildRepositionMessage(input({ changeMode: false })).fields.param2, 0);
  assert.equal(buildRepositionMessage(input({ changeMode: true })).fields.param2, 1);
  // A truthy token must refuse, not silently drop the requested mode change.
  for (const bad of ['yes', 1, 'true']) {
    assert.throws(
      () => buildRepositionMessage(input({ changeMode: bad })),
      /changeMode must be boolean/,
      `changeMode ${JSON.stringify(bad)} must refuse`
    );
  }
});

test('resolveMoveCarrier: blank inherits setpoint, unknown names the valid set', () => {
  for (const blank of [undefined, null, '', ' ']) {
    assert.equal(resolveMoveCarrier(blank), 'setpoint', `${JSON.stringify(blank)} resolves setpoint`);
  }
  assert.equal(resolveMoveCarrier('setpoint'), 'setpoint');
  assert.equal(resolveMoveCarrier('reposition'), 'reposition');
  assert.throws(() => resolveMoveCarrier('teleport'), /unknown Move carrier "teleport" — expected one of setpoint, reposition/);
});
