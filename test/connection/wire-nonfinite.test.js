'use strict';

/**
 * Non-finite integer fields ride. node-mavlink's Buffer write*Int* path
 * serializes NaN/Infinity as 0 (measured, §14). That is the library, not a
 * reason for a driver check — AGENTS.md §9 "A repro is not a ruling."
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata');
const { createWire } = require('../../lib/connection/wire');
const { buildCommandInt, buildCommandLong } = require('../../lib/command/carrier');

const wire = createWire({ bundle: loadBundled('common') });

test('a string target_system that coerces to NaN serializes — node-mavlink writes 0', () => {
  const frame = wire.serialize(
    {
      name: 'SET_POSITION_TARGET_LOCAL_NED',
      fields: { target_system: 'abc', target_component: 1, coordinate_frame: 1, type_mask: 3527, x: 0, y: 0, z: 0 },
    },
    { sysid: 255, compid: 190, seq: 0 }
  );
  assert.equal(wire.decode(frame)[0].fields.target_system, 0);
});

test('a numeric string target_system still serializes — Number("7") is finite', () => {
  const frame = wire.serialize(
    {
      name: 'SET_POSITION_TARGET_LOCAL_NED',
      fields: { target_system: '7', target_component: 1, coordinate_frame: 1, type_mask: 3527, x: 0, y: 0, z: 0 },
    },
    { sysid: 255, compid: 190, seq: 0 }
  );
  const decoded = wire.decode(frame)[0];
  assert.equal(decoded.fields.target_system, 7);
});

test('integer ARRAY fields serialize — GPS_STATUS uint8[20]s are legitimate', () => {
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
    { sysid: 255, compid: 190, seq: 0 }
  );
  assert.equal(wire.decode(frame)[0].fields.satellite_prn[0], 1);
});

test('a char field with a non-numeric string serializes', () => {
  const frame = wire.serialize(
    { name: 'STATUSTEXT', fields: { severity: 1, text: 'abc' } },
    { sysid: 255, compid: 190, seq: 0 }
  );
  assert.equal(wire.decode(frame)[0].fields.text, 'abc');
});

test('a NaN float field still serializes — NaN floats are legal MAVLink', () => {
  const frame = wire.serialize(
    {
      name: 'SET_POSITION_TARGET_LOCAL_NED',
      fields: { target_system: 1, target_component: 1, coordinate_frame: 1, type_mask: 3527, x: NaN, y: NaN, z: NaN },
    },
    { sysid: 255, compid: 190, seq: 0 }
  );
  const decoded = wire.decode(frame)[0];
  assert.equal(decoded.fields.target_system, 1);
  assert.ok(Number.isNaN(decoded.fields.x));
});

test('COMMAND_INT: a garbage MAV_FRAME token becomes a NaN frame field and rides', () => {
  const message = buildCommandInt(192, 1, 1, [0, 0, 0, 0, 47.398, 8.545, 10], { frame: 'garbage' });
  assert.ok(Number.isNaN(message.fields.frame), 'the unresolved frame token coerces to NaN, not a guessed member');
  const frame = wire.serialize(message, { sysid: 255, compid: 190, seq: 0 });
  assert.equal(wire.decode(frame)[0].fields.frame, 0);
});

test('COMMAND_LONG: frame carries no wire field, so param5/6 stay raw decimal degrees', () => {
  const message = buildCommandLong(192, 1, 1, [0, 0, 0, 0, 47.398, 8.545, 10], 0);
  assert.equal('frame' in message.fields, false);
  assert.equal(message.fields.param5, 47.398);
  assert.equal(message.fields.param6, 8.545);
  assert.doesNotThrow(() => wire.serialize(message, { sysid: 255, compid: 190, seq: 0 }));
});
