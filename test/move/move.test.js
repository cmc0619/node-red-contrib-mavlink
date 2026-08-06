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
    yaw: 1.25,
    timeBootMs: 77,
  });

  assert.equal(message.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.equal(message.fields.target_system, 2);
  assert.equal(message.fields.target_component, 1);
  assert.equal(message.fields.x, 4);
  assert.equal(message.fields.y, -3);
  assert.equal(message.fields.z, -12);
  assert.equal(message.fields.yaw, 1.25);
  assert.equal(message.fields.type_mask, 2552);
});

test('global position Move encodes degrees to degE7 and keeps altitude up-positive', () => {
  const message = buildMoveMessage({
    mode: 'position',
    frame: 'GLOBAL_RELATIVE_ALT_INT',
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
    frame: 'GLOBAL_RELATIVE_ALT_INT',
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
    yaw: 1.57,
  });
  // Ignore position (7) + velocity (56) + accel (448) + yaw rate (2048); yaw used.
  assert.equal(message.fields.type_mask, 7 + 56 + 448 + 2048);
  assert.equal(message.fields.yaw, 1.57);

  // Both blank would be the all-ignore packet PX4 rejects (§14 / #115).
  assert.throws(
    () => buildMoveMessage({ mode: 'yaw-only', target: { sysid: 2, compid: 1 } }),
    /yaw or yaw rate/
  );
});

