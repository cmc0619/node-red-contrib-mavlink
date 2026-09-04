'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BAND } = require('../../lib/connection/bands');
const { buildMoveMessage, createMoveStream } = require('../../lib/move');

test('position Move flips operator up-positive altitude to NED down-positive exactly once', () => {
  const message = buildMoveMessage({ frame: 1,
    mode: 'position',
    target: { sysid: 2, compid: 1 },
    position: { north: 4, east: -3, up: 12 },
    yaw: 90,
    timeBootMs: 77,
  });

  assert.equal(message.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.equal(message.fields.target_system, 2);
  assert.equal(message.fields.target_component, 1);
  assert.equal(message.fields.x, 4);
  assert.equal(message.fields.y, -3);
  assert.equal(message.fields.z, -12);
  // Operator yaw is degrees; the wire wants radians — 90 deg ≈ 1.5708 rad.
  assert.ok(Math.abs(message.fields.yaw - Math.PI / 2) < 1e-9);
  assert.equal(message.fields.type_mask, 2552);
});

test('global position Move encodes degrees to degE7 and keeps altitude up-positive', () => {
  const message = buildMoveMessage({
    mode: 'position',
    frame: 3,
    target: { sysid: 3, compid: 1 },
    position: { lat: 47.397742, lon: 8.545594, alt: 25 },
    timeBootMs: 42,
  });

  assert.equal(message.name, 'SET_POSITION_TARGET_GLOBAL_INT');
  assert.equal(message.fields.lat_int, 473977420);
  assert.equal(message.fields.lon_int, 85455940);
  assert.equal(message.fields.alt, 25);
});

test('global position Move encodes whole-number degrees as degE7, not as raw wire values', () => {
  const message = buildMoveMessage({
    mode: 'position',
    frame: 3,
    target: { sysid: 3, compid: 1 },
    // Integer degrees must still scale by 1e7 — treating 47 as an already
    // encoded degE7 value would place the point at 47e-7 degrees.
    position: { lat: 47, lon: -122, alt: 10 },
    timeBootMs: 0,
  });

  assert.equal(message.fields.lat_int, 470000000);
  assert.equal(message.fields.lon_int, -1220000000);
});



test('a frame the Action surface never derives rides as non-finite, never as a substitute', () => {
  // String frame names died with the operator frame surface: the Action layer
  // derives numbers. One that does not coerce rides non-finite rather than
  // being quietly replaced with a legal frame number.
  const message = buildMoveMessage({
    frame: 'LOCAL_NED',
    mode: 'position',
    target: { sysid: 2, compid: 1 },
    position: { north: 1, east: 2, up: 3 },
  });
  assert.equal(message.name, 'SET_POSITION_TARGET_LOCAL_NED', 'a non-global frame is the local carrier');
  assert.ok(!Number.isFinite(message.fields.coordinate_frame));
});




// ── Action derivation (§6 redesign): the operator states an intent, the
// wire follows — these functions ARE the new surface's contract ─────────────




test('frameForAltRef: the three altitude references pin their global frames', () => {
  const { frameForAltRef } = require('../../lib/move');
  assert.equal(frameForAltRef('home'), 3, 'home is GLOBAL_RELATIVE_ALT');
  assert.equal(frameForAltRef('msl'), 0, 'msl is GLOBAL');
  // Terrain is the pymavlink posture (owner ruling, 2026-08-23): pack
  // GLOBAL_TERRAIN_ALT and nothing else — the vehicle resolves the height
  // from its own terrain data, and one without any refuses loudly.
  assert.equal(frameForAltRef('terrain'), 10, 'terrain is GLOBAL_TERRAIN_ALT');
  assert.ok(!Number.isFinite(frameForAltRef('agl')), 'a stray token selects no frame');
});

test('a terrain-frame goto setpoint rides the global carrier as the *_INT twin (10 → 11)', () => {
  // Same rule as 0 → 5 and 3 → 6: the wire number is code — PX4 main
  // exact-matches 5/6/11 and every current stack accepts the twins.
  const message = buildMoveMessage({
    mode: 'position',
    frame: 10,
    target: { sysid: 3, compid: 1 },
    position: { lat: 47.397742, lon: 8.545594, alt: 15 },
    timeBootMs: 42,
  });
  assert.equal(message.name, 'SET_POSITION_TARGET_GLOBAL_INT');
  assert.equal(message.fields.coordinate_frame, 11);
});

test('frameForReference: offset is LOCAL_OFFSET_NED on every stack and asks no firmware question', () => {
  const { frameForReference } = require('../../lib/move');
  // Unlike body, frame 7 is one number everywhere — the firmware question is
  // whether the vehicle *acts* on it, which is the editor's business (PX4 is
  // measured inert, §14 2026-08-05, and the dropdown stops offering it there).
  // The driver has a frame number to give, so it gives it.
  for (const firmware of [undefined, 'ardupilot', 'px4', 'custom']) {
    assert.equal(
      frameForReference('offset', firmware),
      7,
      `offset is 7 regardless of firmware ${JSON.stringify(firmware)}`
    );
  }
});


test('deriveSteerMode: filling fields IS the mode — the CSV rule, total at the edges', () => {
  const { deriveSteerMode } = require('../../lib/move');
  const blank = { north: '', east: '', up: '' };
  const filled = { north: 1, east: 0, up: 0 };
  const g = (over = {}) => ({ position: blank, velocity: blank, accel: blank, yaw: '', yawRate: '', ...over });

  assert.equal(deriveSteerMode(g({ position: filled })), 'position');
  assert.equal(deriveSteerMode(g({ velocity: filled })), 'velocity');
  assert.equal(deriveSteerMode(g({ position: filled, velocity: filled })), 'position-velocity');
  assert.equal(deriveSteerMode(g({ accel: filled })), 'acceleration');
  // Explicit 0 is a value, so a zero vector still names its group.
  assert.equal(deriveSteerMode(g({ velocity: { north: 0, east: '', up: '' } })), 'velocity');
  // Yaw/yaw-rate alone are the measured-hazard yaw-only mode, still offered.
  assert.equal(deriveSteerMode(g({ yaw: 90 })), 'yaw-only');
  assert.equal(deriveSteerMode(g({ yawRate: 10 })), 'yaw-only');
  // Yaw rides any mode by presence — it does not change the derived group.
  assert.equal(deriveSteerMode(g({ velocity: filled, yaw: 90 })), 'velocity');

  // Acceleration composes where the firmware names the mix: VelAccel and
  // PosVelAccel are real ArduPilot guided submodes (§14 source read), so
  // those two derive. The wire has one ignore bit per group either way.
  assert.equal(deriveSteerMode(g({ accel: filled, velocity: filled })), 'velocity-acceleration');
  assert.equal(
    deriveSteerMode(g({ position: filled, velocity: filled, accel: filled })),
    'position-velocity-acceleration'
  );
  // Position + acceleration WITHOUT velocity is the one mix with no named
  // submode and no §14 measurement, so MODES carries no row for the name this
  // composes — the build craters on the missing row and the editor is what
  // reds the combination (mavlink-move.html `action`).
  assert.equal(deriveSteerMode(g({ accel: filled, position: filled })), 'position-acceleration');
  const { MODES } = require('../../lib/move/frames');
  assert.equal(MODES['position-acceleration'], undefined, 'the unmeasured mix has no wire encoding');
  // Nothing filled derives yaw-only, which with no yaw is the all-ignore
  // packet (§14 / #115). It used to refuse; the editor requires at least one
  // Steer field now, so the configured path cannot get here.
  assert.equal(deriveSteerMode(g()), 'yaw-only');

  // Only the LOCAL triplet names the position group (Codex, #277): a node
  // switched from Go to keeps its hidden lat/lon/alt serialized, and
  // positionFrom carries both families. Stale globals must not turn a
  // velocity-only steer into position-velocity — nor rescue an empty one.
  const staleGlobals = { north: '', east: '', up: '', lat: 47.1, lon: 8.5, alt: 25 };
  assert.equal(deriveSteerMode(g({ position: staleGlobals, velocity: filled })), 'velocity');
  assert.equal(deriveSteerMode(g({ position: staleGlobals, accel: filled })), 'acceleration');
  // A stale global cannot rescue an empty steer either — it derives yaw-only
  // (the all-ignore packet), not position.
  assert.equal(deriveSteerMode(g({ position: staleGlobals })), 'yaw-only');
});



test('a whitespace-only string is blank — Number(\' \') is a finite 0 (§10)', () => {
  // Still load-bearing where presence drives a mask bit: ' ' is not '', so
  // without trimming it reaches Number() and comes back a finite 0, which
  // would clear an ignore bit and command a value nobody typed.
  //
  // Yaw follows the presence rule: whitespace is absent, so the ignore bit
  // stays set rather than commanding a yaw of 0 (north) nobody asked for.
  const yawBlank = buildMoveMessage({ frame: 1,
    mode: 'position',
    target: { sysid: 2, compid: 1 },
    position: { north: 1, east: 2, up: 3 },
    yaw: ' ',
  });
  assert.equal(yawBlank.fields.type_mask & 1024, 1024, 'whitespace yaw stays ignored');
  assert.equal(yawBlank.fields.yaw, 0);

  // A real value is still a value, whitespace-padded or not.
  const padded = buildMoveMessage({ frame: 1,
    mode: 'position',
    target: { sysid: 2, compid: 1 },
    position: { north: ' 4 ', east: 2, up: 3 },
  });
  assert.equal(padded.fields.x, 4);
});

test('a commanded group coerces every axis — the editor is what requires them whole', () => {
  // The mask has no per-axis bit, so a group the mode names is commanded in
  // full and a blank axis coerces to 0 the way the wire reads it. On
  // LOCAL_OFFSET_NED that 0 is a zero *offset*, which is no movement on that
  // axis (§14 2026-08-05, the frame-7 probe); on LOCAL_NED it is the EKF
  // origin. Telling those apart is the editor's job — `steerAxisValidator`
  // reds a half-filled triplet on every frame but Offset.
  const offset = buildMoveMessage({ frame: 7,
    mode: 'position',
    target: { sysid: 2, compid: 1 },
    position: { north: '', east: '', up: 10 },
  });
  assert.equal(offset.fields.coordinate_frame, 7);
  assert.equal(offset.fields.x, 0, 'a blank north is a zero offset');
  assert.equal(offset.fields.y, 0, 'a blank east is a zero offset');
  assert.equal(offset.fields.z, -10, 'and the filled axis still flips to NED');

  // An axis nobody supplied at all rides as NaN, which is legal MAVLink on a
  // float field — the driver does not invent a number for it.
  const absent = buildMoveMessage({ frame: 1,
    mode: 'velocity',
    target: { sysid: 2, compid: 1 },
    velocity: { north: 1 },
  });
  assert.equal(absent.fields.vx, 1);
  assert.ok(Number.isNaN(absent.fields.vy));
});

test('the brake copies target ids from the streamed setpoint and does not invent system 1', () => {
  // Measured at the connection: stop() with a brake sends one more message,
  // and its target ids are the setpoint's own — absent stays absent.
  const brakeFor = (fields) => {
    const sent = [];
    const stream = createMoveStream({
      message: { name: 'SET_POSITION_TARGET_LOCAL_NED', fields },
      connection: { send: (m) => sent.push(m) },
      rateHz: 4,
      ttlMs: 0,
      setInterval: () => ({ unref() { /* not a real timer */ } }),
      clearInterval: () => { /* no timer to clear */ },
    });
    stream.start();
    const before = sent.length;
    stream.stop({ brake: true });
    assert.equal(sent.length, before + 1, 'a braking stop sends exactly one brake');
    return sent[sent.length - 1];
  };
  const stop = brakeFor({ time_boot_ms: 9, target_system: 4, target_component: 7, vx: 1 });
  assert.equal(stop.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.equal(stop.fields.target_system, 4);
  assert.equal(stop.fields.target_component, 7);
  assert.equal(stop.fields.vx, 0, 'the brake zeroes velocity');
  const missing = brakeFor({ time_boot_ms: 0, vx: 1 });
  assert.equal(missing.fields.target_system, undefined);
  assert.equal(missing.fields.target_component, undefined);
});

test('stream ticks re-stamp time_boot_ms without mutating the built message', () => {
  const { createMoveStream } = require('../../lib/move');
  const sent = [];
  const message = {
    name: 'SET_POSITION_TARGET_LOCAL_NED',
    fields: { time_boot_ms: 0, target_system: 1, target_component: 1, type_mask: 3527 },
  };
  let tick = null;
  const stream = createMoveStream({
    message,
    connection: { send: (m) => sent.push(m) },
    rateHz: 4,
    ttlMs: 0,
    // Injected no-ops: the test drives ticks by hand — there is no real timer
    // to unref or clear, only the captured callback.
    setInterval: (fn) => { tick = fn; return { unref() { /* not a real timer */ } }; },
    clearInterval: () => { /* no timer to clear */ },
  });
  stream.start();
  tick();
  stream.stop({ brake: false });
  assert.equal(sent.length, 2, 'start + one tick');
  for (const m of sent) {
    assert.ok(m.fields.time_boot_ms >= 0 && Number.isInteger(m.fields.time_boot_ms));
    assert.notEqual(m.fields, message.fields, 'each send carries its own fields copy');
  }
  assert.equal(message.fields.time_boot_ms, 0, 'the built message is never mutated');
});


test('braking is opt-out, and attitude/manual streams end in silence (§9 ruling 1)', () => {
  // The hazard this pins: a regression to always-brake would synthesize a
  // zero-velocity POSITION brake at a vehicle being attitude- or stick-flown —
  // exactly what the ruling forbids, and previously nothing failed on it. The
  // node wires `braking: action !== 'attitude' && action !== 'manual'`
  // (nodes/mavlink-move.js); this drives the library contract that wiring
  // relies on.
  const { createMoveStream } = require('../../lib/move');
  const drive = (message, braking) => {
    const sent = [];
    let tick = null;
    const stream = createMoveStream({
      message,
      braking,
      connection: { send: (m) => sent.push(m) },
      rateHz: 4,
      ttlMs: 0,
      setInterval: (fn) => { tick = fn; return { unref() { /* injected */ } }; },
      clearInterval: () => { /* injected */ },
    });
    stream.start();
    tick();
    const stop = stream.stop();
    return { sent, stop };
  };

  const manual = drive(
    { name: 'MANUAL_CONTROL', fields: { target: 1, x: 0, y: 0, z: 500, r: 0, buttons: 0 } },
    false
  );
  assert.equal(manual.stop, null, 'a manual stream returns no stop message');
  assert.equal(manual.sent.length, 2, 'start + tick and nothing else — silence IS the stop');
  const attitude = drive(
    { name: 'SET_ATTITUDE_TARGET', fields: { time_boot_ms: 0, target_system: 1, target_component: 1, type_mask: 199, q: [1, 0, 0, 0], body_roll_rate: 0, body_pitch_rate: 0, body_yaw_rate: 0, thrust: 0 } },
    false
  );
  assert.equal(attitude.stop, null, 'an attitude stream returns no stop message');
  assert.equal(attitude.sent.length, 2, 'zero thrust is a descent, so no brake is synthesized');

  // The control: position keeps its measured zero-velocity brake.
  const position = drive(
    { name: 'SET_POSITION_TARGET_LOCAL_NED', fields: { time_boot_ms: 0, target_system: 1, target_component: 1, type_mask: 8, vx: 2, vy: 0, vz: 0 } },
    true
  );
  assert.ok(position.stop, 'a position stream still brakes');
  assert.equal(position.sent.length, 3, 'start + tick + the brake');
  assert.equal(position.sent[2].fields.type_mask, 3527, 'and the brake is the zero-velocity packet');
});


test('quaternionFromEuler composes mixed angles in aerospace ZYX order, pinned to 9 decimals', () => {
  // The single-axis tests and the unit-norm check both pass under a wrong
  // rotation *sequence* — only a mixed-angle known vector catches one. The
  // literals are the textbook aerospace (yaw-pitch-roll, ZYX) quaternion for
  // roll 30°, pitch 40°, yaw 50°, computed independently of the
  // implementation.
  const { quaternionFromEuler } = require('../../lib/move/attitude');
  const d = Math.PI / 180;
  const q = quaternionFromEuler(30 * d, 40 * d, 50 * d);
  const expected = [0.860042173698, 0.080804688691, 0.402198493534, 0.303371774471];
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(q[i] - expected[i]) < 1e-9, `q[${i}] = ${q[i]} vs ${expected[i]}`);
  }
});


