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

  // MAV_COMPONENT reserves 191-194 for onboard computers. The editor owns the
  // CompID field in every role (§6) and the runtime reads what was saved, so
  // two companions on a link separate on their slots.
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

test('a never-opened node deploys on the editor concrete defaults, no runtime preset fill', () => {
  const RED = redStub();
  require('../../nodes/mavlink-local-identity')(RED);
  const Node = RED.nodes.types['mavlink-local-identity'];

  // A node dropped on the canvas and deployed without its dialog ever being
  // opened saves the raw `defaults` from mavlink-local-identity.html —
  // concrete for both heartbeat fields (§6), so the runtime reads them as
  // saved with no `||` preset fallback.
  const node = new Node({
    id: 'never-opened',
    role: 'gcs',
    sourceSystemId: 255,
    sourceComponentId: 190,
    heartbeatType: 'MAV_TYPE_GCS',
    heartbeatAutopilot: 'MAV_AUTOPILOT_INVALID',
    heartbeatIntervalMs: 1000,
  });

  assert.equal(node.heartbeatType, 'MAV_TYPE_GCS');
  assert.equal(node.heartbeatAutopilot, 'MAV_AUTOPILOT_INVALID');
  assert.deepEqual(node.getHeartbeatFields(), {
    type: 'MAV_TYPE_GCS',
    autopilot: 'MAV_AUTOPILOT_INVALID',
    base_mode: 0,
    custom_mode: 0,
    system_status: 'MAV_STATE_ACTIVE',
    mavlink_version: 3,
  });
});

test('the runtime trusts the saved heartbeat fields directly, not the role preset', () => {
  const RED = redStub();
  require('../../nodes/mavlink-local-identity')(RED);
  const Node = RED.nodes.types['mavlink-local-identity'];

  // A companion whose saved heartbeat fields differ from
  // ROLE_PRESETS.companion proves the runtime reads config directly rather
  // than silently substituting the preset (§6 — no runtime fallback default).
  const node = new Node({
    id: 'custom-hb',
    role: 'companion',
    sourceSystemId: '',
    sourceComponentId: 191,
    heartbeatType: 'MAV_TYPE_GENERIC',
    heartbeatAutopilot: 'MAV_AUTOPILOT_PX4',
    heartbeatIntervalMs: 1000,
  });

  assert.equal(node.heartbeatType, 'MAV_TYPE_GENERIC');
  assert.equal(node.heartbeatAutopilot, 'MAV_AUTOPILOT_PX4');
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
