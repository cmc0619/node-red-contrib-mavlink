'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PeerTable } = require('../../lib/connection/peer-table');
const { fakeClock } = require('./helpers');

const EP1 = { address: '10.0.0.5', port: 14550 };
const EP2 = { address: '10.0.0.5', port: 14551 };

/**
 * @param {object} fields
 * @param {number} [sysid]
 * @param {number} [compid]
 * @returns {object}
 */
function heartbeat(fields, sysid = 1, compid = 1) {
  return { name: 'HEARTBEAT', sysid, compid, fields };
}

test('HEARTBEAT populates presence, type, autopilot, armed state, and flight mode', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(
    heartbeat({
      type: 2, // MAV_TYPE_QUADROTOR
      autopilot: 3, // MAV_AUTOPILOT_ARDUPILOTMEGA
      base_mode: 128 + 1, // SAFETY_ARMED set
      custom_mode: 4,
      system_status: 4, // MAV_STATE_ACTIVE
    }),
    EP1
  );
  const component = table.getComponent(1, 1);
  assert.equal(component.type, 2);
  assert.equal(component.autopilot, 3);
  assert.equal(component.armed, true);
  assert.equal(component.flightMode, 4);
  assert.equal(component.systemStatus, 4);
});

test('a GCS-range sysid (>= 250) is tracked but its endpoint is never learned', () => {
  // 250–255 is the GCS range: a ground station is never a destination for
  // vehicle-directed traffic, so its frames enrich the record (a State node
  // can show it) while endpoint recording — and with it
  // endpointsForBroadcast eligibility — is refused.
  const table = new PeerTable({ now: () => 0 });
  table.update(heartbeat({ type: 6, autopilot: 8, base_mode: 0 }, 255, 190), EP1);
  table.update(heartbeat({ type: 6, autopilot: 8, base_mode: 0 }, 250, 190), EP2);
  assert.equal(table.size(), 2, 'GCS peers are still tracked');
  assert.equal(table.endpointFor(255, 190), null);
  assert.equal(table.endpointFor(250, 190), null);
  assert.deepEqual(table.endpointsForBroadcast(0), []);

  // A vehicle on the same endpoints is unaffected.
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }, 1, 1), EP1);
  assert.deepEqual(table.endpointFor(1, 1), EP1);
  assert.deepEqual(table.endpointsForBroadcast(1), [EP1]);
});

test('table is keyed by sysid with components nested underneath', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }, 1, 1), EP1);
  table.update(heartbeat({ type: 26, autopilot: 8, base_mode: 0 }, 1, 154), EP1); // gimbal
  assert.equal(table.size(), 1); // one system
  assert.ok(table.getComponent(1, 1));
  assert.ok(table.getComponent(1, 154));
});

test('armed reads false when the safety-armed bit is clear', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 1 }), EP1);
  assert.equal(table.getComponent(1, 1).armed, false);
});

test('freshness is per section, not per record', () => {
  const clock = fakeClock(0);
  const table = new PeerTable({ now: clock.now });
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP1, 0);
  clock.set(5000);
  table.update(
    { name: 'GLOBAL_POSITION_INT', sysid: 1, compid: 1, fields: { lat: 1, lon: 2, alt: 3 } },
    EP1,
    5000
  );
  const component = table.getComponent(1, 1);
  assert.equal(component.sections.heartbeat.lastSeen, 0);
  assert.equal(component.sections.position.lastSeen, 5000);
});

test('stale then expired transitions emit events', () => {
  const clock = fakeClock(0);
  const table = new PeerTable({ now: clock.now, heartbeatStaleMs: 5000, heartbeatExpireMs: 15000 });
  const events = [];
  table.on('stale', (e) => events.push(['stale', e.sysid]));
  table.on('expired', (e) => events.push(['expired', e.sysid]));

  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP1, 0);

  table.sweep(6000);
  assert.deepEqual(events, [['stale', 1]]);
  assert.equal(table.getComponent(1, 1).state, 'stale');

  table.sweep(16000);
  assert.deepEqual(events, [['stale', 1], ['expired', 1]]);
  assert.equal(table.getComponent(1, 1), undefined); // dropped
  assert.equal(table.size(), 0);
});

