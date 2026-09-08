'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { PeerTable } = require('../../lib/connection/peer-table');
const { snapshotPeers, createStateFeed } = require('../../lib/state');

test('snapshotPeers returns a filtered deep-copy snapshot from the peer table', () => {
  const table = {
    snapshot() {
      return [
        { sysid: 1, components: [{ compid: 1, armed: true }] },
        { sysid: 2, components: [{ compid: 1, armed: false }, { compid: 154, armed: null }] },
      ];
    },
  };

  const snap = snapshotPeers(table, { sysid: 2, compid: 154 });
  assert.deepEqual(snap, [{ sysid: 2, components: [{ compid: 154, armed: null }] }]);
  snap[0].components[0].armed = true;
  assert.equal(table.snapshot()[1].components[1].armed, null);
});

test('snapshotPeers preserves NaN values from peer state', () => {
  const table = {
    snapshot() {
      return [{ sysid: 1, components: [{ compid: 1, heading: NaN }] }];
    },
  };

  const snap = snapshotPeers(table);

  assert.equal(Number.isNaN(snap[0].components[0].heading), true);
});

test('snapshotPeers projects AUTOPILOT_VERSION into standard semver and opaque IDs', () => {
  const table = new PeerTable({ now: () => 0 });
  const customVersion = [0x00, 0x01, 0x0f, 0x80, 0xaa, 0xbb, 0xcc, 0xdd];
  table.update(
    {
      name: 'AUTOPILOT_VERSION',
      sysid: 1,
      compid: 1,
      fields: {
        capabilities: 0x100000000n,
        flight_sw_version: 0x07040280,
        board_version: 0x12345678,
        flight_custom_version: customVersion,
        vendor_id: 0x1234,
        product_id: 0x5678,
      },
    },
    { address: '10.0.0.5', port: 14550 }
  );

  const snap = snapshotPeers(table);
  assert.deepEqual(snap[0].components[0].autopilotVersion, {
    flightSwVersion: 0x07040280,
    boardVersion: 0x12345678,
    capabilities: '4294967296',
    softwareVersion: { major: 7, minor: 4, patch: 2, releaseType: 128 },
    flightCustomVersion: '00010f80aabbccdd',
    vendorId: 0x1234,
    productId: 0x5678,
  });
  assert.deepEqual(table.getComponent(1, 1).autopilotVersion, {
    flightSwVersion: 0x07040280,
    boardVersion: 0x12345678,
    capabilities: 0x100000000n,
    flightCustomVersion: customVersion,
    vendorId: 0x1234,
    productId: 0x5678,
  });
  assert.doesNotThrow(() => JSON.stringify(snap));
  assert.equal('vendorName' in snap[0].components[0].autopilotVersion, false);
  assert.equal('productName' in snap[0].components[0].autopilotVersion, false);
});

test('State feed emits transition records and live statustext records', () => {
  const table = new EventEmitter();
  const records = [];
  const feed = createStateFeed(table, { events: ['stale', 'expired', 'statustext'] }, (record) => {
    records.push(record);
  });

  table.emit('stale', { sysid: 1, compid: 1 });
  table.emit('primary-changed', { sysid: 1, compid: 1 });
  table.emit('statustext', { sysid: 1, compid: 1, text: 'EKF OK', severity: 6 });
  feed.close();
  table.emit('expired', { sysid: 1, compid: 1 });

  assert.deepEqual(
    records.map((r) => [r.kind, r.event, r.sysid, r.text]),
    [
      ['transition', 'stale', 1, undefined],
      ['statustext', 'statustext', 1, 'EKF OK'],
    ]
  );
});

test('State feed delivers a selected flight-dynamic transition and filters an unselected one', () => {
  const table = new EventEmitter();
  const records = [];
  const feed = createStateFeed(table, { events: ['armed-changed'] }, (record) => {
    records.push(record);
  });

  table.emit('armed-changed', { sysid: 1, compid: 1, from: false, to: true });
  table.emit('mode-changed', { sysid: 1, compid: 1, from: 0, to: 4 });
  feed.close();

  assert.deepEqual(
    records.map((r) => [r.kind, r.event, r.sysid, r.compid, r.from, r.to]),
    [['transition', 'armed-changed', 1, 1, false, true]]
  );
});
