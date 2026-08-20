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
const { buildCommandInt, buildCommandLong } = require('../../lib/command/carrier');

const wire = createWire({ bundle: loadBundled('common') });


test('a string target_system that coerces to NaN refuses, not just a bare NaN', () => {
  // The typeof hole: 'abc' is not `typeof value === 'number'`, but it still
  // hits the same Buffer write*Int* coercion-to-0 as a bare NaN.
  assert.throws(
    () => wire.serialize(
      {
        name: 'SET_POSITION_TARGET_LOCAL_NED',
        fields: {
          time_boot_ms: 0, target_system: 'abc', target_component: 1,
          coordinate_frame: 1, type_mask: 3527, x: 0, y: 0, z: 0,
        },
      },
      { sysid: 255, compid: 190, seq: 0 }
    ),
    /must be finite/
  );
});

test('a numeric string target_system still serializes — Number("7") is finite', () => {
  const frame = wire.serialize(
    {
      name: 'SET_POSITION_TARGET_LOCAL_NED',
      fields: {
        time_boot_ms: 0, target_system: '7', target_component: 1,
        coordinate_frame: 1, type_mask: 3527, x: 0, y: 0, z: 0,
      },
    },
    { sysid: 255, compid: 190, seq: 0 }
  );
  const decoded = wire.decode(frame)[0];
  assert.equal(decoded.fields.target_system, 7);
});

test('integer ARRAY fields are exempt from the finite guard — Number([..]) is NaN by accident', () => {
  // The #305 regression this pins: the guard applied Number() to array values,
  // and Number([1,1]) is NaN, so GPS_STATUS's legitimate uint8[20]s refused.
  // Arrays are skipped outright — the guard's subject is the single-value
  // target-id class, not per-element vetting.
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

test('an omitted integer field refuses — class default 0 is poisoned before assign', () => {
  // Closest Node analogue of pymavlink refusing None: paint ints NaN at init so
  // an absent key cannot ride Buffer's silent 0 (§14). Other core ints are
  // present so the throw names the omitted one.
  assert.throws(
    () => wire.serialize(
      {
        name: 'SET_POSITION_TARGET_LOCAL_NED',
        fields: {
          time_boot_ms: 0, target_component: 1, coordinate_frame: 1,
          type_mask: 3527, x: 0, y: 0, z: 0,
        },
      },
      { sysid: 255, compid: 190, seq: 0 }
    ),
    /field 'target_system' is NaN; an integer field must be finite/
  );
});

test('omitted MAVLink 2 extension integers stay class 0 — not poisoned (§14.65)', () => {
  // COMMAND_ACK progress/result_param2/targets are extensions. Trailing
  // truncation means "absent" is 0 on the wire; poison would break partial acks.
  const frame = wire.serialize(
    { name: 'COMMAND_ACK', fields: { command: 400, result: 0 } },
    { sysid: 1, compid: 1, seq: 0 }
  );
  const decoded = wire.decode(frame)[0];
  assert.equal(decoded.fields.command, 400);
  assert.equal(decoded.fields.progress, 0);
  assert.equal(decoded.fields.result_param2, 0);
});

test('a present-but-blank integer field refuses — Number("") and Number(null) are a finite 0', () => {
  for (const blank of ['', '   ', null]) {
    assert.throws(
      () => wire.serialize(
        {
          name: 'SET_POSITION_TARGET_LOCAL_NED',
          fields: {
            time_boot_ms: 0, target_system: blank, target_component: 1,
            coordinate_frame: 1, type_mask: 3527, x: 0, y: 0, z: 0,
          },
        },
        { sysid: 255, compid: 190, seq: 0 }
      ),
      /is blank; an integer field must be finite/,
      `blank ${JSON.stringify(blank)} must refuse`
    );
  }
});

test('a char field with a non-numeric string is exempt from the finite guard', () => {
  const frame = wire.serialize(
    { name: 'STATUSTEXT', fields: { severity: 1, text: 'abc' } },
    { sysid: 255, compid: 190, seq: 0 }
  );
  assert.equal(wire.decode(frame)[0].fields.text, 'abc');
});

test('a NaN float field still serializes — NaN floats are legal MAVLink', () => {
  // SET_POSITION_TARGET floats use NaN as "no value" in ecosystem practice;
  // only integer fields get the finite guard.
  const frame = wire.serialize(
    {
      name: 'SET_POSITION_TARGET_LOCAL_NED',
      fields: {
        time_boot_ms: 0, target_system: 1, target_component: 1,
        coordinate_frame: 1, type_mask: 3527, x: NaN, y: NaN, z: NaN,
      },
    },
    { sysid: 255, compid: 190, seq: 0 }
  );
  const decoded = wire.decode(frame)[0];
  assert.equal(decoded.fields.target_system, 1);
  assert.ok(Number.isNaN(decoded.fields.x));
});

// ── A garbage MAV_CMD carrier frame (owner ruling, 2026-08-14 site probe) ───
// `resolveFrame`/`longToIntFields` coerce a non-member frame token to NaN
// (there is no member to fall back to); this pins that the *existing* guard
// above — not a new one — is what stops it reaching the wire.

test('COMMAND_INT: a garbage MAV_FRAME token becomes a NaN frame field and refuses here, at the wire boundary', () => {
  // buildCommandInt/longToIntFields do not validate `frame` against the
  // MAV_FRAME set (§14, DEFAULT_FRAME's own doc: "not a safety net"); an
  // unrecognised token coerces to NaN via Number(), same as any other
  // unresolved integer field, and this guard is the one choke point that
  // catches it — no second check belongs in lib/command/carrier.js.
  const message = buildCommandInt(192, 1, 1, [0, 0, 0, 0, 47.398, 8.545, 10], { frame: 'garbage' });
  assert.ok(Number.isNaN(message.fields.frame), 'the unresolved frame token coerces to NaN, not a guessed member');
  assert.throws(
    () => wire.serialize(message, { sysid: 255, compid: 190, seq: 0 }),
    /field 'frame' is NaN; an integer field must be finite/
  );
});

test('COMMAND_LONG: frame carries no wire field, so it never gates scaling — param5/6 stay raw decimal degrees regardless', () => {
  // COMMAND_LONG has no int32 x/y to scale in the first place (§9: params are
  // always decimal degrees on this carrier) — there is no live "skip
  // scaling" path for a garbage frame to hide behind here, unlike COMMAND_INT
  // above. Confirms the site probe found nothing to refuse on this half.
  const message = buildCommandLong(192, 1, 1, [0, 0, 0, 0, 47.398, 8.545, 10], 0);
  assert.equal('frame' in message.fields, false);
  assert.equal(message.fields.param5, 47.398);
  assert.equal(message.fields.param6, 8.545);
  assert.doesNotThrow(() => wire.serialize(message, { sysid: 255, compid: 190, seq: 0 }));
});