test('an explicit heartbeatStaleMs/ExpireMs of undefined still gets the built-in default (owner ruling, 2026-08-14)', () => {
  // The Connection's blank-config path passes `heartbeatStaleMs: undefined`
  // as an OWN property, not an omitted key — `{...DEFAULT_OPTIONS, ...options }`
  // would copy that `undefined` straight over the 5000/15000 default,
  // silently disabling staleness for every blank Stale/Expire field (the
  // most common deploy). This pins the `??` fix, not the truthy-key path
  // the two tests above already cover.
  const clock = fakeClock(0);
  const table = new PeerTable({ now: clock.now, heartbeatStaleMs: undefined, heartbeatExpireMs: undefined });
  const events = [];
  table.on('stale', (e) => events.push(['stale', e.sysid]));
  table.on('expired', (e) => events.push(['expired', e.sysid]));

  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP1, 0);
  table.sweep(6000);
  assert.deepEqual(events, [['stale', 1]], 'the 5000 ms default still applies');
  table.sweep(16000);
  assert.deepEqual(events, [['stale', 1], ['expired', 1]], 'the 15000 ms default still applies');
});

test('a fresh heartbeat clears a stale mark', () => {
  const table = new PeerTable({ now: () => 0, heartbeatStaleMs: 5000, heartbeatExpireMs: 15000 });
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP1, 0);
  table.sweep(6000);
  assert.equal(table.getComponent(1, 1).state, 'stale');
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP1, 7000);
  assert.equal(table.getComponent(1, 1).state, 'active');
});

test('a new endpoint on a known component surfaces the multi-endpoint condition', () => {
  const table = new PeerTable({ now: () => 0 });
  const added = [];
  const multi = [];
  table.on('endpoint-added', (e) => added.push(e.endpoint.port));
  table.on('multi-endpoint', (e) => multi.push(e.endpoints.length));

  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP1);
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP2);

  assert.deepEqual(added, [14550, 14551]);
  assert.deepEqual(multi, [2]);
  // Primary stays the first-seen endpoint.
  assert.deepEqual(table.endpointFor(1, 1), EP1);
});

test('markPrimaryFailed rotates the primary and emits primary-changed', () => {
  const table = new PeerTable({ now: () => 0 });
  const changes = [];
  table.on('primary-changed', (e) => changes.push(e.endpoint.port));

  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP1, 0);
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP2, 1);

  const next = table.markPrimaryFailed(1, 1);
  assert.deepEqual(next, EP2);
  assert.deepEqual(changes, [14551]);
  assert.deepEqual(table.endpointFor(1, 1), EP2);
});

test('markPrimaryFailed clears a sole failed endpoint', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP1, 0);
  assert.deepEqual(table.endpointFor(1, 1), EP1);

  const next = table.markPrimaryFailed(1, 1);
  assert.equal(next, null);
  assert.equal(table.endpointFor(1, 1), null);
  assert.equal(table.getComponent(1, 1).endpoints.size, 0);
});

test('markPrimaryFailed never reselects a previously failed endpoint', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP1, 0);
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP2, 1);

  assert.deepEqual(table.markPrimaryFailed(1, 1), EP2);
  assert.equal(table.getComponent(1, 1).endpoints.has('10.0.0.5:14550'), false);
  assert.equal(table.markPrimaryFailed(1, 1), null);
  assert.equal(table.endpointFor(1, 1), null);
  assert.equal(table.getComponent(1, 1).endpoints.size, 0);
});

test('snapshot projects position into canonical units, hdg sentinel to null', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(
    {
      name: 'GLOBAL_POSITION_INT',
      sysid: 1,
      compid: 1,
      fields: { lat: -353632621, lon: 1491652374, alt: 584000, relative_alt: 10000, hdg: 65535 },
    },
    EP1
  );
  assert.deepEqual(table.snapshot()[0].components[0].position, {
    lat: -35.3632621,
    lon: 149.1652374,
    alt: 584,
    relativeAlt: 10,
    heading: null,
  });
});

test('snapshot converts a real heading from centidegrees to degrees', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(
    {
      name: 'GLOBAL_POSITION_INT',
      sysid: 1,
      compid: 1,
      fields: { lat: 0, lon: 0, alt: 0, relative_alt: 0, hdg: 9000 },
    },
    EP1
  );
  assert.equal(table.snapshot()[0].components[0].position.heading, 90);
});

test('snapshot battery from SYS_STATUS: millivolts to volts, -1 remaining to null', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(
    { name: 'SYS_STATUS', sysid: 1, compid: 1, fields: { voltage_battery: 12600, battery_remaining: -1 } },
    EP1
  );
  assert.deepEqual(table.snapshot()[0].components[0].battery, {
    id: null,
    voltage: 12.6,
    remaining: null,
    current: null,
  });
});