test('Move streams on the Streaming band until TTL and emits a zero-velocity stop', () => {
  const sends = [];
  let timer;
  let now = 0;
  const handle = { unref() { /* not a real timer */ } };
  const stream = createMoveStream({
    connection: {
      send(message, options) {
        sends.push({ message, options });
      },
    },
    message: buildMoveMessage({ frame: 1,
      mode: 'velocity',
      target: { sysid: 4, compid: 1 },
      velocity: { north: 1, east: 2, up: 3 },
      timeBootMs: 0,
    }),
    target: { sysid: 4, compid: 1 },
    identityId: 'gcs',
    rateHz: 10,
    ttlMs: 250,
    now: () => now,
    setInterval(fn) {
      timer = fn;
      return handle;
    },
    clearInterval(cleared) {
      assert.equal(cleared, handle);
    },
  });

  stream.start();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].options.band, BAND.STREAMING);
  assert.equal(sends[0].message.fields.vz, -3);

  now = 100;
  timer();
  now = 260;
  timer();

  assert.equal(stream.active, false);
  assert.equal(sends.length, 3);
  assert.equal(sends[2].message.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.equal(sends[2].message.fields.vx, 0);
  assert.equal(sends[2].message.fields.vy, 0);
  assert.equal(sends[2].message.fields.vz, 0);
  assert.equal(sends[2].options.band, BAND.STREAMING);
});




