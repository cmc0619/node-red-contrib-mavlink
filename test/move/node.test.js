'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-move node builds a position message and emits status on output 1', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ delivery: 'build', dialect: 'common', mode: 'position',
    north: 0,
    east: 0,
    up: 0, targetSystem: 5, targetComponent: 1 });
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

test('mavlink-move inherits Vehicle Profile target when Build dialect uses Vehicle Profile escape', () => {
  const veh = { defaultTargetSystem: 42, defaultTargetComponent: 191 };
  const RED = redStub({ veh });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'build',
    dialect: '__vehicle',
    mode: 'position',
    north: 0,
    east: 0,
    up: 0,
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
    dialect: '__vehicle',
    mode: 'position',
    north: 0,
    east: 0,
    up: 0,
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
    dialect: '__vehicle',
    mode: 'position',
    north: 0,
    east: 0,
    up: 0,
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
    vehicle: { targetSystem: 10, targetComponent: 2 },
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
    mode: 'position',
    north: 0,
    east: 0,
    up: 0,
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

test('mavlink-move reuses its deploy-resolved Connection during input delivery', () => {
  const sends = [];
  const conn = {
    vehicle: { targetSystem: 10, targetComponent: 2 },
    send(message, opts) { sends.push({ message, opts }); },
  };
  const RED = redStub({ conn });
  const getNode = RED.nodes.getNode.bind(RED.nodes);
  let connectionLookups = 0;
  RED.nodes.getNode = (id) => {
    if (id === 'conn') connectionLookups++;
    return getNode(id);
  };
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'send',
    mode: 'position',
    north: 0,
    east: 0,
    up: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
  });

  node.emit('input', { payload: {} }, () => {}, () => {});

  assert.equal(connectionLookups, 1, 'Connection is resolved once at deploy');
  assert.equal(sends.length, 1);
});

test('mavlink-move missing Connection keeps output 1 and done(err) failure delivery', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'send',
    mode: 'position',
    north: 0,
    east: 0,
    up: 0,
    connection: 'missing',
    targetSystem: 1,
    targetComponent: 1,
  });
  let sent;
  let doneError;

  node.emit(
    'input',
    { payload: {} },
    (messages) => { sent = messages; },
    (err) => { doneError = err; }
  );

  assert.equal(sent[0], null);
  assert.equal(sent[1].result, 'failed');
  assert.match(sent[1].detail, /requires a Connection/);
  assert.match(doneError.message, /requires a Connection/);
});

test('mavlink-move payload.target beats companion derivation', () => {
  const sends = [];
  const conn = {
    vehicle: { targetSystem: 10, targetComponent: 2 },
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
    mode: 'position',
    north: 0,
    east: 0,
    up: 0,
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

test('mavlink-move build tier inherits from config.vehicle stub only with Vehicle Profile escape', () => {
  const veh1 = { defaultTargetSystem: 77, defaultTargetComponent: 78 };
  const RED = redStub({ veh1 });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'build',
    dialect: '__vehicle',
    mode: 'position',
    north: 0,
    east: 0,
    up: 0,
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
  const conn = { vehicle: { targetSystem: 99, targetComponent: 99 } };
  const RED = redStub({ veh1, conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'build',
    dialect: '__vehicle',
    mode: 'position',
    north: 0,
    east: 0,
    up: 0,
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

test('mavlink-move concrete Build dialect does not inherit stale Vehicle Profile target', () => {
  const veh1 = { defaultTargetSystem: 77, defaultTargetComponent: 78 };
  const RED = redStub({ veh1 });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'build',
    dialect: 'common',
    mode: 'position',
    north: 0,
    east: 0,
    up: 0,
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

  assert.ok(Number.isNaN(sent[0].payload.fields.target_system), 'concrete Build dialect has no profile inheritance rung');
  assert.ok(Number.isNaN(sent[0].payload.fields.target_component), 'concrete Build dialect has no profile inheritance rung');
});

test('mavlink-move blank payload frame inherits the configured frame, not LOCAL_NED', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'build',
    dialect: 'common',
    mode: 'position',
    frame: 'GLOBAL_RELATIVE_ALT_INT',
    lat: 47,
    lon: 8,
    alt: 10,
    targetSystem: 5,
    targetComponent: 1,
  });

  // Blank means inherit (§6): an unset/null/'' payload frame keeps the
  // configured global frame rather than resetting to the LOCAL_NED default.
  for (const blank of [undefined, null, '']) {
    let sent;
    node.emit('input', { payload: { frame: blank } }, (m) => { sent = m; }, () => {});
    assert.equal(sent[0].payload.name, 'SET_POSITION_TARGET_GLOBAL_INT', `blank frame ${JSON.stringify(blank)} inherits config`);
    assert.equal(sent[0].payload.fields.coordinate_frame, 6);
  }

  // An explicit payload frame still wins.
  let sent;
  node.emit(
    'input',
    { payload: { frame: 'LOCAL_NED', position: { north: 1, east: 2, up: 3 } } },
    (m) => { sent = m; },
    () => {}
  );
  assert.equal(sent[0].payload.name, 'SET_POSITION_TARGET_LOCAL_NED');
});

test('mavlink-move stream: payload intervalMs overrides config (§6 payload overrides values)', async () => {
  const sends = [];
  const conn = {
    vehicle: {},
    send(message, opts) { sends.push({ message, opts }); },
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    mode: 'velocity',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    intervalMs: 60000,
    ttlMs: 0,
  });

  node.emit('input', { payload: { intervalMs: 5, ttlMs: 0 } }, () => {}, () => {});

  // At the configured 60 s interval no re-send would arrive inside the
  // deadline; the payload's 5 ms override must produce several.
  const deadline = Date.now() + 2000;
  while (sends.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  node.emit('close', () => {});
  assert.ok(sends.length >= 3, `payload interval override must re-send (got ${sends.length} sends)`);
});

test('mavlink-move stream: malformed payload timing overrides refuse the input', () => {
  const conn = {
    vehicle: {},
    send() {},
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    mode: 'velocity',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    intervalMs: 100,
    ttlMs: 1000,
  });

  // A NaN ttl would never satisfy the stream's `ttl > 0` expiry check (the
  // stream runs forever); a negative interval reaches setInterval as ~1 ms.
  // Both must fail the input instead.
  const bad = [
    { payload: { ttlMs: 'forever' }, why: 'non-numeric ttl' },
    { payload: { intervalMs: 'fast' }, why: 'non-numeric interval' },
    { payload: { intervalMs: -5 }, why: 'negative interval' },
    { payload: { intervalMs: 0 }, why: 'zero interval' },
    { payload: { ttlMs: -1 }, why: 'negative ttl' },
  ];
  for (const { payload, why } of bad) {
    let sent;
    let doneError;
    node.emit('input', { payload }, (m) => { sent = m; }, (err) => { doneError = err; });
    assert.equal(sent[0], null, `${why} must not start a stream`);
    assert.equal(sent[1].result, 'failed', `${why} fails the input`);
    assert.match(doneError.message, /milliseconds/, `${why} names the timing rule`);
  }

  // Blank still inherits config, and an explicit payload ttl of 0 is a value
  // ("stream until replaced or closed"), not a malformed override.
  for (const payload of [{}, { intervalMs: '', ttlMs: null }, { ttlMs: 0 }]) {
    let sent;
    let doneError;
    node.emit('input', { payload }, (m) => { sent = m; }, (err) => { doneError = err; });
    assert.equal(doneError, undefined, `${JSON.stringify(payload)} must be accepted`);
    assert.equal(sent[1].result, 'succeeded');
  }
  node.emit('close', () => {});
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
