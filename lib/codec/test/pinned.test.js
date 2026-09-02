'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { encodeMessage, decodeMessage } = require('..');
const { writePayload, readPayload, wireOrder, field } = require('./helpers');

/**
 * Pinned canonical payload bytes (DESIGN.md §5). A round trip alone blesses a
 * symmetric codec bug — encode and decode wrong in the same direction stay
 * perfect inverses — so these hand-computed little-endian vectors anchor the
 * codec to bytes every other MAVLink implementation agrees on. Payloads are
 * compared, never whole frames (sequence/signature/timestamp vary). Each
 * vector ends in a non-zero byte, so MAVLink v2 trailing-zero truncation is
 * moot and the full payload is the comparison.
 *
 * Field type/order/lengths verified against `mavlink-mappings` (common /
 * minimal), which stores fields already in wire order. Fixtures are written in
 * XML *declaration* order (bundle contract) and re-sorted by the wire writer.
 */

/** HEARTBEAT (id 0): a uint32 reordered ahead of five uint8s. */
const HEARTBEAT = {
  name: 'HEARTBEAT',
  fields: [
    field({ name: 'type', type: 'uint8_t' }),
    field({ name: 'autopilot', type: 'uint8_t' }),
    field({ name: 'base_mode', type: 'uint8_t' }),
    field({ name: 'custom_mode', type: 'uint32_t' }),
    field({ name: 'system_status', type: 'uint8_t' }),
    field({ name: 'mavlink_version', type: 'uint8_t' }),
  ],
};

/** SYSTEM_TIME (id 2): a uint64 then a uint32. */
const SYSTEM_TIME = {
  name: 'SYSTEM_TIME',
  fields: [
    field({ name: 'time_unix_usec', type: 'uint64_t' }),
    field({ name: 'time_boot_ms', type: 'uint32_t' }),
  ],
};

/** NAMED_VALUE_FLOAT (id 251): a float sorted ahead of a char[10]. */
const NAMED_VALUE_FLOAT = {
  name: 'NAMED_VALUE_FLOAT',
  fields: [
    field({ name: 'time_boot_ms', type: 'uint32_t' }),
    field({ name: 'name', type: 'char', arrayLength: 10 }),
    field({ name: 'value', type: 'float' }),
  ],
};

/** STATUSTEXT (id 253): base fields plus two extension fields kept unsorted. */
const STATUSTEXT = {
  name: 'STATUSTEXT',
  fields: [
    field({ name: 'severity', type: 'uint8_t' }),
    field({ name: 'text', type: 'char', arrayLength: 50 }),
    field({ name: 'id', type: 'uint16_t', extension: true }),
    field({ name: 'chunk_seq', type: 'uint8_t', extension: true }),
  ],
};

test('wire order reflects size-desc stable sort with extensions last', () => {
  assert.deepEqual(wireOrder(HEARTBEAT.fields).map((f) => f.name), [
    'custom_mode',
    'type',
    'autopilot',
    'base_mode',
    'system_status',
    'mavlink_version',
  ]);
  assert.deepEqual(wireOrder(NAMED_VALUE_FLOAT.fields).map((f) => f.name), ['time_boot_ms', 'value', 'name']);
  // extensions keep declaration order even though id(2) is wider than chunk_seq(1)
  assert.deepEqual(wireOrder(STATUSTEXT.fields).map((f) => f.name), ['severity', 'text', 'id', 'chunk_seq']);
});

test('HEARTBEAT payload matches pinned bytes (bit-31 custom_mode stays positive)', () => {
  const values = {
    type: 2, // MAV_TYPE_QUADROTOR
    autopilot: 3, // MAV_AUTOPILOT_ARDUPILOTMEGA
    base_mode: 128, // MAV_MODE_FLAG_SAFETY_ARMED
    custom_mode: 2147483648, // bit 31 set — negative under 1 << 31
    system_status: 4, // MAV_STATE_ACTIVE
    mavlink_version: 3,
  };
  const payload = writePayload(HEARTBEAT.fields, encodeMessage(HEARTBEAT, values, {}));
  assert.deepEqual([...payload], [0x00, 0x00, 0x00, 0x80, 0x02, 0x03, 0x80, 0x04, 0x03]);
  assert.deepEqual(decodeMessage(HEARTBEAT, readPayload(HEARTBEAT.fields, payload)), values);
});

test('SYSTEM_TIME payload matches pinned bytes (uint64 as decimal string)', () => {
  const values = {
    time_unix_usec: '72623859790382856', // 0x0102030405060708
    time_boot_ms: 305419896, // 0x12345678
  };
  const payload = writePayload(SYSTEM_TIME.fields, encodeMessage(SYSTEM_TIME, values, {}));
  assert.deepEqual([...payload], [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x78, 0x56, 0x34, 0x12]);
  const back = decodeMessage(SYSTEM_TIME, readPayload(SYSTEM_TIME.fields, payload));
  assert.equal(back.time_unix_usec, '72623859790382856');
  assert.equal(typeof back.time_unix_usec, 'string');
  assert.equal(back.time_boot_ms, 305419896);
});

test('NAMED_VALUE_FLOAT payload matches pinned bytes (float32 + char[10])', () => {
  const values = {
    time_boot_ms: 10,
    name: 'TESTVALUE1', // exactly 10 chars → no trailing NUL padding
    value: 1.0, // float32 0x3F800000
  };
  const payload = writePayload(NAMED_VALUE_FLOAT.fields, encodeMessage(NAMED_VALUE_FLOAT, values, {}));
  assert.deepEqual(
    [...payload],
    [0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x3f, 0x54, 0x45, 0x53, 0x54, 0x56, 0x41, 0x4c, 0x55, 0x45, 0x31],
  );
  assert.deepEqual(decodeMessage(NAMED_VALUE_FLOAT, readPayload(NAMED_VALUE_FLOAT.fields, payload)), values);
});

test('STATUSTEXT payload matches pinned bytes (char padding + extension order)', () => {
  const values = {
    severity: 2, // MAV_SEVERITY_CRITICAL
    text: 'Hello', // char[50] → "Hello" + 45 NULs (internal, not trailing payload)
    id: 258, // 0x0102
    chunk_seq: 5,
  };
  const expected = Buffer.concat([
    Buffer.from([0x02]),
    Buffer.from('Hello', 'latin1'),
    Buffer.alloc(45),
    Buffer.from([0x02, 0x01, 0x05]),
  ]);
  const payload = writePayload(STATUSTEXT.fields, encodeMessage(STATUSTEXT, values, {}));
  assert.equal(payload.length, 54);
  assert.deepEqual(payload, expected);
  assert.notEqual(payload[payload.length - 1], 0, 'last byte non-zero: v2 truncation is moot');
  assert.deepEqual(decodeMessage(STATUSTEXT, readPayload(STATUSTEXT.fields, payload)), values);
});
