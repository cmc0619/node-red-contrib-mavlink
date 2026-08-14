'use strict';

/**
 * Non-finite integer fields must refuse at the wire boundary. Buffer's
 * write*Int* range checks pass NaN/Infinity through as 0 (measured, §14), so
 * without this guard a NaN target_system — the honest output of an unresolved
 * Build-tier target ladder — serializes as 0 and every vehicle on the link
 * treats the setpoint as broadcast-addressed to it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata');
const { createWire } = require('../../lib/connection/wire');

const wire = createWire({ bundle: loadBundled('common') });


test('a NaN float field still serializes — NaN floats are legal MAVLink', () => {
  // SET_POSITION_TARGET floats use NaN as "no value" in ecosystem practice;
  // only integer fields get the finite guard.
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

