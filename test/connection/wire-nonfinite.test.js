'use strict';

/**
 * Measurement pin (§14.55/14.56): Buffer.write*Int* and class-default ints
 * turn non-finite / omitted / blank values into 0 on the wire. The driver does
 * not invent a refusal for that silence (§0) — GIGO; the editor owns
 * completeness. This file pins the mechanism so it is not re-wrapped in a
 * helpful driver throw.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata');
const { createWire } = require('../../lib/connection/wire');
const { buildCommandInt, buildCommandLong } = require('../../lib/command/carrier');

const wire = createWire({ bundle: loadBundled('common') });

function localNed(fields) {
  return {
    name: 'SET_POSITION_TARGET_LOCAL_NED',
    fields: {
      time_boot_ms: 0,
      target_system: 1,
      target_component: 1,
      coordinate_frame: 1,
      type_mask: 3527,
      x: 0,
      y: 0,
      z: 0,
      ...fields,
    },
  };
}

const ctx = { sysid: 255, compid: 190, seq: 0 };

test('a NaN target_system serializes as 0 — Buffer does not refuse (§0 GIGO)', () => {
  const frame = wire.serialize(localNed({ target_system: NaN }), ctx);
  assert.equal(wire.decode(frame)[0].fields.target_system, 0);
});

test('a string target_system that coerces to NaN serializes as 0', () => {
  const frame = wire.serialize(localNed({ target_system: 'abc' }), ctx);
  assert.equal(wire.decode(frame)[0].fields.target_system, 0);
});

test('a numeric string target_system still serializes — Number("7") is finite', () => {
  const frame = wire.serialize(localNed({ target_system: '7' }), ctx);
  assert.equal(wire.decode(frame)[0].fields.target_system, 7);
});

test('an omitted integer field keeps the class default 0', () => {
  const { target_system: _drop, ...fields } = localNed({}).fields;
  const frame = wire.serialize({ name: 'SET_POSITION_TARGET_LOCAL_NED', fields }, ctx);
  assert.equal(wire.decode(frame)[0].fields.target_system, 0);
});

test('a present-but-blank integer field serializes as 0', () => {
  for (const blank of ['', '   ', null]) {
    const frame = wire.serialize(localNed({ target_system: blank }), ctx);
    assert.equal(wire.decode(frame)[0].fields.target_system, 0, `blank ${JSON.stringify(blank)}`);
  }
});

test('integer ARRAY fields still serialize', () => {
  const arr = (v) => Array.from({ length: 20 }, () => v);
  const frame = wire.serialize(
    {
      name: 'GPS_STATUS',
      fields: {
        satellites_visible: 5,
        satellite_prn: arr(1),
        satellite_used: arr(1),
        satellite_elevation: arr(45),
        satellite_azimuth: arr(90),
        satellite_snr: arr(30),
      },
    },
    ctx
  );
  assert.equal(wire.decode(frame)[0].fields.satellite_prn[0], 1);
});

test('omitted MAVLink 2 extension integers decode as 0 (§14.65)', () => {
  const frame = wire.serialize(
    { name: 'COMMAND_ACK', fields: { command: 400, result: 0 } },
    { sysid: 1, compid: 1, seq: 0 }
  );
  const decoded = wire.decode(frame)[0];
  assert.equal(decoded.fields.command, 400);
  assert.equal(decoded.fields.progress, 0);
  assert.equal(decoded.fields.result_param2, 0);
});

test('a char field with a non-numeric string is unchanged', () => {
  const frame = wire.serialize(
    { name: 'STATUSTEXT', fields: { severity: 1, text: 'abc' } },
    ctx
  );
  assert.equal(wire.decode(frame)[0].fields.text, 'abc');
});

test('a NaN float field still serializes — NaN floats are legal MAVLink', () => {
  const frame = wire.serialize(localNed({ x: NaN, y: NaN, z: NaN }), ctx);
  const decoded = wire.decode(frame)[0];
  assert.equal(decoded.fields.target_system, 1);
  assert.ok(Number.isNaN(decoded.fields.x));
});

test('COMMAND_INT: a garbage MAV_FRAME token becomes NaN on the bag and 0 on the wire', () => {
  const message = buildCommandInt(192, 1, 1, [0, 0, 0, 0, 47.398, 8.545, 10], { frame: 'garbage' });
  assert.ok(Number.isNaN(message.fields.frame), 'unresolved frame is NaN, not a guessed member');
  const frame = wire.serialize(message, ctx);
  assert.equal(wire.decode(frame)[0].fields.frame, 0);
});

test('COMMAND_LONG: frame carries no wire field — param5/6 stay raw decimal degrees', () => {
  const message = buildCommandLong(192, 1, 1, [0, 0, 0, 0, 47.398, 8.545, 10], 0);
  assert.equal('frame' in message.fields, false);
  assert.equal(message.fields.param5, 47.398);
  assert.equal(message.fields.param6, 8.545);
  assert.doesNotThrow(() => wire.serialize(message, ctx));
});
