'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { encodeField, decodeField, FieldCodecError } = require('..');
const { field, expectFieldError } = require('./helpers');

/**
 * Compare two floats at float32 precision, NaN-aware. A raw `===` blesses a
 * symmetric codec bug and fails on legitimate float32 rounding; NaN !== NaN
 * would fail on the "keep current" sentinel that must survive losslessly.
 */
function float32Equal(a, b) {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(a, 0);
  const na = buf.readFloatLE(0);
  buf.writeFloatLE(b, 0);
  const nb = buf.readFloatLE(0);
  return Object.is(na, nb);
}

test('integer round-trips across every width', () => {
  const cases = [
    ['uint8_t', 255, 0],
    ['int8_t', -128, 127],
    ['uint16_t', 65535, 0],
    ['int16_t', -32768, 32767],
    ['uint32_t', 4294967295, 0],
    ['int32_t', -2147483648, 2147483647],
  ];
  for (const [type, lo, hi] of cases) {
    for (const value of [lo, hi]) {
      const f = field({ name: type, type });
      const wire = encodeField(f, value);
      assert.equal(typeof wire, 'number');
      assert.equal(decodeField(f, wire), value);
    }
  }
});

test('numeric strings are accepted for integers; non-integer strings rejected', () => {
  const f = field({ type: 'uint16_t' });
  assert.equal(encodeField(f, '4096'), 4096);
  assert.equal(encodeField(f, '  42  '), 42);
  assert.throws(() => encodeField(f, '4.5'), FieldCodecError);
  assert.throws(() => encodeField(f, '0x10'), FieldCodecError);
});

test('non-integer numbers are rejected (Buffer would silently truncate 4.5 → 4)', () => {
  const f = field({ name: 'count', type: 'uint8_t' });
  const err = expectFieldError(() => encodeField(f, 4.5), FieldCodecError, 'count');
  assert.match(err.message, /truncate/);
});

test('float round-trips NaN-aware at float32 precision', () => {
  const f = field({ type: 'float' });
  for (const value of [0, 1.5, -3.25, 3.14159, 1e30, -1e30, Infinity, -Infinity, NaN]) {
    const wire = encodeField(f, value);
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(wire, 0);
    const roundTripped = decodeField(f, buf.readFloatLE(0));
    assert.ok(float32Equal(value, roundTripped), `float32 round-trip for ${value}`);
  }
});

test('double preserves full precision', () => {
  const f = field({ type: 'double' });
  const value = 3.141592653589793;
  assert.equal(decodeField(f, encodeField(f, value)), value);
});

test('NaN survives losslessly and is never routed through JSON', () => {
  const f = field({ type: 'float', invalid: 'NaN' });
  const wire = encodeField(f, NaN);
  assert.ok(Number.isNaN(wire));
  // JSON.stringify would turn NaN into null — the failure mode §5 warns about.
  assert.equal(JSON.stringify(wire), 'null');
  assert.ok(Number.isNaN(decodeField(f, wire)));
  assert.ok(Number.isNaN(encodeField(f, 'NaN')));
});

test('floats are not range-checked, integers are (declared min/max)', () => {
  const floatField = field({ type: 'float', minValue: 0, maxValue: 1 });
  assert.equal(encodeField(floatField, 1e9), 1e9); // float ignores declared range

  const intField = field({ name: 'throttle', type: 'uint8_t', minValue: 0, maxValue: 100 });
  assert.equal(encodeField(intField, 100), 100);
  const err = expectFieldError(() => encodeField(intField, 200), FieldCodecError, 'throttle');
  assert.match(err.message, /maximum 100/);
  assert.throws(() => encodeField(intField, -1), FieldCodecError);
});

test('silent-danger inputs are rejected, naming the field', () => {
  const f = field({ name: 'target', type: 'uint8_t' });
  for (const bad of [undefined, null, '', '   ', 'abc', {}, true]) {
    expectFieldError(() => encodeField(f, bad), FieldCodecError, 'target');
  }
});

test('64-bit integers travel as decimal strings on the JS side, BigInt on the wire', () => {
  const f = field({ name: 'time_usec', type: 'uint64_t' });
  const big = '18446744073709551615'; // 2^64 - 1
  const wire = encodeField(f, big);
  assert.equal(typeof wire, 'bigint');
  assert.equal(wire, 18446744073709551615n);
  assert.equal(decodeField(f, wire), big);

  // A raw Number above 2^53 cannot be exact — must be given as a string.
  assert.throws(() => encodeField(f, Number(big)), FieldCodecError);
  // Small safe integers are still accepted as Numbers.
  assert.equal(encodeField(f, 42), 42n);
});

