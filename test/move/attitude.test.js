'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { quaternionFromEuler } = require('../../lib/move');


test('quaternionFromEuler is MAVLink order [w,x,y,z] and unit length', () => {
  assert.deepEqual(quaternionFromEuler(0, 0, 0), [1, 0, 0, 0], 'identity');
  for (const [roll, pitch, yaw] of [[0.3, -0.2, 1.1], [Math.PI / 2, 0, 0], [0, 0, Math.PI]]) {
    const q = quaternionFromEuler(roll, pitch, yaw);
    const norm = Math.sqrt(q.reduce((sum, v) => sum + v * v, 0));
    assert.ok(Math.abs(norm - 1) < 1e-12, `unit length for ${roll},${pitch},${yaw}`);
  }
  // Yaw-only rotates about z, which is the last component in MAVLink's order —
  // getting the order wrong would put it in x and roll the aircraft instead.
  const yawOnly = quaternionFromEuler(0, 0, Math.PI / 2);
  assert.ok(Math.abs(yawOnly[3] - Math.sin(Math.PI / 4)) < 1e-12, 'yaw lands in z');
  assert.ok(Math.abs(yawOnly[1]) < 1e-12, 'and not in x');
});

