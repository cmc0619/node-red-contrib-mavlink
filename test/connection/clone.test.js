'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { deepCopy } = require('../../lib/connection/clone');

test('a typed-array field copies as the same typed array, not a plain object (R22)', () => {
  /**
   * The queue copies at enqueue; a Uint8Array that became `{0: 1, ...}` had
   * no `length`, so the serializer wrote zeros while send() reported `sent`.
   */
  const message = {
    name: 'GPS_RTCM_DATA',
    fields: { data: Uint8Array.from([1, 2, 3, 4]), f: Float32Array.from([NaN, 1.5]) },
  };
  const copy = deepCopy(message);
  assert.ok(copy.fields.data instanceof Uint8Array);
  assert.deepEqual([...copy.fields.data], [1, 2, 3, 4]);
  assert.ok(copy.fields.f instanceof Float32Array);
  assert.equal(Number.isNaN(copy.fields.f[0]), true);
  assert.equal(copy.fields.f[1], 1.5);
  message.fields.data[0] = 9;
  assert.equal(copy.fields.data[0], 1, 'the copy shares no storage with the original');
});

test('a Buffer field still copies as a Buffer', () => {
  const copy = deepCopy({ data: Buffer.from([5, 6]) });
  assert.ok(Buffer.isBuffer(copy.data));
  assert.deepEqual([...copy.data], [5, 6]);
});
