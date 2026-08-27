'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-local-identity converts heartbeatIntervalMs as saved', () => {
  const RED = redStub();
  require('../../nodes/mavlink-local-identity')(RED);
  const Node = RED.nodes.types['mavlink-local-identity'];

  // The editor owns the 1000 default and reds blank (positiveNumberValidator,
  // mavlink-local-identity.html), so the runtime sees only a saved positive
  // number and just converts it — no second default here (§0). Identity
  // fields carry the editor defaults so only the interval varies (§7).
  const base = { role: 'gcs', sourceSystemId: 255, sourceComponentId: 190 };
  const custom = new Node({ ...base, id: 'custom', heartbeatIntervalMs: 250 });
  const stock = new Node({ ...base, id: 'stock', heartbeatIntervalMs: 1000 });

  assert.equal(custom.heartbeatIntervalMs, 250);
  assert.equal(stock.heartbeatIntervalMs, 1000);
});

test('a companion carries its saved CompID; only SysID is derived', () => {
  const RED = redStub();
  require('../../nodes/mavlink-local-identity')(RED);
  const Node = RED.nodes.types['mavlink-local-identity'];

  // MAV_COMPONENT reserves 191-194 for onboard computers. The runtime used to
  // overwrite the saved value with 191, which made every companion on a link
  // identical on the wire — same derived sysid, same pinned compid. The editor
  // owns the field now (§6) and the runtime reads it.
  const second = new Node({
    id: 'c2', role: 'companion', sourceSystemId: '', sourceComponentId: 192,
    heartbeatIntervalMs: 1000,
  });

  assert.equal(second.sourceComponentId, 192);
  assert.equal(second.sourceSystemId, null, 'SysID is still derived from the vehicle');
  assert.equal(second.derivesSysidFromVehicle, true);

  second.bindVehicleSysid(7, 'Link', 'conn-1');
  assert.deepEqual(second.getIdentity(), { sysid: 7, compid: 192 });
});

function redStub() {
  return {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'node';
        node.status = () => {};
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
    },
  };
}