test('snapshot battery from BATTERY_STATUS: id kept, centiamps to amps', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(
    {
      name: 'BATTERY_STATUS',
      sysid: 1,
      compid: 1,
      fields: { id: 0, battery_remaining: 55, current_battery: 1230 },
    },
    EP1
  );
  assert.deepEqual(table.snapshot()[0].components[0].battery, {
    id: 0,
    voltage: null,
    remaining: 55,
    current: 12.3,
  });
});

test('snapshot gps passes fix type through, satellite sentinel to null', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(
    { name: 'GPS_RAW_INT', sysid: 1, compid: 1, fields: { fix_type: 3, satellites_visible: 255 } },
    EP1
  );
  assert.deepEqual(table.snapshot()[0].components[0].gps, { fixType: 3, satellites: null });
  table.update(
    { name: 'GPS_RAW_INT', sysid: 1, compid: 1, fields: { fix_type: 4, satellites_visible: 11 } },
    EP1
  );
  assert.deepEqual(table.snapshot()[0].components[0].gps, { fixType: 4, satellites: 11 });
});

test('snapshot home converts degE7 to degrees and millimetres to metres', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(
    {
      name: 'HOME_POSITION',
      sysid: 1,
      compid: 1,
      fields: { latitude: -353632621, longitude: 1491652374, altitude: 584000 },
    },
    EP1
  );
  assert.deepEqual(table.snapshot()[0].components[0].home, {
    lat: -35.3632621,
    lon: 149.1652374,
    alt: 584,
  });
  // The help text tells flows to gate freshness on sections.* — home must
  // record an age like every other telemetry section.
  assert.equal(table.snapshot()[0].components[0].sections.home, 0);
});

test('a component that has only heartbeated snapshots null telemetry', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 0 }), EP1);
  const component = table.snapshot()[0].components[0];
  assert.equal(component.position, null);
  assert.equal(component.gps, null);
  assert.equal(component.battery, null);
  assert.equal(component.home, null);
});

test('projected sentinels match the seed dialect invalid markers', () => {
  const { loadBundled } = require('../../lib/metadata/bundled');
  const { messages } = loadBundled('common');
  const invalid = (msg, field) => messages[msg].fields.find((f) => f.name === field).invalid;
  assert.equal(invalid('GLOBAL_POSITION_INT', 'hdg'), 'UINT16_MAX');
  assert.equal(invalid('SYS_STATUS', 'voltage_battery'), 'UINT16_MAX');
  assert.equal(invalid('SYS_STATUS', 'battery_remaining'), '-1');
  assert.equal(invalid('GPS_RAW_INT', 'satellites_visible'), 'UINT8_MAX');
  assert.equal(invalid('BATTERY_STATUS', 'battery_remaining'), '-1');
  assert.equal(invalid('BATTERY_STATUS', 'current_battery'), '-1');
});

test('armed-changed fires on the armed bit flipping, not on first sight', () => {
  const table = new PeerTable({ now: () => 0 });
  const events = [];
  table.on('armed-changed', (e) => events.push(e));

  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 128 + 1, custom_mode: 4 }), EP1);
  assert.deepEqual(events, [], 'first observation is not a transition');
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 1, custom_mode: 4 }), EP1);
  assert.deepEqual(events, [{ sysid: 1, compid: 1, from: true, to: false }]);
});

test('mode-changed fires on a custom_mode change, not on first sight', () => {
  const table = new PeerTable({ now: () => 0 });
  const events = [];
  table.on('mode-changed', (e) => events.push(e));

  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 1, custom_mode: 0 }), EP1);
  assert.deepEqual(events, [], 'first observation is not a transition');
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 1, custom_mode: 4 }), EP1);
  assert.deepEqual(events, [{ sysid: 1, compid: 1, from: 0, to: 4 }]);
});

test('landed-changed fires on an EXTENDED_SYS_STATE landed_state change, with a section age', () => {
  const table = new PeerTable({ now: () => 0 });
  const events = [];
  table.on('landed-changed', (e) => events.push(e));

  const extState = (landed) => ({
    name: 'EXTENDED_SYS_STATE',
    sysid: 1,
    compid: 1,
    fields: { vtol_state: 0, landed_state: landed },
  });
  table.update(extState(1), EP1); // MAV_LANDED_STATE_ON_GROUND
  assert.deepEqual(events, [], 'first observation is not a transition');
  table.update(extState(2), EP1); // MAV_LANDED_STATE_IN_AIR
  assert.deepEqual(events, [{ sysid: 1, compid: 1, from: 1, to: 2 }]);
  assert.equal(table.getComponent(1, 1).sections.landed.lastSeen, 0);
});

