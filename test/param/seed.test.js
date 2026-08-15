'use strict';

/**
 * The shipped parameter-definition seed lookup (`lib/param/seed.js`).
 *
 * Two properties matter here and neither is visible from the route tests:
 * which document a vehicle family selects, and what an unknown vehicle is
 * allowed to be told. Both were wrong once — Blimp's document shipped with no
 * family able to select it, and the union served another vehicle's bounds
 * under the name of the one in front of you (DESIGN.md §14).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { defsFor, catalogLabel } = require('../../lib/param/seed');
const { VEHICLE_FAMILIES } = require('../../lib/vehicle');

/* ---------- family → document ---------- */

test('every vehicle family except unknown selects its own document', () => {
  const union = defsFor({ firmware: 'ardupilot', vehicleFamily: 'unknown' });
  assert.ok(union.size > 0, 'the seed is readable');

  for (const family of VEHICLE_FAMILIES) {
    if (family === 'unknown') continue;
    const defs = defsFor({ firmware: 'ardupilot', vehicleFamily: family });
    assert.ok(defs.size > 0, `${family} resolves to definitions`);
    // A family with no ARDUPILOT_VEHICLE entry silently falls through to the
    // union. That is exactly how Blimp hid: shipped, counted, unreachable.
    assert.notEqual(
      defs.size,
      union.size,
      `${family} falls through to the union — it has no document mapping`
    );
  }
});

test('boat reads the Rover document, which is where ArduPilot ships boats', () => {
  const boat = defsFor({ firmware: 'ardupilot', vehicleFamily: 'boat' });
  const rover = defsFor({ firmware: 'ardupilot', vehicleFamily: 'rover' });
  assert.equal(boat.size, rover.size);
  assert.deepEqual([...boat.keys()].sort(), [...rover.keys()].sort());
});

test('blimp selects the Blimp document, not the union', () => {
  const blimp = defsFor({ firmware: 'ardupilot', vehicleFamily: 'blimp' });
  const union = defsFor({ firmware: 'ardupilot', vehicleFamily: 'unknown' });
  assert.ok(blimp.size < union.size, 'a single document is smaller than the union');
  // Copter-only, so its absence proves the Blimp document answered.
  assert.equal(blimp.has('ACRO_BAL_PITCH'), false);
});

/* ---------- what an unknown vehicle is told ---------- */

test('a named family keeps the bounds its own document documents', () => {
  const blimp = defsFor({ firmware: 'ardupilot', vehicleFamily: 'blimp' });
  const wp = blimp.get('WP_RADIUS');
  assert.ok(wp, 'WP_RADIUS is in the Blimp document');
  assert.equal(wp.min, 0.1);
  assert.equal(wp.max, 10);
});

test('the unknown-vehicle union carries names but never bounds or enumerations', () => {
  const union = defsFor({ firmware: 'ardupilot', vehicleFamily: 'unknown' });

  for (const [id, def] of union) {
    assert.equal(def.min, undefined, `${id} must not carry a union min`);
    assert.equal(def.max, undefined, `${id} must not carry a union max`);
    assert.equal(def.increment, undefined, `${id} must not carry a union increment`);
    assert.equal(def.values, undefined, `${id} must not carry a union enumeration`);
  }

  // WP_RADIUS is the measured case: Blimp documents 0.1–10 m, the union would
  // otherwise say 1–32767, so the editor refused a legal 0.5 and accepted 5000.
  const wp = union.get('WP_RADIUS');
  assert.ok(wp, 'the name is still offered');
  assert.ok(wp.description, 'and its description, which cannot refuse input');
});

test('an unrecognised family is treated as unknown, not as a guess', () => {
  const union = defsFor({ firmware: 'ardupilot', vehicleFamily: 'unknown' });
  for (const family of ['blimpish', '', undefined]) {
    const defs = defsFor({ firmware: 'ardupilot', vehicleFamily: family });
    assert.equal(defs.size, union.size);
  }
});

test('PX4 has one document, so a family never narrows it', () => {
  const plain = defsFor({ firmware: 'px4' });
  assert.ok(plain.size > 0);
  for (const family of ['copter', 'plane', 'unknown']) {
    assert.equal(defsFor({ firmware: 'px4', vehicleFamily: family }).size, plain.size);
  }
  // And it keeps its bounds: one document is never a union.
  assert.equal(plain.get('RC1_MIN').max, 1500);
});

/* ---------- published parameter type ---------- */

test('PX4 definitions carry the type PX4 publishes, as a MAV_PARAM_TYPE', () => {
  const px4 = defsFor({ firmware: 'px4' });
  let typed = 0;
  for (const [id, def] of px4) {
    if (!def.type) continue;
    typed++;
    assert.match(def.type, /^MAV_PARAM_TYPE_(REAL32|INT32)$/, `${id} uses the MAVLink spelling`);
  }
  // Upstream states one for every parameter; dropping any is data thrown away.
  assert.equal(typed, px4.size);
  assert.equal(px4.get('RC1_MIN').type, 'MAV_PARAM_TYPE_REAL32');
});

