'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assembleBitmask, decodeBitmask, encodeField, decodeField } = require('..');
const { field } = require('./helpers');

/** MAV_MODE_FLAG-style 8-bit bitmask enum. */
const modeFlags = {
  name: 'MAV_MODE_FLAG',
  bitmask: true,
  entries: [
    { name: 'MAV_MODE_FLAG_CUSTOM_MODE_ENABLED', value: 1 },
    { name: 'MAV_MODE_FLAG_TEST_ENABLED', value: 2 },
    { name: 'MAV_MODE_FLAG_AUTO_ENABLED', value: 4 },
    { name: 'MAV_MODE_FLAG_GUIDED_ENABLED', value: 8 },
    { name: 'MAV_MODE_FLAG_STABILIZE_ENABLED', value: 16 },
    { name: 'MAV_MODE_FLAG_HIL_ENABLED', value: 32 },
    { name: 'MAV_MODE_FLAG_MANUAL_INPUT_ENABLED', value: 64 },
    { name: 'MAV_MODE_FLAG_SAFETY_ARMED', value: 128 },
  ],
};

/** 32-bit enum whose top entry sits on bit 31 — the case that breaks `1 << 31`. */
const bit31Enum = {
  name: 'FAKE_STATUS',
  bitmask: true,
  entries: [
    { name: 'FLAG_LOW', value: 1 },
    { name: 'FLAG_BIT30', value: 1073741824 }, // 2 ** 30
    { name: 'FLAG_BIT31', value: 2147483648 }, // 2 ** 31
  ],
};

test('assembles a mask from entry names by OR-ing their values', () => {
  const mask = assembleBitmask(modeFlags, ['MAV_MODE_FLAG_SAFETY_ARMED', 'MAV_MODE_FLAG_CUSTOM_MODE_ENABLED']);
  assert.equal(mask, 129); // 128 + 1
});

test('bit 31 comes out positive (2147483648), never negative', () => {
  const mask = assembleBitmask(bit31Enum, ['FLAG_BIT31']);
  assert.equal(mask, 2147483648);
  assert.ok(mask > 0, 'bit 31 must stay positive so writeUInt32LE accepts it');

  const both = assembleBitmask(bit31Enum, ['FLAG_BIT31', 'FLAG_BIT30']);
  assert.equal(both, 2147483648 + 1073741824);

  // And it must actually serialize as an unsigned 32-bit value.
  const buf = Buffer.alloc(4);
  assert.doesNotThrow(() => buf.writeUInt32LE(mask, 0));
  assert.equal(buf.readUInt32LE(0), 2147483648);
});

test('OR is idempotent — duplicate and overlapping tokens do not double-count', () => {
  const twice = assembleBitmask(modeFlags, ['MAV_MODE_FLAG_SAFETY_ARMED', 'MAV_MODE_FLAG_SAFETY_ARMED']);
  assert.equal(twice, 128);
  // numeric tokens and combined values also merge without summing shared bits
  const combined = assembleBitmask(modeFlags, [128, 129]);
  assert.equal(combined, 129);
});

test('decode decomposes a mask into entry names with lossless unknown bits', () => {
  const { names, unknownBits } = decodeBitmask(modeFlags, 129);
  assert.deepEqual(new Set(names), new Set(['MAV_MODE_FLAG_SAFETY_ARMED', 'MAV_MODE_FLAG_CUSTOM_MODE_ENABLED']));
  assert.deepEqual(unknownBits, []);

  const withUnknown = decodeBitmask(modeFlags, 129 + 512); // bit 9 has no entry
  assert.deepEqual(withUnknown.unknownBits, [9]);
});

test('bitmask round-trips through names', () => {
  const names = ['MAV_MODE_FLAG_AUTO_ENABLED', 'MAV_MODE_FLAG_GUIDED_ENABLED', 'MAV_MODE_FLAG_SAFETY_ARMED'];
  const mask = assembleBitmask(modeFlags, names);
  assert.deepEqual(new Set(decodeBitmask(modeFlags, mask).names), new Set(names));
});

test('uint64 masks use BigInt and stay exact past 2^53', () => {
  const big = {
    name: 'BIG_FLAGS',
    bitmask: true,
    entries: [
      { name: 'BIT0', value: 1 },
      { name: 'BIT62', value: '4611686018427387904' }, // 2 ** 62
      { name: 'BIT63', value: '9223372036854775808' }, // 2 ** 63
    ],
  };
  const mask = assembleBitmask(big, ['BIT63', 'BIT0'], true);
  assert.equal(typeof mask, 'bigint');
  assert.equal(mask, 9223372036854775809n);
  const decoded = decodeBitmask(big, mask, true);
  assert.deepEqual(new Set(decoded.names), new Set(['BIT63', 'BIT0']));
});

test('encodeField assembles a bitmask field from an array of names', () => {
  const f = field({ name: 'base_mode', type: 'uint32_t', enum: 'FAKE_STATUS', display: 'bitmask' });
  const wire = encodeField(f, ['FLAG_BIT31', 'FLAG_LOW'], bit31Enum);
  assert.equal(wire, 2147483648 + 1);
  assert.equal(decodeField(f, wire), 2147483649);
});

test('encodeField resolves a scalar enum entry name to its value', () => {
  const mavType = {
    name: 'MAV_TYPE',
    bitmask: false,
    entries: [
      { name: 'MAV_TYPE_GENERIC', value: 0 },
      { name: 'MAV_TYPE_QUADROTOR', value: 2 },
    ],
  };
  const f = field({ name: 'type', type: 'uint8_t', enum: 'MAV_TYPE' });
  assert.equal(encodeField(f, 'MAV_TYPE_QUADROTOR', mavType), 2);
  assert.equal(encodeField(f, 2, mavType), 2); // numbers still pass through
  assert.throws(() => encodeField(f, 'MAV_TYPE_NONSENSE', mavType));
});