test('gps-fix-changed fires on a fix_type change, not on first sight', () => {
  const table = new PeerTable({ now: () => 0 });
  const events = [];
  table.on('gps-fix-changed', (e) => events.push(e));

  table.update(
    { name: 'GPS_RAW_INT', sysid: 1, compid: 1, fields: { fix_type: 3, satellites_visible: 10 } },
    EP1
  );
  assert.deepEqual(events, [], 'first observation is not a transition');
  table.update(
    { name: 'GPS_RAW_INT', sysid: 1, compid: 1, fields: { fix_type: 4, satellites_visible: 10 } },
    EP1
  );
  assert.deepEqual(events, [{ sysid: 1, compid: 1, from: 3, to: 4 }]);
});

test('home-changed fires when home moves, in canonical units; a re-sent home is silent', () => {
  const table = new PeerTable({ now: () => 0 });
  const events = [];
  table.on('home-changed', (e) => events.push(e));

  const home = (lat) => ({
    name: 'HOME_POSITION',
    sysid: 1,
    compid: 1,
    fields: { latitude: lat, longitude: 1491652374, altitude: 584000 },
  });
  table.update(home(-353632621), EP1);
  assert.deepEqual(events, [], 'first observation is not a transition');
  table.update(home(-353632621), EP1);
  assert.deepEqual(events, [], 'an unchanged home is not a transition');
  table.update(home(-353632521), EP1);
  assert.deepEqual(events, [
    {
      sysid: 1,
      compid: 1,
      from: { lat: -35.3632621, lon: 149.1652374, alt: 584 },
      to: { lat: -35.3632521, lon: 149.1652374, alt: 584 },
    },
  ]);
});

test('sensor-health-changed carries from/to words and the flipped-bit mask', () => {
  const table = new PeerTable({ now: () => 0 });
  const events = [];
  table.on('sensor-health-changed', (e) => events.push(e));

  const sysStatus = (health) => ({
    name: 'SYS_STATUS',
    sysid: 1,
    compid: 1,
    fields: { onboard_control_sensors_health: health, voltage_battery: 12600, battery_remaining: 90 },
  });
  table.update(sysStatus(0x8000_0021), EP1);
  assert.deepEqual(events, [], 'first observation is not a transition');
  table.update(sysStatus(0x8000_0023), EP1);
  assert.deepEqual(events, [
    { sysid: 1, compid: 1, from: 0x8000_0021, to: 0x8000_0023, changed: 0x2 },
  ]);
});

test('snapshot is plain JSON-serializable data', () => {
  const table = new PeerTable({ now: () => 0 });
  table.update(heartbeat({ type: 2, autopilot: 3, base_mode: 128 }), EP1);
  const snap = table.snapshot();
  assert.doesNotThrow(() => JSON.stringify(snap));
  assert.equal(snap[0].sysid, 1);
  assert.equal(snap[0].components[0].armed, true);
  assert.equal(snap[0].components[0].endpoints[0].primary, true);
});

test('AVAILABLE_MODES entries are cached incrementally and the mode ladder reads them', () => {
  const { modeNameFor, setModeParams } = require('../../lib/vehicle/modes');
  const table = new PeerTable({ now: () => 0 });
  const events = [];
  for (const name of ['mode-changed', 'armed-changed']) table.on(name, (e) => events.push(e));

  // Two of 25 announced modes — the cache never waits for completeness, and
  // a re-sent index overwrites in place rather than duplicating.
  const frame = (fields) => ({ name: 'AVAILABLE_MODES', sysid: 1, compid: 1, fields });
  table.update(frame({
    number_modes: 25, mode_index: 5, standard_mode: 0, custom_mode: 4,
    properties: 0, mode_name: 'Guided\u0000\u0000',
  }), EP1);
  table.update(frame({
    number_modes: 25, mode_index: 6, standard_mode: 0, custom_mode: 6, properties: 0, mode_name: 'RTL',
  }), EP1);
  table.update(frame({
    number_modes: 25, mode_index: 5, standard_mode: 0, custom_mode: 4,
    properties: 0, mode_name: 'Guided',
  }), EP1);

  const component = table.getComponent(1, 1);
  assert.equal(component.modes.size, 2);
  assert.deepEqual(component.modes.get(5), {
    modeIndex: 5, numberModes: 25, standardMode: 0, customMode: 4, properties: 0, name: 'Guided',
  });
  assert.equal(modeNameFor(4, { component }), 'Guided');
  assert.deepEqual(setModeParams('rtl', { component, firmware: 'ardupilot' }), { 2: 6 });
  // A capability cache, not a transition source: no feed event fired.
  assert.deepEqual(events, []);
});