test('ArduPilot definitions carry no type, because upstream publishes none', () => {
  // apm.pdef.json and apm.pdef.xml publish Description, DisplayName, Units,
  // Range, Increment, Values, Bitmask, ReadOnly, RebootRequired, Calibration,
  // Volatile and User — and no wire type. Inferring one from Values/Bitmask
  // would pre-fill the exact mistake DESIGN.md §14 measured.
  const copter = defsFor({ firmware: 'ardupilot', vehicleFamily: 'copter' });
  for (const [id, def] of copter) {
    assert.equal(def.type, undefined, `${id} must not carry an invented type`);
  }
});

test('the unknown-vehicle union carries no type either', () => {
  // Nothing to conflict today, since no ArduPilot document publishes one — but
  // a type is what the value is encoded as on the wire, and a union cannot
  // vouch for a field that acts.
  for (const [id, def] of defsFor({ firmware: 'ardupilot', vehicleFamily: 'unknown' })) {
    assert.equal(def.type, undefined, `${id} must not carry a union type`);
  }
});

test('a named vehicle serves bits; the unknown-vehicle union strips them (Codex, #296)', () => {
  // Bits act — the editor renders switches from them and folds masks — so the
  // union cannot serve whichever document was enumerated first: wrong labels
  // set wrong flags with the confidence of a wrong enumeration.
  const copter = defsFor({ firmware: 'ardupilot', vehicleFamily: 'copter' });
  assert.ok(Array.isArray(copter.get('LOG_BITMASK').bits), 'the per-vehicle document keeps bits');
  for (const [id, def] of defsFor({ firmware: 'ardupilot', vehicleFamily: 'unknown' })) {
    assert.equal(def.bits, undefined, `${id} must not carry union bits`);
  }
});

test('catalogLabel names the definition set the operator is actually looking at', () => {
  // The case this exists for: a Connection named "PX4" bound to a profile set
  // to ArduPilot serves ArduPilot definitions, and every symptom — an unknown
  // parameter, a Type field that will not narrow — points somewhere else.
  assert.equal(
    catalogLabel({ firmware: 'px4', vehicleFamily: 'copter', count: 1836, source: 'seed' }),
    'PX4 · 1836 definitions (shipped seed)'
  );
  // The family is named only for ArduPilot, because only ArduPilot has a
  // document per vehicle; printing it for PX4 would imply a distinction
  // defsFor never makes.
  assert.equal(
    catalogLabel({ firmware: 'px4', vehicleFamily: 'plane', count: 1836 }),
    'PX4 · 1836 definitions (shipped seed)'
  );
  assert.equal(
    catalogLabel({ firmware: 'ardupilot', vehicleFamily: 'copter', count: 5719, source: 'seed' }),
    'ArduPilot Copter · 5719 definitions (shipped seed)'
  );

  // No named vehicle just goes unnamed: a blank, unknown, or unrecognised family
  // gets the union catalog and the label says nothing about a vehicle (the red
  // ring, not this label, is where a bad config shows). Gated on the same
  // ARDUPILOT_VEHICLE map defsFor serves from, so 'drone' reads the same as
  // blank rather than mislabelling as a named vehicle.
  for (const family of ['unknown', '', undefined, 'drone']) {
    assert.equal(
      catalogLabel({ firmware: 'ardupilot', vehicleFamily: family, count: 6827 }),
      'ArduPilot · 6827 definitions (shipped seed)',
      `family ${JSON.stringify(family)}`
    );
  }

  // A profile's own download outranks the seed, and says so.
  assert.equal(
    catalogLabel({ firmware: 'ardupilot', vehicleFamily: 'blimp', count: 3127, source: 'profile' }),
    'ArduPilot Blimp · 3127 definitions (downloaded for this profile)'
  );

  assert.equal(catalogLabel({ firmware: 'custom', count: 1 }), 'Custom · 1 definition (shipped seed)');
  assert.match(catalogLabel({ firmware: '', count: 0 }), /^Unknown firmware · 0 definitions/);
});

test('catalogLabel counts agree with what defsFor actually serves', () => {
  // A label is worse than none if the number in it is not the number of
  // definitions in play, so it is taken from the served map, never restated.
  for (const target of [
    { firmware: 'px4', vehicleFamily: 'copter' },
    { firmware: 'ardupilot', vehicleFamily: 'copter' },
    { firmware: 'ardupilot', vehicleFamily: 'unknown' },
  ]) {
    const served = defsFor(target);
    assert.match(
      catalogLabel({ ...target, count: served.size }),
      new RegExp(`· ${served.size} `),
      JSON.stringify(target)
    );
  }
});
