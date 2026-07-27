'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { encodeMessage, decodeMessage, FieldCodecError } = require('..');
const { field, expectFieldError } = require('./helpers');

const message = {
  name: 'TEST',
  fields: [
    field({ name: 'a', type: 'uint8_t' }),
    field({ name: 'b', type: 'uint16_t' }),
    field({ name: 'c', type: 'char', arrayLength: 4 }),
  ],
};

test('blank, explicit zero, and absent are three distinct states', () => {
  // explicit zero passes through untouched
  assert.deepEqual(encodeMessage(message, { a: 0, b: 0, c: 'hi' }), {
    a: 0,
    b: 0,
    c: 'hi\u0000\u0000',
  });

  // absent (key not present) is left out, never zero-filled
  const partial = encodeMessage(message, { a: 5 });
  assert.deepEqual(partial, { a: 5 });
  assert.ok(!('b' in partial));

  // blank (present but '') on a numeric field is an error naming the field
  expectFieldError(() => encodeMessage(message, { a: 1, b: '' }), FieldCodecError, 'b');
});

test('a key present with undefined is an error, not treated as absent', () => {
  // hasOwnProperty distinguishes {b: undefined} (present → error) from {} (absent → skipped)
  assert.throws(() => encodeMessage(message, { a: 1, b: undefined }), FieldCodecError);
  assert.doesNotThrow(() => encodeMessage(message, { a: 1 }));
});

test('message round-trips through encode then decode', () => {
  const values = { a: 200, b: 40000, c: 'GCS' };
  const wire = encodeMessage(message, values);
  const back = decodeMessage(message, wire);
  assert.deepEqual(back, { a: 200, b: 40000, c: 'GCS' });
});

test('enum metadata is threaded to bitmask fields by name', () => {
  const enumMeta = {
    MAV_MODE_FLAG: {
      name: 'MAV_MODE_FLAG',
      bitmask: true,
      entries: [
        { name: 'MAV_MODE_FLAG_SAFETY_ARMED', value: 128 },
        { name: 'MAV_MODE_FLAG_CUSTOM_MODE_ENABLED', value: 1 },
      ],
    },
  };
  const msg = {
    name: 'HEARTBEAT',
    fields: [field({ name: 'base_mode', type: 'uint8_t', enum: 'MAV_MODE_FLAG', display: 'bitmask' })],
  };
  const wire = encodeMessage(msg, { base_mode: ['MAV_MODE_FLAG_SAFETY_ARMED'] }, { enums: enumMeta });
  assert.equal(wire.base_mode, 128);
});
