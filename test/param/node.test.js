'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-param node builds PARAM_SET from msg payload values', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    action: 'set',
    targetSystem: 6,
    targetComponent: 1,
  });
  let sent;

  node.emit(
    'input',
    {
      payload: {
        paramId: 'FOO',
        value: 12,
        paramType: 'MAV_PARAM_TYPE_REAL32',
        firmware: 'ardupilot',
      },
    },
    (messages) => {
      sent = messages;
    },
    () => {}
  );

  assert.equal(sent[0].payload.name, 'PARAM_SET');
  assert.equal(sent[0].payload.fields.param_id, 'FOO');
  assert.equal(sent[0].payload.fields.param_value, 12);
  // The status record leaves output 1 as the top-level message, not msg.payload.
  assert.equal(sent[1].result, 'succeeded');
});

test('mavlink-param reuses its deploy-resolved Connection during input delivery', () => {
  const conn = connStubFull();
  const RED = redStub({ conn });
  const getNode = RED.nodes.getNode.bind(RED.nodes);
  let connectionLookups = 0;
  RED.nodes.getNode = (id) => {
    if (id === 'conn') connectionLookups++;
    return getNode(id);
  };
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'send',
    action: 'read',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
  });

  node.emit('input', { payload: { paramId: 'ARMING_CHECK' } }, () => {}, () => {});

  assert.equal(connectionLookups, 1, 'Connection is resolved once at deploy');
  assert.equal(conn.sent.length, 1);
});

test('mavlink-param confirm set emits a timed-out record and releases the subscription', () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
    timeout: 5, // ms — fire quickly for the test
  });

  return new Promise((resolve) => {
    let out;
    node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, (m) => { out = m; }, () => {});
    setTimeout(() => {
      assert.ok(out, 'a terminal record was emitted on timeout');
      assert.equal(out[0], null, 'output 0 must not fire on timeout');
      assert.equal(out[1].result, 'timeout');
      assert.equal(conn.activeCount(), 0, 'the subscription is torn down on timeout');
      resolve();
    }, 30);
  });
});

test('mavlink-param confirm set scopes its PARAM_VALUE subscription to the target vehicle', () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
  });

  node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, () => {}, () => {});

  assert.equal(conn.subs.length, 1, 'one PARAM_VALUE subscription installed');
  assert.equal(conn.subs[0].filter.message, 'PARAM_VALUE');
  assert.equal(conn.subs[0].filter.sysid, 6, 'subscription scoped to target sysid');
  assert.equal(conn.subs[0].filter.compid, 1, 'subscription scoped to target compid');
});

test('mavlink-param inherits Vehicle Profile target when config is empty (build tier via vehicle field)', () => {
  // Build tier reads the profile from config.vehicle (not config.connection).
  const vehicleNode = { defaultTargetSystem: 42, defaultTargetComponent: 191, firmware: 'ardupilot' };
  const RED = redStub({ veh: vehicleNode });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    dialect: '__vehicle',
    action: 'read',
    targetSystem: '',
    targetComponent: '',
    vehicle: 'veh',
  });
  let sent;

  node.emit(
    'input',
    { payload: { paramId: 'ARMING_CHECK' } },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 42);
  assert.equal(sent[0].payload.fields.target_component, 191);
});

test('mavlink-param explicit config value wins over Vehicle Profile', () => {
  const conn = { vehicle: { targetSystem: 42, targetComponent: 191 }, send() {}, subscribe() { return () => {}; } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    action: 'read',
    targetSystem: 7,
    targetComponent: 100,
    connection: 'conn',
  });
  let sent;

  node.emit(
    'input',
    { payload: { paramId: 'ARMING_CHECK' } },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 7);
  assert.equal(sent[0].payload.fields.target_component, 100);
});

test('mavlink-param cancels a prior in-flight subscription when a second op starts', () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
  });

  node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, () => {}, () => {});
  node.emit('input', { payload: { paramId: 'BAR', value: 2 } }, () => {}, () => {});

  // Two subscriptions were created, but the first must have been cancelled so
  // exactly one remains active (no leak).
  assert.equal(conn.subs.length, 2);
  assert.equal(conn.activeCount(), 1, 'only the latest subscription remains active');
});

