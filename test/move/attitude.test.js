'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAttitudeMessage, quaternionFromEuler } = require('../../lib/move');

const target = { sysid: 5, compid: 1 };

/** ATTITUDE_TARGET_TYPEMASK bits, from the dialect. */
const IGNORE = {
  ROLL_RATE: 1, PITCH_RATE: 2, YAW_RATE: 4, THROTTLE: 64, ATTITUDE: 128,
};

test('attitude builds SET_ATTITUDE_TARGET with a quaternion the operator never types', () => {
  const message = buildAttitudeMessage({ roll: 30, thrust: 0.6, target, timeBootMs: 0 });
  assert.equal(message.name, 'SET_ATTITUDE_TARGET');
  assert.equal(message.fields.target_system, 5);
  assert.equal(message.fields.target_component, 1);
  // Degrees in, q[4] out — converted exactly once at encode, the same rule as
  // degE7 and radians. 30° roll: w = cos(15°), x = sin(15°).
  const [w, x, y, z] = message.fields.q;
  assert.ok(Math.abs(w - Math.cos(Math.PI / 12)) < 1e-12);
  assert.ok(Math.abs(x - Math.sin(Math.PI / 12)) < 1e-12);
  assert.ok(Math.abs(y) < 1e-12);
  assert.ok(Math.abs(z) < 1e-12);
  assert.equal(message.fields.thrust, 0.6);
});

test('presence drives the type_mask — filling fields IS the mode, as on Steer', () => {
  const maskFor = (input) => buildAttitudeMessage({ ...input, target }).fields.type_mask;

  // Nothing commanded: every ignore bit set.
  assert.equal(
    maskFor({}),
    IGNORE.ROLL_RATE + IGNORE.PITCH_RATE + IGNORE.YAW_RATE + IGNORE.THROTTLE + IGNORE.ATTITUDE,
    'all-blank ignores everything'
  );
  // An angle clears ATTITUDE_IGNORE; the rates and throttle stay ignored.
  assert.equal(
    maskFor({ roll: 10 }),
    IGNORE.ROLL_RATE + IGNORE.PITCH_RATE + IGNORE.YAW_RATE + IGNORE.THROTTLE
  );
  // Any one angle names the whole attitude group — the mask has one bit for
  // all three, so a partial attitude is a complete quaternion.
  assert.equal(maskFor({ yaw: 90 }), maskFor({ roll: 10 }), 'yaw alone is the same group');
  // Each rate clears only its own bit.
  assert.equal(
    maskFor({ rollRate: 5 }),
    IGNORE.PITCH_RATE + IGNORE.YAW_RATE + IGNORE.THROTTLE + IGNORE.ATTITUDE
  );
  // Thrust clears THROTTLE_IGNORE, and an explicit 0 is a commanded zero.
  assert.equal(
    maskFor({ thrust: 0 }),
    IGNORE.ROLL_RATE + IGNORE.PITCH_RATE + IGNORE.YAW_RATE + IGNORE.ATTITUDE,
    'thrust 0 is commanded, not blank'
  );
  assert.equal(maskFor({ roll: 0, pitch: 0, yaw: 0, rollRate: 0, pitchRate: 0, yawRate: 0, thrust: 0 }), 0);
});

test('body rates convert degrees per second to radians per second exactly once', () => {
  const fields = buildAttitudeMessage({
    rollRate: 180, pitchRate: -90, yawRate: 45, target,
  }).fields;
  assert.ok(Math.abs(fields.body_roll_rate - Math.PI) < 1e-12);
  assert.ok(Math.abs(fields.body_pitch_rate + Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(fields.body_yaw_rate - Math.PI / 4) < 1e-12);
  // A blank rate is mask-ignored and encodes 0 — the field must hold something.
  assert.equal(buildAttitudeMessage({ target }).fields.body_roll_rate, 0);
});

test('quaternionFromEuler is MAVLink order [w,x,y,z] and unit length', () => {
  assert.deepEqual(quaternionFromEuler(0, 0, 0), [1, 0, 0, 0], 'identity');
  for (const [r, p, y] of [[0.3, -0.2, 1.1], [Math.PI / 2, 0, 0], [0, 0, Math.PI]]) {
    const q = quaternionFromEuler(r, p, y);
    const norm = Math.sqrt(q.reduce((sum, v) => sum + v * v, 0));
    assert.ok(Math.abs(norm - 1) < 1e-12, `unit length for ${r},${p},${y}`);
  }
  // Yaw-only rotates about z, which is the last component in MAVLink's order —
  // getting the order wrong would put it in x and roll the aircraft instead.
  const yawOnly = quaternionFromEuler(0, 0, Math.PI / 2);
  assert.ok(Math.abs(yawOnly[3] - Math.sin(Math.PI / 4)) < 1e-12, 'yaw lands in z');
  assert.ok(Math.abs(yawOnly[1]) < 1e-12, 'and not in x');
});

test('attitude refuses only what would serialize as garbage', () => {
  assert.throws(() => buildAttitudeMessage({ roll: 'over', target }), /expected a finite number/);
  assert.throws(() => buildAttitudeMessage({ thrust: 'full', target }), /expected a finite number/);
  assert.throws(() => buildAttitudeMessage({ rollRate: 'fast', target }), /expected a finite number/);
  // Out-of-range thrust is the editor's to catch and the vehicle's to judge —
  // it is a legal float, so the driver sends it (§2).
  assert.equal(buildAttitudeMessage({ thrust: 5, target }).fields.thrust, 5);
});
