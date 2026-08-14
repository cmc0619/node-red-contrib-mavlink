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



test('force is not a Move mode — no firmware actuated the force bit (§14)', () => {
  // Removed, not aliased (pre-1.0, no migrations): the mode throws naming the
  // valid set rather than quietly building an acceleration setpoint.
  assert.throws(
    () => buildMoveMessage({ frame: 1,
      mode: 'force',
      target: { sysid: 2, compid: 1 },
      accel: { north: 2, east: 0, up: 3 },
    }),
    /unknown Move mode "force"/
  );
});




test('string frame names throw — the retired operator vocabulary is deleted, not aliased', () => {
  // The Action surface derives numbers; the parsing layer for member names and
  // the deprecated *_INT aliases (names and numbers 5/6/11) is deleted.
  const { resolveModeAndFrame } = require('../../lib/move/frames');
  for (const frame of ['LOCAL_NED', 'GLOBAL_RELATIVE_ALT', 'GLOBAL_RELATIVE_ALT_INT', 'GLOBAL_INT', 'BODY_FRD']) {
    assert.throws(
      () => resolveModeAndFrame({ mode: 'position', frame }),
      /not a SET_POSITION_TARGET frame/,
      `string frame ${JSON.stringify(frame)} must throw`
    );
  }
  // The deprecated wire numbers and the retired terrain frames are not in the
  // vocabulary either — same simplified error. LOCAL_OFFSET_NED (7) is NOT in
  // this list any more: it came back as Steer's Offset reference (2026-08-13),
  // being both un-deprecated in common.xml and the only local frame ArduPlane
  // accepts. Terrain stays out until its datum is measured.
  for (const frame of [5, 6, 10, 11]) {
    assert.throws(
      () => resolveModeAndFrame({ mode: 'position', frame }),
      /not a SET_POSITION_TARGET frame/,
      `frame ${frame} must throw`
    );
  }
});




// ── Action derivation (§6 redesign): the operator states an intent, the
// wire follows — these functions ARE the new surface's contract ─────────────




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
  // submode and no §14 measurement — unmeasured stays off the surface (the
  // terrain-frame precedent). It refuses loud, here at derivation, because
  // the operator never typed a mode name for "unknown mode" to make sense of,
  // and a setpoint's missing ack would otherwise make the failure symptomless.
  assert.throws(
    () => deriveSteerMode(g({ accel: filled, position: filled })),
    /position \+ acceleration needs a velocity too/
  );
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
  // Still load-bearing, now for the presence rules rather than the deleted
  // coordinate guards: ' ' is not '', so without trimming it reaches Number()
  // and comes back a finite 0. Where that decides an *ignore bit* it changes
  // the command; where it decides a coordinate it just encodes 0.
  const whitespaceAxis = buildMoveMessage({ frame: 1,
    mode: 'position',
    target: { sysid: 2, compid: 1 },
    position: { north: ' ', east: 2, up: 3 },
  });
  assert.equal(whitespaceAxis.fields.x, 0, 'a whitespace axis encodes 0, same as blank');

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

test('buildStopMessage copies target ids and does not invent system 1', () => {
  const { buildStopMessage } = require('../../lib/move');
  const stop = buildStopMessage({
    fields: { time_boot_ms: 9, target_system: 4, target_component: 7 },
  });
  assert.equal(stop.fields.target_system, 4);
  assert.equal(stop.fields.target_component, 7);
  const missing = buildStopMessage({ fields: { time_boot_ms: 0 } });
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


test('Move streams on the Streaming band until TTL and emits a zero-velocity stop', () => {
  const sends = [];
  let timer;
  let now = 0;
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
      return 'timer';
    },
    clearInterval(handle) {
      assert.equal(handle, 'timer');
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