test('mavlink-param companion identity derives sysid; echo from sysid 42 confirms, sysid 1 ignored', () => {
  // Companion identity: sysid derived from airframe (42), compid pinned to 1.
  const conn = connStubFull({
    vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' },
  });
  const identityNode = { derivesSysidFromVehicle: true, getIdentity: () => ({ sysid: 42, compid: 191 }) };
  const RED = redStub({ conn, identity: identityNode });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    connection: 'conn',
    identity: 'identity',
    targetSystem: '',
    targetComponent: '',
  });

  let result;
  node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, (m) => { result = m; }, () => {});

  // Subscription must be scoped to the companion-derived sysid (42) and compid 1 (autopilot).
  assert.equal(conn.subs.length, 1);
  assert.equal(conn.subs[0].filter.sysid, 42, 'subscription scoped to companion derived sysid');
  assert.equal(conn.subs[0].filter.compid, 1, 'subscription scoped to autopilot compid 1');

  // Echo from sysid 1 — filter blocks it, transaction stays open.
  conn.inject({ name: 'PARAM_VALUE', sysid: 1, compid: 1, fields: { param_id: 'FOO', param_value: 1, param_count: 1, param_index: 0, param_type: 9 } });
  assert.equal(result, undefined, 'echo from sysid 1 does not confirm');

  // Echo from sysid 42 — passes filter and matchesParamEcho, confirms the set.
  conn.inject({ name: 'PARAM_VALUE', sysid: 42, compid: 1, fields: { param_id: 'FOO', param_value: 1, param_count: 1, param_index: 0, param_type: 9 } });
  assert.ok(result, 'echo from derived sysid 42 confirms the set');
  assert.equal(result[1].result, 'succeeded');
});

test('mavlink-param payload.target overrides companion derivation', () => {
  const conn = connStubFull({
    vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' },
  });
  const identityNode = { derivesSysidFromVehicle: true, getIdentity: () => ({ sysid: 42, compid: 191 }) };
  const RED = redStub({ conn, identity: identityNode });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    connection: 'conn',
    identity: 'identity',
    targetSystem: '',
    targetComponent: '',
  });

  // payload.target.sysid = 50 overrides companion derivation (step 1 wins over step 2).
  node.emit('input', { payload: { paramId: 'FOO', value: 1, target: { sysid: 50 } } }, () => {}, () => {});
  assert.equal(conn.subs[0].filter.sysid, 50, 'payload.target.sysid overrides companion derivation');
});

test('mavlink-param build tier inherits from config.vehicle (sysid 77, compid 78, firmware px4)', () => {
  const vehicleNode = { defaultTargetSystem: 77, defaultTargetComponent: 78, firmware: 'px4' };
  const RED = redStub({ veh: vehicleNode });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    dialect: '__vehicle',
    action: 'read',
    vehicle: 'veh',
    targetSystem: '',
    targetComponent: '',
  });
  let sent;
  node.emit('input', { payload: { paramId: 'ARMING_CHECK' } }, (m) => { sent = m; }, () => {});

  assert.equal(sent[0].payload.fields.target_system, 77, 'sysid from vehicle node');
  assert.equal(sent[0].payload.fields.target_component, 78, 'compid from vehicle node');
});

test('mavlink-param Build concrete dialect uses config firmware', () => {
  const { paramValueToWire } = require('../../lib/codec');
  const RED = redStub({});
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    dialect: 'common',
    firmware: 'px4',
    action: 'set',
    targetSystem: 1,
    targetComponent: 1,
  });
  let sent;

  node.emit(
    'input',
    { payload: { paramId: 'BAT_N_CELLS', value: 3, paramType: 'MAV_PARAM_TYPE_INT32' } },
    (m) => { sent = m; },
    () => {}
  );

  assert.equal(sent[0].payload.name, 'PARAM_SET');
  assert.equal(sent[0].payload.fields.param_value, paramValueToWire(3, 'MAV_PARAM_TYPE_INT32'));
});

test('mavlink-param payload firmware overrides Build concrete dialect firmware', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    dialect: 'common',
    firmware: 'ardupilot',
    action: 'set',
    targetSystem: 1,
    targetComponent: 1,
  });
  let sent;

  node.emit(
    'input',
    {
      payload: {
        paramId: 'BAT_N_CELLS',
        value: 3,
        paramType: 'MAV_PARAM_TYPE_INT32',
        firmware: 'px4',
      },
    },
    (m) => { sent = m; },
    () => {}
  );

  assert.notEqual(sent[0].payload.fields.param_value, 3, 'payload firmware wins over config firmware');
});

test('mavlink-param capabilities beat ardupilot firmware for bytewise encoding', () => {
  const { paramValueToWire } = require('../../lib/codec');
  const { CAP_PARAM_ENCODE_BYTEWISE } = require('../../lib/param');
  const peerTable = {
    getComponent(sysid, compid) {
      if (Number(sysid) === 1 && Number(compid) === 1) {
        return { capabilities: CAP_PARAM_ENCODE_BYTEWISE };
      }
      return undefined;
    },
  };
  const conn = connStubFull({
    vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' },
    peerTable,
  });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'send',
    action: 'set',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
  });

  node.emit(
    'input',
    { payload: { paramId: 'BAT_N_CELLS', value: 3, paramType: 'MAV_PARAM_TYPE_INT32' } },
    () => {},
    () => {}
  );

  assert.equal(
    conn.sent[0].message.fields.param_value,
    paramValueToWire(3, 'MAV_PARAM_TYPE_INT32'),
    'BYTEWISE capability encodes via float bit-cast despite ardupilot firmware'
  );
});

