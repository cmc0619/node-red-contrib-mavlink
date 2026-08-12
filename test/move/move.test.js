'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BAND } = require('../../lib/connection/bands');
const { buildMoveMessage, createMoveStream } = require('../../lib/move');

test('position Move flips operator up-positive altitude to NED down-positive exactly once', () => {
  const message = buildMoveMessage({
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

test('position-velocity Move uses both vectors and ignores only acceleration', () => {
  const message = buildMoveMessage({
    mode: 'position-velocity',
    target: { sysid: 2, compid: 1 },
    position: { north: 10, east: 0, up: 5 },
    velocity: { north: 1.5, east: 0, up: 0.5 },
  });

  assert.equal(message.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.equal(message.fields.x, 10);
  assert.equal(message.fields.z, -5);
  assert.equal(message.fields.vx, 1.5);
  assert.equal(message.fields.vz, -0.5);
  // Ignore accel (448) + yaw (1024) + yaw rate (2048); position and velocity used.
  assert.equal(message.fields.type_mask, 448 + 1024 + 2048);
});

test('acceleration Move drives af* with the up-positive sign flipped once', () => {
  const message = buildMoveMessage({
    mode: 'acceleration',
    target: { sysid: 2, compid: 1 },
    accel: { north: 0.5, east: -0.25, up: 1 },
  });

  assert.equal(message.fields.afx, 0.5);
  assert.equal(message.fields.afy, -0.25);
  assert.equal(message.fields.afz, -1);
  // Ignore position (7) + velocity (56) + yaw + yaw rate.
  assert.equal(message.fields.type_mask, 7 + 56 + 1024 + 2048);
});

test('force is not a Move mode — no firmware actuated the force bit (§14)', () => {
  // Removed, not aliased (pre-1.0, no migrations): the mode throws naming the
  // valid set rather than quietly building an acceleration setpoint.
  assert.throws(
    () => buildMoveMessage({
      mode: 'force',
      target: { sysid: 2, compid: 1 },
      accel: { north: 2, east: 0, up: 3 },
    }),
    /unknown Move mode "force"/
  );
});

test('yaw-only Move ignores every translation vector and requires yaw or yaw rate', () => {
  const message = buildMoveMessage({
    mode: 'yaw-only',
    target: { sysid: 2, compid: 1 },
    yaw: 180,
  });
  // Ignore position (7) + velocity (56) + accel (448) + yaw rate (2048); yaw used.
  assert.equal(message.fields.type_mask, 7 + 56 + 448 + 2048);
  // Degrees in, radians out: 180 deg is exactly π.
  assert.equal(message.fields.yaw, Math.PI);

  // Both blank would be the all-ignore packet PX4 rejects (§14 / #115).
  assert.throws(
    () => buildMoveMessage({ mode: 'yaw-only', target: { sysid: 2, compid: 1 } }),
    /yaw or yaw rate/
  );
});

test('numeric frames select the carrier message and coordinate_frame value', () => {
  const body = buildMoveMessage({
    mode: 'position',
    frame: 9,
    target: { sysid: 2, compid: 1 },
    position: { north: 10, east: 0, up: 0 },
  });
  assert.equal(body.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.equal(body.fields.coordinate_frame, 9);

  // Velocity in a global frame rides GLOBAL_INT with position ignored.
  const globalVel = buildMoveMessage({
    mode: 'velocity',
    frame: 3,
    target: { sysid: 2, compid: 1 },
    velocity: { north: 1, east: 0, up: 0 },
  });
  assert.equal(globalVel.name, 'SET_POSITION_TARGET_GLOBAL_INT');
  assert.equal(globalVel.fields.type_mask & 7, 7);

  assert.throws(
    () => buildMoveMessage({ mode: 'position', frame: 2, target: { sysid: 2, compid: 1 } }),
    /not a SET_POSITION_TARGET frame/
  );
});

test('`frame` is numeric-only: a derived number resolves, blank defaults to LOCAL_NED', () => {
  const global = {
    mode: 'position',
    target: { sysid: 2, compid: 1 },
    position: { lat: 47, lon: 8, alt: 10 },
  };

  // The derivation hands the builder a number; a numeric string still resolves.
  for (const frame of [3, '3']) {
    const message = buildMoveMessage({ ...global, frame });
    assert.equal(message.fields.coordinate_frame, 6, `frame ${JSON.stringify(frame)} resolves (wire twin 6)`);
  }

  // Blank defaults, and whitespace is blank (#174): a builder-level safety,
  // still exercised — "nothing supplied" is the frame that works everywhere.
  for (const blank of [undefined, null, '', ' ']) {
    const message = buildMoveMessage({
      mode: 'position',
      frame: blank,
      target: { sysid: 2, compid: 1 },
      position: { north: 1, east: 2, up: 3 },
    });
    assert.equal(message.fields.coordinate_frame, 1, `blank ${JSON.stringify(blank)} defaults`);
  }
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
  // The deprecated wire numbers and the retired terrain/offset frames are not
  // in the vocabulary either — same simplified error.
  for (const frame of [5, 6, 7, 10, 11]) {
    assert.throws(
      () => resolveModeAndFrame({ mode: 'position', frame }),
      /not a SET_POSITION_TARGET frame/,
      `frame ${frame} must throw`
    );
  }
});

test('global setpoint frames always transmit the *_INT twin — the wire number is code, not a choice (§6 redesign)', () => {
  // px4Compat is deleted, not defaulted: PX4 main exact-matches 5/6/11 and
  // discards anything else, and every current stack accepts the twins — no
  // operator benefits from the spec-current number on this carrier.
  const base = {
    mode: 'position',
    target: { sysid: 2, compid: 1 },
    position: { lat: 47, lon: 8, alt: 10 },
  };
  const wire = new Map([[0, 5], [3, 6]]);
  for (const [frame, twin] of wire) {
    assert.equal(
      buildMoveMessage({ ...base, frame }).fields.coordinate_frame,
      twin,
      `frame ${frame} transmits the *_INT twin`
    );
  }
  // Local frames carry their own number; the twin swap is a global-frame rule.
  const local = buildMoveMessage({
    mode: 'position',
    frame: 1,
    target: { sysid: 2, compid: 1 },
    position: { north: 1, east: 2, up: 3 },
  });
  assert.equal(local.fields.coordinate_frame, 1);
});

test('a blank global coordinate encodes 0 — deliberate, ruled, and pinned here (§14)', () => {
  // NOT a bug and not an oversight. Both inputs to this builder are handled
  // elsewhere: config coordinates are editor-validated, and msg.payload is
  // trusted and checked nowhere by design. Null island is the accepted cost,
  // recorded in §14. Do not add a guard here — this test is what makes doing
  // so fail loudly instead of passing quietly.
  //
  // Only the blank is pinned. An out-of-range coordinate takes the same
  // multiply as a legal one (degreesToDegE7 is numberOr + Math.round), so
  // asserting on 200° would restate the extremes test below without covering
  // a single extra branch.
  const blank = buildMoveMessage({
    mode: 'position',
    frame: 3,
    target: { sysid: 2, compid: 1 },
    position: { lat: '', lon: 8, alt: 10 },
  });
  assert.equal(blank.fields.lat_int, 0, 'blank lat encodes 0, it does not throw');
  assert.equal(blank.fields.alt, 10, 'and the fields around it are untouched');
});

test('degE7 encoding is exact at the coordinate extremes', () => {
  // This layer does not range-check: an out-of-range coordinate scales and
  // rides the wire, and the editor is where it is caught (AGENTS.md, input
  // trust). What matters here is that the legal extremes encode exactly —
  // degE7 is an int32 and ±180° is 1.8e9, well inside it.
  const base = { mode: 'position', frame: 3, target: { sysid: 2, compid: 1 } };
  const poles = buildMoveMessage({ ...base, position: { lat: 90, lon: -180, alt: 10 } });
  assert.equal(poles.fields.lat_int, 900000000);
  assert.equal(poles.fields.lon_int, -1800000000);
  const antipode = buildMoveMessage({ ...base, position: { lat: -90, lon: 180, alt: 10 } });
  assert.equal(antipode.fields.lat_int, -900000000);
  assert.equal(antipode.fields.lon_int, 1800000000);
});

// ── Action derivation (§6 redesign): the operator states an intent, the
// wire follows — these functions ARE the new surface's contract ─────────────

test('resolveMoveAction: blank parses steer (the old setpoint default), unknown throws naming the set', () => {
  const { resolveMoveAction } = require('../../lib/move');
  for (const blank of [undefined, null, '', ' ']) {
    assert.equal(resolveMoveAction(blank), 'steer', `${JSON.stringify(blank)} parses steer`);
  }
  assert.equal(resolveMoveAction('goto'), 'goto');
  assert.equal(resolveMoveAction('steer'), 'steer');
  assert.throws(() => resolveMoveAction('teleport'), /unknown Move action "teleport" — expected goto or steer/);
});

test('frameForAltRef: home → 3, msl → 0, blank → home; terrain is unreachable from the surface (§14)', () => {
  const { frameForAltRef } = require('../../lib/move');
  assert.equal(frameForAltRef('home'), 3);
  assert.equal(frameForAltRef('msl'), 0);
  for (const blank of [undefined, null, '']) {
    assert.equal(frameForAltRef(blank), 3, `blank ${JSON.stringify(blank)} defaults to home, the GCS default`);
  }
  // Terrain is deliberately absent — unmeasured on both stacks, dropped from
  // the surface until it isn't. It refuses loud, never a silent global guess.
  assert.throws(() => frameForAltRef('terrain'), /unknown Move altitude reference "terrain"/);
  assert.throws(() => frameForAltRef('agl'), /expected home \(above home\) or msl \(absolute\)/);
});

test('frameForReference: world is LOCAL_NED and never needs firmware; body derives per stack and fails closed (§14)', () => {
  const { frameForReference } = require('../../lib/move');
  // World works everywhere — firmware is not consulted at all.
  assert.equal(frameForReference('world', undefined), 1);
  assert.equal(frameForReference('world', 'ardupilot'), 1);
  for (const blank of [undefined, null, '']) {
    assert.equal(frameForReference(blank, undefined), 1, `blank ${JSON.stringify(blank)} defaults to world`);
  }
  // Measured (§14 2026-08-05): the stacks read *different* body frames.
  assert.equal(frameForReference('body', 'ardupilot'), 9, 'ArduPilot reads BODY_OFFSET_NED');
  assert.equal(frameForReference('body', 'px4'), 8, 'PX4 reads BODY_NED');
  // Unknown stack fails closed — the wrong frame number is silently dropped
  // by the vehicle, exactly the wrong the derivation exists to prevent.
  assert.throws(() => frameForReference('body', undefined), /Vehicle Profile with firmware ardupilot or px4/);
  assert.throws(() => frameForReference('body', 'custom'), /Vehicle Profile with firmware ardupilot or px4/);
  assert.throws(() => frameForReference('sideways', undefined), /unknown Move reference "sideways"/);
});

test('deriveSteerMode: filling fields IS the mode — the CSV rule, with loud refusals at the edges', () => {
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

  // Acceleration composes with nothing in the wire vocabulary: mixing refuses
  // loud rather than silently dropping a group.
  assert.throws(() => deriveSteerMode(g({ accel: filled, position: filled })), /cannot mix acceleration/);
  assert.throws(() => deriveSteerMode(g({ accel: filled, velocity: filled })), /cannot mix acceleration/);
  // Nothing filled is nothing to command — never an all-ignore packet (§14 / #115).
  assert.throws(() => deriveSteerMode(g()), /nothing to command/);

  // Only the LOCAL triplet names the position group (Codex, #277): a node
  // switched from Go to keeps its hidden lat/lon/alt serialized, and
  // positionFrom carries both families. Stale globals must not turn a
  // velocity-only steer into position-velocity — nor rescue an empty one.
  const staleGlobals = { north: '', east: '', up: '', lat: 47.1, lon: 8.5, alt: 25 };
  assert.equal(deriveSteerMode(g({ position: staleGlobals, velocity: filled })), 'velocity');
  assert.equal(deriveSteerMode(g({ position: staleGlobals, accel: filled })), 'acceleration');
  assert.throws(() => deriveSteerMode(g({ position: staleGlobals })), /nothing to command/);
});

test('one canonical vocabulary: defaults are position/LOCAL_NED, old names throw', () => {
  const defaulted = buildMoveMessage({
    target: { sysid: 2, compid: 1 },
    position: { north: 1, east: 2, up: 3 },
  });
  assert.equal(defaulted.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.equal(defaulted.fields.coordinate_frame, 1);

  // Pre-1.0, no aliases: the pre-frame mode names are gone, not mapped.
  for (const legacy of ['local-position', 'local-velocity', 'global-position', 'sideways']) {
    assert.throws(
      () => buildMoveMessage({ mode: legacy, target: { sysid: 2, compid: 1 } }),
      /unknown Move mode/
    );
  }
});

test('a blank local coordinate encodes 0, on every frame — deliberate, ruled (§14)', () => {
  // The local twin of the global rule, and the same reasoning: config
  // coordinates are editor-validated and msg.payload is trusted and checked
  // nowhere, so the builder coerces. On an absolute frame that 0 is the EKF
  // origin — a real place, and the accepted cost. Do not add a guard here.
  //
  // Frames used to differ: absolute ones refused and BODY_OFFSET_NED (9) let
  // blanks through as "no change". They behave alike now, which is why one
  // test covers all three.
  const target = { sysid: 2, compid: 1 };
  for (const frame of [1, 8, 9]) {
    const message = buildMoveMessage({
      mode: 'position', frame, target, position: { north: '', east: 2, up: 3 },
    });
    assert.equal(message.fields.x, 0, `frame ${frame}: blank north encodes 0`);
    assert.equal(message.fields.y, 2, `frame ${frame}: the axes around it are untouched`);
  }

  // Velocity and acceleration blanks were never the question — a zero rate is
  // inert, not a place — and they still encode 0.
  const velocityBlanks = buildMoveMessage({
    mode: 'velocity',
    target,
    velocity: { north: 1 },
  });
  assert.equal(velocityBlanks.fields.vy, 0);
});

test('a whitespace-only string is blank — Number(\' \') is a finite 0 (§10)', () => {
  // Still load-bearing, now for the presence rules rather than the deleted
  // coordinate guards: ' ' is not '', so without trimming it reaches Number()
  // and comes back a finite 0. Where that decides an *ignore bit* it changes
  // the command; where it decides a coordinate it just encodes 0.
  const whitespaceAxis = buildMoveMessage({
    mode: 'position',
    target: { sysid: 2, compid: 1 },
    position: { north: ' ', east: 2, up: 3 },
  });
  assert.equal(whitespaceAxis.fields.x, 0, 'a whitespace axis encodes 0, same as blank');

  // Yaw follows the presence rule: whitespace is absent, so the ignore bit
  // stays set rather than commanding a yaw of 0 (north) nobody asked for.
  const yawBlank = buildMoveMessage({
    mode: 'position',
    target: { sysid: 2, compid: 1 },
    position: { north: 1, east: 2, up: 3 },
    yaw: ' ',
  });
  assert.equal(yawBlank.fields.type_mask & 1024, 1024, 'whitespace yaw stays ignored');
  assert.equal(yawBlank.fields.yaw, 0);

  // A real value is still a value, whitespace-padded or not.
  const padded = buildMoveMessage({
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

test('buildStopMessage is zero-velocity (mask 3527), not all-ignore (3583)', () => {
  // #115 / §14: PX4 rejects all-ignore; our stop keeps VX/VY/VZ usable at 0.
  const { buildStopMessage, buildMoveMessage } = require('../../lib/move');
  const stop = buildStopMessage({
    fields: { time_boot_ms: 0, target_system: 1, target_component: 1 },
  });
  const vel = buildMoveMessage({
    mode: 'velocity',
    target: { sysid: 1, compid: 1 },
    velocity: { north: 1, east: 0, up: 0 },
  });
  assert.equal(stop.fields.type_mask, 3527);
  assert.equal(stop.fields.type_mask, vel.fields.type_mask);
  assert.equal(stop.fields.vx, 0);
  assert.equal(stop.fields.vy, 0);
  assert.equal(stop.fields.vz, 0);
  // VX/VY/VZ ignore bits must be clear (8+16+32 = 56).
  assert.equal(stop.fields.type_mask & 56, 0);
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
    message: buildMoveMessage({
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

test('onExpire fires on TTL with the stop message, and never on a caller stop', () => {
  const expiries = [];
  let timer;
  let now = 0;
  const options = {
    connection: { send() {} },
    message: buildMoveMessage({
      mode: 'velocity',
      target: { sysid: 4, compid: 1 },
      velocity: { north: 1, east: 0, up: 0 },
    }),
    target: { sysid: 4, compid: 1 },
    rateHz: 10,
    ttlMs: 250,
    now: () => now,
    setInterval(fn) { timer = fn; return 'timer'; },
    clearInterval() {},
    onExpire: (stopMessage) => expiries.push(stopMessage),
  };

  // A caller-driven stop is already known to the caller — silent.
  const replaced = createMoveStream(options);
  replaced.start();
  replaced.stop();
  assert.equal(expiries.length, 0, 'stop() must not notify');

  const expiring = createMoveStream(options);
  expiring.start();
  now = 260;
  timer();

  assert.equal(expiring.active, false);
  assert.equal(expiries.length, 1, 'TTL expiry notifies exactly once');
  // The stop packet the vehicle actually got, not the streamed setpoint.
  assert.equal(expiries[0].name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.equal(expiries[0].fields.type_mask, 3527);
  assert.equal(expiries[0].fields.vx, 0);

  // The timer firing again after expiry must not re-notify.
  timer();
  assert.equal(expiries.length, 1);
});

test('stop({brake:false}) hands over without a brake; a default stop brakes', () => {
  // GCS practice (§ "Move setpoint matrix"): the brake marks the *end* of
  // control — a replacement handover sends nothing between old and new.
  const sends = [];
  let timer;
  const make = () =>
    createMoveStream({
      connection: { send(message) { sends.push(message); } },
      message: buildMoveMessage({
        mode: 'velocity',
        target: { sysid: 4, compid: 1 },
        velocity: { north: 1, east: 0, up: 0 },
      }),
      target: { sysid: 4, compid: 1 },
      rateHz: 10,
      ttlMs: 0,
      now: () => 0,
      setInterval(fn) { timer = fn; return 'timer'; },
      clearInterval() {},
    });

  const handover = make();
  handover.start();
  assert.equal(sends.length, 1);
  assert.equal(handover.stop({ brake: false }), null, 'no brake, so no brake message');
  assert.equal(sends.length, 1, 'handover stop sends nothing');
  assert.equal(handover.active, false);
  timer();
  assert.equal(sends.length, 1, 'a cleared stream never sends again');

  const ending = make();
  ending.start();
  const brake = ending.stop();
  assert.equal(sends.length, 3);
  assert.equal(brake.fields.type_mask, 3527);
  assert.equal(sends[2].fields.vx, 0, 'default stop is the zero-velocity brake');
});

test('a tick send that throws is contained: keep cadence, one report per streak, count only accepted sends', () => {
  // Connection.send throws by design (identity resolution on a dead link);
  // uncaught inside the interval callback that is a process crash. The stream
  // never quits on send failure — the firmware setpoint watchdog is the
  // failsafe (§ "Move setpoint matrix").
  let timer;
  let fail = false;
  const attempts = [];
  const errors = [];
  let recoveries = 0;
  const stream = createMoveStream({
    connection: {
      send(message) {
        attempts.push(message);
        if (fail) throw new Error('identity unresolved');
      },
    },
    message: buildMoveMessage({
      mode: 'velocity',
      target: { sysid: 4, compid: 1 },
      velocity: { north: 1, east: 0, up: 0 },
    }),
    target: { sysid: 4, compid: 1 },
    rateHz: 10,
    ttlMs: 0,
    now: () => 0,
    setInterval(fn) { timer = fn; return 'timer'; },
    clearInterval() {},
    onSendError: (err) => errors.push(err.message),
    onSendRecovery: () => recoveries++,
  });

  stream.start();
  assert.equal(stream.sent, 1, 'the initial send counts');

  fail = true;
  timer();
  timer();
  timer();
  assert.equal(errors.length, 1, 'one report per streak, not per tick');
  assert.match(errors[0], /identity unresolved/);
  assert.equal(attempts.length, 4, 'the stream kept its cadence through the streak');
  assert.equal(stream.active, true, 'send failure never stops the stream');

  fail = false;
  timer();
  assert.equal(recoveries, 1, 'first success after a streak reports recovery');

  fail = true;
  timer();
  assert.equal(errors.length, 2, 'fail, fail, succeed, fail → two reports');
  assert.equal(stream.sent, 2, 'failed attempts do not count as sent');
});

test('a throwing expiry brake still completes expiry bookkeeping', () => {
  let timer;
  let now = 0;
  let brakeFail = false;
  const expiries = [];
  const stream = createMoveStream({
    connection: {
      send() {
        if (brakeFail) throw new Error('link down');
      },
    },
    message: buildMoveMessage({
      mode: 'velocity',
      target: { sysid: 4, compid: 1 },
      velocity: { north: 1, east: 0, up: 0 },
    }),
    target: { sysid: 4, compid: 1 },
    rateHz: 10,
    ttlMs: 100,
    now: () => now,
    setInterval(fn) { timer = fn; return 'timer'; },
    clearInterval() {},
    onExpire: (stopMessage, brakeError) => expiries.push({ stopMessage, brakeError }),
  });

  stream.start();
  brakeFail = true;
  now = 150;
  timer();

  assert.equal(stream.active, false, 'the stream still ended');
  assert.equal(expiries.length, 1, 'expiry still notified');
  assert.equal(expiries[0].stopMessage, null, 'no brake reached the wire');
  assert.match(expiries[0].brakeError.message, /link down/);
});
