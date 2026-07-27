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

test('a HEARTBEAT contradicting the bound profile emits profile-mismatch once', () => {
  const table = new PeerTable({ now: () => 0, profileAutopilot: 3 }); // ArduPilot profile
  const mismatches = [];
  table.on('profile-mismatch', (e) => mismatches.push({ declared: e.declared, profile: e.profile }));

  table.update(heartbeat({ type: 2, autopilot: 12, base_mode: 0 }), EP1); // PX4 heartbeat
  table.update(heartbeat({ type: 2, autopilot: 12, base_mode: 0 }), EP1); // again — no re-emit

  assert.deepEqual(mismatches, [{ declared: 12, profile: 3 }]);
  assert.equal(table.getComponent(1, 1).mismatch, true);
});

test('a GCS/companion heartbeat (autopilot INVALID) is not a mismatch', () => {
  const table = new PeerTable({ now: () => 0, profileAutopilot: 3 });
  let fired = false;
  table.on('profile-mismatch', () => {
    fired = true;
  });
  table.update(heartbeat({ type: 6, autopilot: 8, base_mode: 0 }), EP1); // MAV_AUTOPILOT_INVALID
  assert.equal(fired, false);
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