test('int64 handles negative decimal strings', () => {
  const f = field({ type: 'int64_t' });
  assert.equal(encodeField(f, '-9223372036854775808'), -9223372036854775808n);
  assert.equal(decodeField(f, -9223372036854775808n), '-9223372036854775808');
});

test('degE7 fields are raw int32 wire values — no unit conversion either direction (§9)', () => {
  // The codec is the raw surface (mavlink-build): a field labelled degE7
  // takes degE7, exactly like pymavlink's generated *_send, node-mavlink's
  // classes, and MAVSDK's passthrough. Degree scaling lives only in the
  // typed operator surfaces (command/swarm/payload/mission builders).
  const f = field({ name: 'lat', type: 'int32_t', units: 'degE7' });
  assert.equal(encodeField(f, 473977420), 473977420);
  assert.equal(encodeField(f, -350000000), -350000000);
  assert.equal(encodeField(f, '473977420'), 473977420);
  assert.equal(decodeField(f, 473977420), 473977420);

  // This is what makes mavlink-in → mavlink-build compose: mavlink-in emits
  // raw wire fields, and Build must accept them unchanged.
  const fromMavlinkIn = 473977420;
  assert.equal(encodeField(f, fromMavlinkIn), fromMavlinkIn);
});

test('degE7 sentinels pass through untouched — INT32_MAX and INT32_MIN alike', () => {
  // ADSB_VEHICLE.lat's declared invalid (INT32_MAX) and CAMERA_FOV_STATUS.
  // lat_image's description-only "at infinity" (INT32_MIN) are both plain
  // int32 values on a raw surface; forwarding a decoded frame reproduces
  // them exactly, with no sentinel special-casing to get wrong.
  const f = field({ name: 'lat_image', type: 'int32_t', units: 'degE7', invalid: 'INT32_MAX' });
  assert.equal(encodeField(f, 2147483647), 2147483647);
  assert.equal(encodeField(f, -2147483648), -2147483648);
  assert.equal(decodeField(f, 2147483647), 2147483647);
  assert.equal(decodeField(f, -2147483648), -2147483648);
});

test('a degrees-looking decimal in a degE7 field fails loud and names the unit', () => {
  // The one degE7-specific behavior: the likeliest operator mistake — typing
  // degrees into a raw field — gets an error stating the unit and the fix,
  // not a generic non-integer rejection. Blank/null keep the standard §5
  // rejection: no silent zero, no sentinel guessing.
  const f = field({ name: 'lat', type: 'int32_t', units: 'degE7' });
  assert.throws(() => encodeField(f, 47.397742), FieldCodecError);
  assert.throws(() => encodeField(f, 47.397742), /degrees × 1e7 as an integer/);
  assert.throws(() => encodeField(f, '-35.5'), /degrees × 1e7 as an integer/);
  assert.throws(() => encodeField(f, null), FieldCodecError);
  assert.throws(() => encodeField(f, NaN), FieldCodecError);
});

test('char[] is Latin-1, padded or truncated to declared length', () => {
  const f = field({ name: 'name', type: 'char', arrayLength: 6 });
  assert.equal(encodeField(f, 'AB'), 'AB\u0000\u0000\u0000\u0000'); // padded
  assert.equal(encodeField(f, 'ABCDEFGH'), 'ABCDEF'); // truncated
  assert.equal(encodeField(f, ''), '\u0000\u0000\u0000\u0000\u0000\u0000'); // empty is valid
  assert.equal(encodeField(f, 'caf\u00e9').length, 6); // é is Latin-1 (233)
  assert.throws(() => encodeField(f, '\u20ac'), FieldCodecError); // € is not
});

test('char[] decode strips trailing NULs and accepts a Buffer', () => {
  const f = field({ name: 'name', type: 'char', arrayLength: 6 });
  assert.equal(decodeField(f, 'AB\u0000\u0000\u0000\u0000'), 'AB');
  assert.equal(decodeField(f, Buffer.from('Hi\u0000\u0000\u0000\u0000', 'latin1')), 'Hi');
});

test('numeric arrays encode element-wise and zero-pad short arrays', () => {
  const f = field({ name: 'v', type: 'uint16_t', arrayLength: 4 });
  assert.deepEqual(encodeField(f, [1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(encodeField(f, [1, 2]), [1, 2, 0, 0]);
  assert.throws(() => encodeField(f, [1, 2, 3, 4, 5]), FieldCodecError); // too many
  assert.throws(() => encodeField(f, [1, 4.5, 3]), FieldCodecError); // bad element
  assert.deepEqual(decodeField(f, [1, 2, 0, 0]), [1, 2, 0, 0]);
});
