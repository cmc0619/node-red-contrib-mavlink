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

test('longToIntFields scales x/y to metres × 1e4 for a non-global frame', () => {
  // Was pinned the other way (raw rounded metres) until measured: PX4 decodes
  // a LOCAL_NED x of 1234567 as 123.4567 m, so metres × 1e4 is what the wire
  // carries (common.xml; DESIGN.md §14). ArduPilot denies the frame outright
  // for location commands, so nothing regresses there.
  const int = longToIntFields([0, 0, 0, 0, 10.4, -3.6, 12], { frame: 1 }); // LOCAL_NED
  assert.equal(int.x, 104000);
  assert.equal(int.y, -36000);
  assert.equal(int.z, 12); // z is a float altitude — never scaled
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

test('intFieldsToLong un-scales local-frame x/y from metres × 1e4', () => {
  // The wire carries metres × 1e4 for a local frame (common.xml; measured
  // against PX4 SITL, DESIGN.md §14) — so 100000 on the wire is 10 metres.
  const back = intFieldsToLong({ frame: 1, param1: 5, x: 100000, y: -40000, z: 12 });
  assert.equal(back[0], 5);
  assert.equal(back[4], 10);
  assert.equal(back[5], -4);
  assert.equal(back[6], 12);
});

test('the exact value measured against PX4 SITL round-trips (§14)', () => {
  // PX4 decoded a LOCAL_NED x of 1234567 as 123.4567 m, so entering 123.4567 m
  // must put exactly 1234567 on the wire. Before this, 50 m was sent as `50`
  // and arrived as 5 mm.
  const int = longToIntFields([0, 0, 0, 0, 123.4567, -50, 12], { frame: 1 });
  assert.equal(int.x, 1234567);
  assert.equal(int.y, -500000);
});

test('local-frame LONG→INT→LONG is lossless', () => {
  const params = [1, 2, 3, 4, 37.5, -12.25, 8];
  const back = intFieldsToLong(longToIntFields(params, { frame: 1 }), {});
  assert.ok(Math.abs(back[4] - 37.5) < 1e-6);
  assert.ok(Math.abs(back[5] - -12.25) < 1e-6);
  assert.equal(back[6], 8);
});

test('MAV_FRAME_MISSION is not a local frame — x/y stay unscaled', () => {
  // MAV_FRAME_MISSION (2) means "these params are not a position", so it is
  // neither global nor local. Deriving the local rule as "not global" would
  // scale it ×1e4; PX4 in fact decodes frame 2 with the degE7 divisor, and QGC
  // passes it through raw. Unscaled preserves the pre-local-rule behaviour
  // rather than inventing a third interpretation (§14).
  const int = longToIntFields([0, 0, 0, 0, 10.4, -3.6, 12], { frame: 2 });
  assert.equal(int.x, 10);
  assert.equal(int.y, -4);
  assert.deepEqual(intFieldsToLong(int).slice(4, 6), [10, -4]);
});

test('all eight local frames scale by 1e4 — every member SITL-measured (§14)', () => {
  // Measured on PX4, one frame at a time: x=1234567 decoded as 123.4567 m
  // under LOCAL_NED (1), LOCAL_ENU (4), LOCAL_OFFSET_NED (7), BODY_NED (8),
  // BODY_OFFSET_NED (9), BODY_FRD (12), LOCAL_FRD (20), LOCAL_FLU (21). The
  // set is member-for-member identical to PX4's mavlink_receiver.cpp chain.
  for (const frame of [1, 4, 7, 8, 9, 12, 20, 21]) {
    const int = longToIntFields([0, 0, 0, 0, 123.4567, 0, 0], { frame });
    assert.equal(int.x, 1234567, `frame ${frame} should scale ×1e4`);
  }
});

test('RESERVED_13 stays unclassified: metres pass through unscaled', () => {
  // Frame 13 is a tombstone (upstream removed BODY_FLU and reserved the
  // slot). Measured: PX4's fallthrough decodes it ÷1e7 — NOT as metres — so
  // a name-based "BODY_* means local" rule would emit a wrong divisor today.
  // We deliberately do not match PX4's fallthrough either: unclassified
  // frames pass through unscaled, the do-nothing default for a slot whose
  // semantics upstream deleted.
  const int = longToIntFields([0, 0, 0, 0, 10, -4, 0], { frame: 13 });
  assert.equal(int.x, 10);
  assert.equal(int.y, -4);
});

test('non-coordinate param5/6 stay unscaled in a local frame', () => {
  // Gimbal-manager flags and similar non-location params carry what the
  // operator entered, in either frame — the ×1e4 applies to coordinates only.
  const kinds = { 5: 'raw', 6: 'raw' };
  const int = longToIntFields([0, 0, 0, 0, 7, 9, 0], { frame: 1, coordKinds: kinds });
  assert.equal(int.x, 7);
  assert.equal(int.y, 9);
  const back = intFieldsToLong(int, { coordKinds: kinds });
  assert.equal(back[4], 7);
  assert.equal(back[5], 9);
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

// ── Ask-the-XML coordinate kinds (§9) ────────────────────────────────────────

const { intCoordKinds } = require('../../lib/command');
const { loadBundled } = require('../../lib/metadata');

test('intCoordKinds classifies param5/6 from the dialect XML', () => {
  const bundle = loadBundled('common');
  // Real lat/lon: hasLocation, no degE7 units → scale.
  assert.deepEqual(intCoordKinds(bundle, 192), { 5: 'latlon', 6: 'latlon' }); // DO_REPOSITION
  // Not a location: gimbal manager flags ride param5 → never scale.
  assert.deepEqual(intCoordKinds(bundle, 1000), { 5: 'raw', 6: 'raw' }); // DO_GIMBAL_MANAGER_PITCHYAW
  // Natively degE7 in the XML → the entered value IS the wire value.
  assert.deepEqual(intCoordKinds(bundle, 30001), { 5: 'dege7', 6: 'dege7' }); // PAYLOAD_PREPARE_DEPLOY
  // Unknown command / missing bundle → null (historical scaling).
  assert.equal(intCoordKinds(bundle, 999999), null);
  assert.equal(intCoordKinds(null, 192), null);
});

test('coordKinds raw/dege7 params are never ×1e7-scaled on a global frame', () => {
  // Gimbal manager flags = 8 must reach the wire as 8, not 80000000.
  const raw = longToIntFields([0, 0, 0, 0, 8, 0, 0], { coordKinds: { 5: 'raw', 6: 'raw' } });
  assert.equal(raw.x, 8);
  // A natively degE7 value passes through unscaled.
  const native = longToIntFields([0, 0, 0, 0, 471234567, -1225000000, 0], {
    coordKinds: { 5: 'dege7', 6: 'dege7' },
  });
  assert.equal(native.x, 471234567);
  assert.equal(native.y, -1225000000);
});

test('NaN in param5/6 refuses the INT build — no silent null island (§9)', () => {
  // LONG's NaN means "leave unchanged"; int32 cannot express it, and coercing
  // to 0 would aim a global-frame command at 0,0. The spec routes such
  // commands to COMMAND_LONG, so the INT build fails loud.
  assert.throws(() => longToIntFields([0, 0, 0, 0, NaN, 149, 50]), /must be finite/);
  assert.throws(() => longToIntFields([0, 0, 0, 0, -35, NaN, 50]), /must be finite/);
  // The reject is kind-independent: NaN flags are equally meaningless.
  assert.throws(
    () => longToIntFields([0, 0, 0, 0, NaN, 0, 0], { coordKinds: { 5: 'raw', 6: 'raw' } }),
    /must be finite/
  );
  // NaN stays legal where the wire is float: param1–4 and z.
  const ok = longToIntFields([NaN, 0, 0, 0, -35, 149, NaN]);
  assert.ok(Number.isNaN(ok.param1));
  assert.ok(Number.isNaN(ok.z));
});
