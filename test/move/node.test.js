'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-move node builds a local-position message and emits status on output 1', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ delivery: 'build', mode: 'local-position', targetSystem: 5, targetComponent: 1 });
  let sent;

  node.emit(
    'input',
    { payload: { position: { north: 1, east: 2, up: 3 } } },
    (messages) => {
      sent = messages;
    },
    () => {}
  );

  assert.equal(sent[0].payload.name, 'SET_POSITION_TARGET_LOCAL_NED');
  assert.equal(sent[0].payload.fields.z, -3);
  assert.equal(sent[1].result, 'succeeded');
});

test('mavlink-move inherits Vehicle Profile target when config is empty', () => {
  const veh = { defaultTargetSystem: 42, defaultTargetComponent: 191 };
  const RED = redStub({ veh });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'build',
    mode: 'local-position',
    targetSystem: '',
    targetComponent: '',
    vehicle: 'veh',
  });
  let sent;

  node.emit(
    'input',
    { payload: {} },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 42);
  assert.equal(sent[0].payload.fields.target_component, 191);
});

test('mavlink-move explicit config value wins over Vehicle Profile', () => {
  const veh = { defaultTargetSystem: 42, defaultTargetComponent: 191 };
  const RED = redStub({ veh });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'build',
    mode: 'local-position',
    targetSystem: 7,
    targetComponent: 100,
    vehicle: 'veh',
  });
  let sent;

  node.emit(
    'input',
    { payload: {} },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 7);
  assert.equal(sent[0].payload.fields.target_component, 100);
});

test('mavlink-move config 0 (broadcast) wins over Vehicle Profile', () => {
  const veh = { defaultTargetSystem: 42, defaultTargetComponent: 191 };
  const RED = redStub({ veh });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'build',
    mode: 'local-position',
    targetSystem: 0,
    targetComponent: 0,
    vehicle: 'veh',
  });
  let sent;

  node.emit(
    'input',
    { payload: {} },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 0);
  assert.equal(sent[0].payload.fields.target_component, 0);
});

test('mavlink-move companion identity derives sysid from airframe and pins compid to 1', () => {
  const sends = [];
  const conn = {
    vehicle: { targetSysid: 10, targetCompid: 2 },
    send(message, opts) { sends.push({ message, opts }); },
  };
  const comp1 = {
    derivesSysidFromVehicle: true,
    getIdentity: () => ({ sysid: 42, compid: 191 }),
  };
  const RED = redStub({ conn, comp1 });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'send',
    mode: 'local-position',
    identity: 'comp1',
    connection: 'conn',
    targetSystem: '',
    targetComponent: '',
  });

  node.emit('input', { payload: {} }, () => {}, () => {});

  assert.equal(sends.length, 1, 'message was sent');
  assert.equal(sends[0].opts.target.sysid, 42, 'sysid derived from companion airframe');
  assert.equal(sends[0].opts.target.compid, 1, 'compid pinned to 1 (autopilot) for companion');
});

test('mavlink-move payload.target beats companion derivation', () => {
  const sends = [];
  const conn = {
    vehicle: { targetSysid: 10, targetCompid: 2 },
    send(message, opts) { sends.push({ message, opts }); },
  };
  const comp1 = {
    derivesSysidFromVehicle: true,
    getIdentity: () => ({ sysid: 42, compid: 191 }),
  };
  const RED = redStub({ conn, comp1 });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'send',
    mode: 'local-position',
    identity: 'comp1',
    connection: 'conn',
    targetSystem: '',
    targetComponent: '',
  });

  node.emit(
    'input',
    { payload: { target: { sysid: 99, compid: 50 } } },
    () => {},
    () => {}
  );

  assert.equal(sends[0].opts.target.sysid, 99, 'payload.target.sysid beats companion');
  assert.equal(sends[0].opts.target.compid, 50, 'payload.target.compid beats companion pin');
});

test('mavlink-move build tier inherits from config.vehicle stub', () => {
  const veh1 = { defaultTargetSystem: 77, defaultTargetComponent: 78 };
  const RED = redStub({ veh1 });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'build',
    mode: 'local-position',
    vehicle: 'veh1',
    targetSystem: '',
    targetComponent: '',
  });
  let sent;

  node.emit(
    'input',
    { payload: {} },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 77);
  assert.equal(sent[0].payload.fields.target_component, 78);
});

test('mavlink-move build tier ignores connection vehicle when vehicle field is set', () => {
  const veh1 = { defaultTargetSystem: 77, defaultTargetComponent: 78 };
  const conn = { vehicle: { targetSysid: 99, targetCompid: 99 } };
  const RED = redStub({ veh1, conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'build',
    mode: 'local-position',
    vehicle: 'veh1',
    connection: 'conn',
    targetSystem: '',
    targetComponent: '',
  });
  let sent;

  node.emit(
    'input',
    { payload: {} },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 77, 'vehicle profile used, not connection profile');
  assert.equal(sent[0].payload.fields.target_component, 78, 'vehicle profile used, not connection profile');
});

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