test('mavlink-param msg.payload.paramEncoding overrides peer capabilities', () => {
  const { CAP_PARAM_ENCODE_BYTEWISE } = require('../../lib/param');
  const peerTable = {
    getComponent() {
      return { capabilities: CAP_PARAM_ENCODE_BYTEWISE };
    },
  };
  const conn = connStubFull({
    vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'px4' },
    peerTable,
  });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'send',
    action: 'set',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
  });

  node.emit(
    'input',
    {
      payload: {
        paramId: 'BAT_N_CELLS',
        value: 3,
        paramType: 'MAV_PARAM_TYPE_INT32',
        paramEncoding: 'c-cast',
      },
    },
    () => {},
    () => {}
  );

  assert.equal(conn.sent[0].message.fields.param_value, 3, 'explicit c-cast wins');
});

test('mavlink-param firmware follows profile not stale config (profile px4 → firmware px4)', () => {
  // PX4 uses a float-reinterpret encoding for integer params. This test
  // verifies that the request firmware comes from the profile, not config.firmware.
  const conn = connStubFull({ vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'px4' } });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    // no firmware in config — it is gone from the UI
  });

  let result;
  node.emit(
    'input',
    { payload: { paramId: 'BAT_N_CELLS', value: 3, paramType: 'MAV_PARAM_TYPE_INT32' } },
    (m) => { result = m; },
    () => {}
  );

  // PX4 encoding: paramValueToWire(3, INT32) produces a float-bit-reinterpretation.
  // The subscription fires with the same value so confirmation succeeds.
  const sentFields = conn.sent[0].message.fields;
  // For PX4 INT32, the wire value is the IEEE 754 reinterpretation of integer bits.
  // We just verify that the firmware affected the encoded value (not raw Number(3)).
  // paramValueToWire(3, 6) → reinterpret int32(3) as float32 → 4.203895e-45
  assert.ok(sentFields.param_value !== 3, 'PX4 firmware encodes integer params via float reinterpret');

  // Confirm with the same encoded value coming back from sysid 1.
  conn.inject({
    name: 'PARAM_VALUE',
    sysid: 1,
    compid: 1,
    fields: {
      param_id: 'BAT_N_CELLS',
      param_value: sentFields.param_value,
      param_type: 6,
      param_count: 1,
      param_index: 0,
    },
  });
  assert.ok(result, 'echo with PX4 encoded value confirms');
  assert.equal(result[1].result, 'succeeded');
});

test('mavlink-param wire tier inherits from connection vehicle profile', () => {
  const conn = connStubFull({
    vehicle: { targetSystem: 55, targetComponent: 200, firmware: 'ardupilot' },
  });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'send',
    action: 'read',
    connection: 'conn',
    targetSystem: '',
    targetComponent: '',
  });

  node.emit('input', { payload: { paramId: 'ARMING_CHECK' } }, () => {}, () => {});
  const msg = conn.sent[0].message;
  assert.equal(msg.fields.target_system, 55);
  assert.equal(msg.fields.target_component, 200);
});

/**
 * Connection stub that records subscription filters and unsubscribe calls.
 */
function connStub(opts) {
  opts = opts || {};
  const subs = [];
  return {
    subs,
    // Wire-tier profile must carry firmware — runtime no longer invents ardupilot.
    vehicle: opts.vehicle || { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' },
    send() {},
    subscribe(filter, handler) {
      const entry = { filter, handler, active: true };
      subs.push(entry);
      return () => {
        entry.active = false;
      };
    },
    activeCount() {
      return subs.filter((s) => s.active).length;
    },
  };
}

/**
 * Extended connection stub that also records sent messages and supports
 * injecting inbound decoded messages to active subscribers.
 */
function connStubFull(opts) {
  opts = opts || {};
  const subs = [];
  const sent = [];
  const stub = {
    subs,
    sent,
    vehicle: opts.vehicle || { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' },
    peerTable: opts.peerTable || null,
    send(message, options) {
      sent.push({ message, options });
    },
    subscribe(filter, handler) {
      const entry = { filter, handler, active: true };
      subs.push(entry);
      return () => { entry.active = false; };
    },
    activeCount() {
      return subs.filter((s) => s.active).length;
    },
    inject(decoded) {
      const d = { sysid: 1, compid: 1, ...decoded };
      for (const entry of subs.slice()) {
        if (!entry.active) continue;
        if (entry.filter.message !== undefined && entry.filter.message !== d.name) continue;
        if (entry.filter.sysid !== undefined && entry.filter.sysid !== d.sysid) continue;
        if (entry.filter.compid !== undefined && entry.filter.compid !== d.compid) continue;
        entry.handler(d);
      }
    },
  };
  return stub;
}

function redStub(nodesById) {
  return {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'node';
        node.status = () => {};
        node.error = () => {};
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
      getNode(id) {
        return nodesById[id];
      },
    },
  };
}
