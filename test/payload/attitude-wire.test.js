'use strict';

/**
 * The gimbal attitude verb is the one payload recipe whose wire field is an
 * array: GIMBAL_MANAGER_SET_ATTITUDE carries `q` as a float[4] the recipe
 * derives from friendly roll/pitch/yaw degrees (the compute slot). Everything
 * else in the payload path is a scalar, so this is the one thing a pure-lib
 * build test cannot prove — that the derived quaternion actually serializes
 * and round-trips through node-mavlink rather than throwing or truncating.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata');
const { createWire } = require('../../lib/connection/wire');
const { buildPayloadMessage } = require('../../lib/payload');

const wire = createWire({ bundle: loadBundled('common') });

test('the attitude quaternion serializes and round-trips, NaN rates and all', () => {
  const built = buildPayloadMessage({
    topic: 'gimbal',
    verb: 'aim',
    path: 'attitude',
    target: { sysid: 1, compid: 154 },
    values: { roll: 0, pitch: -30, yaw: 90 },
  });
  assert.equal(built.message.name, 'GIMBAL_MANAGER_SET_ATTITUDE');

  const frame = wire.serialize(built.message, { sysid: 42, compid: 200, seq: 0 });
  assert.ok(Buffer.isBuffer(frame) && frame.length > 0, 'a bad q array would throw here');

  const decoded = wire.decode(frame, 'ep-attitude');
  const messages = Array.isArray(decoded) ? decoded : (decoded && decoded.messages) || [];
  assert.equal(messages.length, 1, 'exactly one frame decoded');

  const m = messages[0];
  const fields = m.fields || (m.message && m.message.fields) || m;
  const q = Array.from(fields.q).map((n) => Math.round(Number(n) * 1e4) / 1e4);
  assert.deepEqual(q, built.message.fields.q.map((n) => Math.round(n * 1e4) / 1e4),
    'q survives the wire unchanged');
  // The angular-velocity triple is the "ignore" sentinel — NaN must ride, not
  // become a commanded zero rate (issue #87 parity with the pitch/yaw paths).
  assert.ok(Number.isNaN(Number(fields.angular_velocity_x)), 'roll rate stays NaN over the wire');
  assert.ok(Number.isNaN(Number(fields.angular_velocity_y)), 'pitch rate stays NaN over the wire');
  assert.ok(Number.isNaN(Number(fields.angular_velocity_z)), 'yaw rate stays NaN over the wire');
});
