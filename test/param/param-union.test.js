'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { paramValueToWire, paramValueFromWire } = require('../../lib/codec/param-union');

const INT32 = 6;
const UINT32 = 5;
const INT16 = 4;
const UINT8 = 1;
const REAL32 = 9;

test('PX4 int/float union reinterprets bits, never casts numerically', () => {
  // 20 as int32 has bit pattern 0x00000014. Read as float32 that is ~2.8e-44,
  // NOT 20.0. A numeric cast (writeFloatLE(20)) would produce 20.0 and corrupt
  // the parameter on the vehicle.
  const wire = paramValueToWire(20, INT32);
  assert.notEqual(wire, 20);
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(20, 0);
  assert.equal(wire, buf.readFloatLE(0));
  assert.equal(paramValueFromWire(wire, INT32), 20);
});

test('int params round-trip across widths and signs', () => {
  const cases = [
    [INT32, -2147483648],
    [INT32, 2147483647],
    [UINT32, 4294967295],
    [INT16, -1],
    [UINT8, 200],
  ];
  for (const [type, value] of cases) {
    const wire = paramValueToWire(value, type);
    assert.equal(paramValueFromWire(wire, type), value, `round-trip ${value} as type ${type}`);
  }
});

test('REAL32 passes through as a genuine float (no reinterpret)', () => {
  assert.equal(paramValueToWire(3.5, REAL32), 3.5);
  assert.equal(paramValueFromWire(3.5, REAL32), 3.5);
  assert.equal(paramValueToWire(3.5, 9), 3.5);
});

test('a corrupt int-vs-cast mistake is observable end to end', () => {
  // The whole point: reinterpret and cast disagree for the same input.
  const value = 100;
  const reinterpret = paramValueToWire(value, INT32);
  const numericCast = 100; // what writeFloatLE(100) would store
  assert.notEqual(reinterpret, numericCast);
  assert.equal(paramValueFromWire(reinterpret, INT32), 100);
});
