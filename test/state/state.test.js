'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

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