test('frame names select the carrier message and coordinate_frame value', () => {
  const body = buildMoveMessage({
    mode: 'position',
    frame: 'BODY_OFFSET_NED',
    target: { sysid: 2, compid: 1 },
    position: { north: 10, east: 0, up: 0 },
  });
  assert.equal(body.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.equal(body.fields.coordinate_frame, 9);

  const terrain = buildMoveMessage({
    mode: 'position',
    frame: 'GLOBAL_TERRAIN_ALT_INT',
    target: { sysid: 2, compid: 1 },
    position: { lat: 47, lon: 8, alt: 30 },
  });
  assert.equal(terrain.name, 'SET_POSITION_TARGET_GLOBAL_INT');
  assert.equal(terrain.fields.coordinate_frame, 11);
  assert.equal(terrain.fields.lat_int, 470000000);

  // Velocity in a global frame rides GLOBAL_INT with position ignored.
  const globalVel = buildMoveMessage({
    mode: 'velocity',
    frame: 'GLOBAL_RELATIVE_ALT_INT',
    target: { sysid: 2, compid: 1 },
    velocity: { north: 1, east: 0, up: 0 },
  });
  assert.equal(globalVel.name, 'SET_POSITION_TARGET_GLOBAL_INT');
  assert.equal(globalVel.fields.type_mask & 7, 7);

  assert.throws(
    () => buildMoveMessage({ mode: 'position', frame: 'BODY_FRD', target: { sysid: 2, compid: 1 } }),
    /unknown Move frame/
  );
  assert.throws(
    () => buildMoveMessage({ mode: 'position', frame: 2, target: { sysid: 2, compid: 1 } }),
    /not a SET_POSITION_TARGET frame/
  );
});

test('`frame` is the only frame spelling — `coordinateFrame` is not an alias', () => {
  const global = {
    mode: 'position',
    target: { sysid: 2, compid: 1 },
    position: { lat: 47, lon: 8, alt: 10 },
  };

  // Pre-1.0, no aliases (AGENTS.md): nothing in the editor, tests, examples or
  // docs ever used the second spelling, so it is deleted rather than kept
  // working. Supplying it fails loud — the frame falls to the LOCAL_NED default
  // and the local guard then refuses the global coordinates.
  assert.throws(
    () => buildMoveMessage({ ...global, coordinateFrame: 'GLOBAL_RELATIVE_ALT_INT' }),
    /requires north, east and up/
  );

  // Both real spellings of `frame` keep working: member name and raw number.
  for (const frame of ['GLOBAL_RELATIVE_ALT_INT', 6, '6']) {
    const message = buildMoveMessage({ ...global, frame });
    assert.equal(message.fields.coordinate_frame, 6, `frame ${JSON.stringify(frame)} resolves`);
  }

  // Blank still defaults; whitespace deliberately does *not* — it throws rather
  // than silently defaulting past a configured frame (see the comment in
  // resolveModeAndFrame, and #174).
  for (const blank of [undefined, null, '']) {
    const message = buildMoveMessage({
      mode: 'position',
      frame: blank,
      target: { sysid: 2, compid: 1 },
      position: { north: 1, east: 2, up: 3 },
    });
    assert.equal(message.fields.coordinate_frame, 1, `blank ${JSON.stringify(blank)} defaults`);
  }
  assert.throws(
    () => buildMoveMessage({
      mode: 'position',
      frame: ' ',
      target: { sysid: 2, compid: 1 },
      position: { north: 1, east: 2, up: 3 },
    }),
    /unknown Move frame/
  );
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

test('local position with a blank coordinate refuses — never the origin (§10)', () => {
  // A blank north zero-filled into a LOCAL_NED position setpoint commands the
  // world origin. Explicit 0 is a value; blank refuses. Velocity blanks stay
  // 0 — a zero rate is inert, not a place.
  assert.throws(
    () =>
      buildMoveMessage({
        mode: 'position',
        target: { sysid: 2, compid: 1 },
        position: { north: '', east: 2, up: 3 },
      }),
    /blank coordinates must not become the origin/
  );
  const velocityBlanks = buildMoveMessage({
    mode: 'velocity',
    target: { sysid: 2, compid: 1 },
    velocity: { north: 1 },
  });
  assert.equal(velocityBlanks.fields.vy, 0);
});

test('global position with blank lat, lon or alt refuses — never 0,0 at ground level (§10)', () => {
  assert.throws(
    () =>
      buildMoveMessage({
        mode: 'position',
        frame: 'GLOBAL_RELATIVE_ALT_INT',
        target: { sysid: 2, compid: 1 },
        position: { lat: '', lon: 8, alt: 10 },
      }),
    /blank coordinates must not become 0,0/
  );
  // A blank alt zero-filled is the same hazard on the vertical axis: 0 m above
  // home (frame 6) or 0 m AGL (frame 11) is the ground, 0 m MSL (frame 5) may
  // be below it. An explicit 0 stays a value; blank refuses.
  for (const frame of ['GLOBAL_RELATIVE_ALT_INT', 'GLOBAL_INT', 'GLOBAL_TERRAIN_ALT_INT']) {
    assert.throws(
      () =>
        buildMoveMessage({
          mode: 'position',
          frame,
          target: { sysid: 2, compid: 1 },
          position: { lat: 47, lon: 8 },
        }),
      /blank coordinates must not become 0,0/,
      `${frame} must refuse a blank alt`
    );
  }
  const explicitZero = buildMoveMessage({
    mode: 'position',
    frame: 'GLOBAL_RELATIVE_ALT_INT',
    target: { sysid: 2, compid: 1 },
    position: { lat: 47, lon: 8, alt: 0 },
  });
  assert.equal(explicitZero.fields.alt, 0);
});

test('a whitespace-only string is blank — Number(\' \') is a finite 0 (§10)', () => {
  // The blank guards are only as good as the blank test: ' ' is not '', so
  // without trimming it reaches numberOr, and Number(' ') === 0 passes the
  // finite check. Every one of these zero-fills somewhere dangerous.
  assert.throws(
    () => buildMoveMessage({
      mode: 'position',
      target: { sysid: 2, compid: 1 },
      position: { north: ' ', east: 2, up: 3 },
    }),
    /blank coordinates must not become the origin/
  );
  assert.throws(
    () => buildMoveMessage({
      mode: 'position',
      frame: 'GLOBAL_RELATIVE_ALT_INT',
      target: { sysid: 2, compid: 1 },
      position: { lat: 47, lon: 8, alt: '  ' },
    }),
    /blank coordinates must not become 0,0/
  );

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

test('advisoryFor fires only on measured-unsupported combos (§14, SITL 2026-08-05)', () => {
  const { advisoryFor } = require('../../lib/move');
  // Confirmed: PX4 1.18 produced no motion at all for either OFFSET frame.
  for (const frame of ['LOCAL_OFFSET_NED', 'BODY_OFFSET_NED']) {
    assert.match(advisoryFor({ mode: 'position', frame, firmware: 'px4' }), /OFFSET/);
  }
  // New from measurement: PX4 does not read BODY_NED as a body offset.
  assert.match(advisoryFor({ mode: 'position', frame: 'BODY_NED', firmware: 'px4' }), /BODY_NED/);
  // Supported combos and unknown firmware stay silent.
  assert.equal(advisoryFor({ mode: 'position', frame: 'LOCAL_NED', firmware: 'px4' }), null);
  assert.equal(advisoryFor({ mode: 'acceleration', frame: 'LOCAL_NED', firmware: 'px4' }), null);
  assert.equal(advisoryFor({ mode: 'acceleration', frame: 'LOCAL_NED', firmware: 'custom' }), null);
  assert.equal(advisoryFor({ mode: 'position', frame: 'LOCAL_NED' }), null);
});

test('measurement-refuted advisories are silent — a warning on working behaviour is noise (§14)', () => {
  const { advisoryFor } = require('../../lib/move');
  // ArduPilot Copter-4.7.0 *moved* ~43 m on an acceleration-only setpoint, so
  // "ArduPilot ignores acceleration-only" was wrong.
  assert.equal(advisoryFor({ mode: 'acceleration', frame: 'LOCAL_NED', firmware: 'ardupilot' }), null);
  // ArduPilot treated BODY_NED and BODY_OFFSET_NED identically (body-axis
  // offset), so "ArduPilot expects BODY_OFFSET_NED" was wrong.
  assert.equal(advisoryFor({ mode: 'position', frame: 'BODY_NED', firmware: 'ardupilot' }), null);
  assert.equal(advisoryFor({ mode: 'position', frame: 'BODY_OFFSET_NED', firmware: 'ardupilot' }), null);
  // PX4 accepted a terrain-altitude target and moved without complaint, so
  // "PX4 does not support terrain-altitude targets" was not supportable.
  assert.equal(advisoryFor({ mode: 'position', frame: 'GLOBAL_TERRAIN_ALT_INT', firmware: 'px4' }), null);
});

test('blank local coordinates: refused in absolute frames, inert in measured OFFSET frames (§14)', () => {
  const target = { sysid: 2, compid: 1 };
  // Absolute local frames — a blank zero-filled here commands the EKF origin.
  // BODY_NED is included deliberately: ArduPilot reads it as a body offset but
  // PX4 moved absolute-like, so it cannot claim the exemption.
  for (const frame of ['LOCAL_NED', 'BODY_NED']) {
    assert.throws(
      () => buildMoveMessage({ mode: 'position', frame, target, position: { north: '', east: 2, up: 3 } }),
      /blank coordinates must not become the origin/,
      `${frame} must refuse a blank coordinate`
    );
  }
  // Measured OFFSET frames — zero means "no change" on every axis, so a blank
  // is inert and passes as 0.
  for (const frame of ['LOCAL_OFFSET_NED', 'BODY_OFFSET_NED']) {
    const message = buildMoveMessage({
      mode: 'position',
      frame,
      target,
      position: { north: 10, east: '', up: '' },
    });
    assert.equal(message.fields.x, 10, `${frame} keeps the commanded axis`);
    assert.equal(message.fields.y, 0, `${frame} blank east is a zero offset`);
    assert.equal(message.fields.z, -0, `${frame} blank up is a zero offset`);
  }
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
    intervalMs: 100,
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
    intervalMs: 100,
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
