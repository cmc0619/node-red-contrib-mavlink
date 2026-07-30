'use strict';

/**
 * COMMAND_LONG ↔ COMMAND_INT carrier conversion tests (DESIGN.md §9 "resend in
 * the other form", "Coordinate frames").
 *
 * Pins the conversion rules the node relies on for carrier builds and the
 * auto-resend:
 *   - param1–4 pass through; param5→x, param6→y, param7→z (float, never scaled)
 *   - global-frame x/y are scaled to the wire degE7 int32 (degrees × 1e7),
 *     unconditionally — canonical params are always degrees (§9), so there is
 *     no "already scaled" guess and no pass-through heuristic
 *   - a non-global frame leaves x/y in metres (rounded to int32)
 *   - the round trip LONG→INT→LONG recovers the original params
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  longToIntFields,
  intFieldsToLong,
  buildCommandInt,
  buildCommandLong,
  isGlobalFrame,
  scaleLatLon,
  MAV_FRAME,
  DEFAULT_FRAME,
} = require('../../lib/command');

test('longToIntFields maps params, scales global lat/lon to degE7, keeps z float', () => {
  const int = longToIntFields([1, 2, 3, 4, 47.1234567, -122.5, 100.5]);
  assert.equal(int.param1, 1);
  assert.equal(int.param2, 2);
  assert.equal(int.param3, 3);
  assert.equal(int.param4, 4);
  // Default frame is GLOBAL → x/y scaled by 1e7.
  assert.equal(int.x, 471234567);
  assert.equal(int.y, -1225000000);
  // z is float altitude, untouched.
  assert.equal(int.z, 100.5);
  assert.equal(int.frame, DEFAULT_FRAME);
  assert.equal(int.current, 0);
  assert.equal(int.autocontinue, 0);
});

test('longToIntFields scales every degrees value — no pass-through heuristic', () => {
  // Whole-degree coordinates are ordinary operator input and must scale like
  // any other degrees value; the old |v| > 180 pass-through is gone (§9).
  const int = longToIntFields([0, 0, 0, 0, -35, 149, 50]);
  assert.equal(int.x, -350000000);
  assert.equal(int.y, 1490000000);
});

test('longToIntFields leaves x/y in metres for a non-global frame', () => {
  const int = longToIntFields([0, 0, 0, 0, 10.4, -3.6, 12], { frame: 1 }); // LOCAL_NED
  assert.equal(int.x, 10); // Math.round, not scaled
  assert.equal(int.y, -4);
  assert.equal(int.z, 12);
  assert.equal(int.frame, 1);
});

test('longToIntFields honours current/autocontinue overrides', () => {
  const int = longToIntFields([0, 0, 0, 0, 0, 0, 0], { current: 1, autocontinue: 1 });
  assert.equal(int.current, 1);
  assert.equal(int.autocontinue, 1);
});

test('intFieldsToLong is the inverse of longToIntFields for a global frame', () => {
  const params = [1, 2, 3, 4, 47.1234567, -122.5, 100];
  const int = longToIntFields(params, { frame: MAV_FRAME.GLOBAL_RELATIVE_ALT });
  const back = intFieldsToLong(int);
  assert.equal(back[0], 1);
  assert.equal(back[1], 2);
  assert.equal(back[2], 3);
  assert.equal(back[3], 4);
  // degE7 → degrees; tolerate the 1e-7 rounding.
  assert.ok(Math.abs(back[4] - 47.1234567) < 1e-6);
  assert.ok(Math.abs(back[5] - -122.5) < 1e-6);
  assert.equal(back[6], 100);
});

test('intFieldsToLong passes metres through for a non-global frame', () => {
  const back = intFieldsToLong({ frame: 1, param1: 5, x: 10, y: -4, z: 12 });
  assert.equal(back[0], 5);
  assert.equal(back[4], 10);
  assert.equal(back[5], -4);
  assert.equal(back[6], 12);
});

test('isGlobalFrame classifies the global MAV_FRAME family', () => {
  assert.equal(isGlobalFrame(MAV_FRAME.GLOBAL), true);
  assert.equal(isGlobalFrame(MAV_FRAME.GLOBAL_RELATIVE_ALT), true);
  assert.equal(isGlobalFrame(MAV_FRAME.GLOBAL_RELATIVE_ALT_INT), true);
  assert.equal(isGlobalFrame(1), false); // LOCAL_NED
});

test('scaleLatLon always scales degrees — whole numbers included', () => {
  assert.equal(scaleLatLon(47), 470000000);
  assert.equal(scaleLatLon(-122.5), -1225000000);
  assert.equal(scaleLatLon(47.1234567), 471234567);
  assert.equal(scaleLatLon(180), 1800000000); // boundary: still degrees
  // Near null island a tiny real coordinate must scale too — the value the
  // old |v| > 180 heuristic could silently misread.
  assert.equal(scaleLatLon(0.0000015), 15);
});

test('buildCommandInt emits a COMMAND_INT envelope with converted fields', () => {
  const msg = buildCommandInt(192, 1, 1, [1, 2, 3, 4, 47.1, -122.5, 100], {
    frame: MAV_FRAME.GLOBAL,
  });
  assert.equal(msg.name, 'COMMAND_INT');
  assert.equal(msg.fields.target_system, 1);
  assert.equal(msg.fields.target_component, 1);
  assert.equal(msg.fields.command, 192);
  assert.equal(msg.fields.frame, MAV_FRAME.GLOBAL);
  assert.equal(msg.fields.current, 0);
  assert.equal(msg.fields.autocontinue, 0);
  assert.equal(msg.fields.param1, 1);
  assert.equal(msg.fields.x, 471000000);
  assert.equal(msg.fields.y, -1225000000);
  assert.equal(msg.fields.z, 100);
  // COMMAND_INT carries no confirmation byte.
  assert.equal('confirmation' in msg.fields, false);
});

test('buildCommandLong emits a COMMAND_LONG envelope with the confirmation byte', () => {
  const msg = buildCommandLong(400, 2, 1, [1, 0, 0, 0, 0, 0, 0], 3);
  assert.equal(msg.name, 'COMMAND_LONG');
  assert.equal(msg.fields.command, 400);
  assert.equal(msg.fields.confirmation, 3);
  assert.equal(msg.fields.param1, 1);
  assert.equal(msg.fields.param7, 0);
});
