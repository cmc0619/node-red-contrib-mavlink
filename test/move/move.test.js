'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BAND } = require('../../lib/connection/bands');
const { buildMoveMessage, createMoveStream } = require('../../lib/move');

test('local-position Move flips operator up-positive altitude to NED down-positive exactly once', () => {
  const message = buildMoveMessage({
    mode: 'local-position',
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

test('global-position Move encodes degrees to degE7 and keeps altitude up-positive', () => {
  const message = buildMoveMessage({
    mode: 'global-position',
    target: { sysid: 3, compid: 1 },
    position: { lat: 47.397742, lon: 8.545594, alt: 25 },
    timeBootMs: 42,
  });

  assert.equal(message.name, 'SET_POSITION_TARGET_GLOBAL_INT');
  assert.equal(message.fields.lat_int, 473977420);
  assert.equal(message.fields.lon_int, 85455940);
  assert.equal(message.fields.alt, 25);
});

test('global-position Move encodes whole-number degrees as degE7, not as raw wire values', () => {
  const message = buildMoveMessage({
    mode: 'global-position',
    target: { sysid: 3, compid: 1 },
    // Integer degrees must still scale by 1e7 — treating 47 as an already
    // encoded degE7 value would place the point at 47e-7 degrees.
    position: { lat: 47, lon: -122, alt: 10 },
    timeBootMs: 0,
  });

  assert.equal(message.fields.lat_int, 470000000);
  assert.equal(message.fields.lon_int, -1220000000);
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
    mode: 'local-velocity',
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
      mode: 'local-velocity',
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
