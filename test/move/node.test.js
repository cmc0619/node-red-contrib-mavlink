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

test('mavlink-move stream: payload rateHz overrides config (§6 payload overrides values)', async () => {
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
    rateHz: 0.1,
    ttlMs: 0,
  });

  node.emit('input', { payload: { rateHz: 200, ttlMs: 0 } }, () => {}, () => {});

  // At the configured 0.1 Hz (one send per 10 s) no re-send would arrive
  // inside the deadline; the payload's 200 Hz override must produce several.
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
    rateHz: 10,
    ttlMs: 1000,
  });

  // A NaN ttl would never satisfy the stream's `ttl > 0` expiry check (the
  // stream runs forever); a zero or near-zero rate makes the derived
  // 1000/rate interval degenerate into a setInterval clamp flood. Both must
  // fail the input instead.
  const bad = [
    { payload: { ttlMs: 'forever' }, why: 'non-numeric ttl', rule: /milliseconds/ },
    { payload: { rateHz: 'fast' }, why: 'non-numeric rate', rule: /Hz/ },
    { payload: { rateHz: -5 }, why: 'negative rate', rule: /Hz/ },
    { payload: { rateHz: 0 }, why: 'zero rate', rule: /Hz/ },
    { payload: { rateHz: 0.05 }, why: 'below-minimum rate', rule: /Hz/ },
    { payload: { ttlMs: -1 }, why: 'negative ttl', rule: /milliseconds/ },
    // Bare Number() coercion would make these numeric: true → a 1 Hz stream
    // nobody asked for, false/[] → 0. Only numbers and numeric strings are
    // values.
    { payload: { rateHz: true }, why: 'boolean rate', rule: /Hz/ },
    { payload: { ttlMs: false }, why: 'boolean ttl', rule: /milliseconds/ },
    { payload: { rateHz: [5] }, why: 'array rate', rule: /Hz/ },
  ];
  for (const { payload, why, rule } of bad) {
    let sent;
    let doneError;
    node.emit('input', { payload }, (m) => { sent = m; }, (err) => { doneError = err; });
    assert.equal(sent[0], null, `${why} must not start a stream`);
    assert.equal(sent[1].result, 'failed', `${why} fails the input`);
    assert.match(doneError.message, rule, `${why} names the timing rule`);
  }

  // Blank still inherits config, and an explicit payload ttl of 0 is a value
  // ("stream until replaced or closed"), not a malformed override.
  for (const payload of [{}, { rateHz: '', ttlMs: null }, { ttlMs: 0 }]) {
    let sent;
    let doneError;
    node.emit('input', { payload }, (m) => { sent = m; }, (err) => { doneError = err; });
    assert.equal(doneError, undefined, `${JSON.stringify(payload)} must be accepted`);
    assert.equal(sent[1].result, 'succeeded');
  }
  node.emit('close', () => {});
});

test('mavlink-move stream: TTL expiry emits an expired message the flow can chain on', async () => {
  const conn = { vehicle: {}, send() {} };
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
    rateHz: 200,
    ttlMs: 20,
  });

  const emitted = [];
  node.send = (messages) => { emitted.push(messages); };

  let started;
  node.emit('input', { payload: {} }, (m) => { started = m; }, () => {});
  assert.ok(started[0], 'starting the stream fires the continue port');

  const deadline = Date.now() + 2000;
  while (!emitted.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  node.emit('close', () => {});

  assert.equal(emitted.length, 1, 'expiry emits exactly once');
  const [out, status] = emitted[0];
  // §9: output 0 is a trigger fired at most once per input, and the stream's
  // start already fired it. A second message here would run the downstream
  // chain twice — once at t=0 and once at expiry.
  assert.equal(out, null, 'expiry must not re-fire the continue port');
  assert.equal(status.result, 'succeeded');
  assert.equal(status.detail, 'expired');
  // Carries the stop packet the vehicle actually got: zero-velocity, not the
  // all-ignore mask PX4 rejects (§14 / #115).
  assert.equal(status.message.fields.type_mask, 3527);
});

test('mavlink-move stream: a whitespace ttl inherits the configured TTL, never "run forever"', async () => {
  const conn = { vehicle: {}, send() {} };
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
    rateHz: 200,
    ttlMs: 20,
  });

  const emitted = [];
  node.send = (messages) => { emitted.push(messages); };

  // Number(' ') is a finite 0, and ttl 0 means "stream until replaced or
  // closed" — so an untrimmed whitespace override would silently outlive the
  // configured 20 ms. Expiring proves it inherited the configured value.
  node.emit('input', { payload: { ttlMs: ' ' } }, () => {}, () => {});
  const deadline = Date.now() + 2000;
  while (!emitted.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  node.emit('close', () => {});

  assert.equal(emitted.length, 1, 'whitespace ttl still expires');
  assert.equal(emitted[0][1].detail, 'expired');
});

test('mavlink-move stream: a replaced or closed stream expires silently', async () => {
  const conn = { vehicle: {}, send() {} };
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
    rateHz: 200,
    ttlMs: 0,
  });

  const emitted = [];
  node.send = (messages) => { emitted.push(messages); };

  // The flow caused both of these, so neither needs announcing back to it.
  node.emit('input', { payload: {} }, () => {}, () => {});
  node.emit('input', { payload: {} }, () => {}, () => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  node.emit('close', () => {});
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(emitted.length, 0, 'replacement and close emit nothing');
});

test('mavlink-move stream: rejected timing override leaves the active stream running', async () => {
  const sends = [];
  const conn = {
    vehicle: {},
    send(message) { sends.push(message); },
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
    rateHz: 200,
    ttlMs: 0,
  });

  node.emit('input', { payload: {} }, () => {}, () => {});
  let deadline = Date.now() + 2000;
  while (sends.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(sends.length >= 2, 'stream must be running before the bad input');

  // The rejected replacement must not stop the running stream: validation
  // happens before stream.stop(), same as a buildMoveMessage refusal.
  let doneError;
  node.emit('input', { payload: { ttlMs: 'forever' } }, () => {}, (err) => { doneError = err; });
  assert.match(doneError.message, /milliseconds/);

  const before = sends.length;
  deadline = Date.now() + 2000;
  while (sends.length < before + 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  node.emit('close', () => {});
  assert.ok(
    sends.length >= before + 2,
    `stream must keep sending after a rejected override (got ${sends.length - before} further sends)`
  );
});

test('mavlink-move stream: one owner per (connection, target) — a second node is refused, the owner may replace itself (#176)', () => {
  const conn = { id: 'conn', vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const cfg = {
    delivery: 'stream',
    mode: 'velocity',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 200,
    ttlMs: 0,
  };
  const a = new Node({ ...cfg });
  const b = new Node({ ...cfg });

  a.emit('input', { payload: {} }, () => {}, () => {});

  // Another node streaming to the held target fails loudly — no takeover.
  let sent;
  let doneError;
  b.emit('input', { payload: {} }, (m) => { sent = m; }, (err) => { doneError = err; });
  assert.equal(sent[0], null, 'conflict must not fire the continue port');
  assert.equal(sent[1].result, 'failed');
  assert.match(doneError.message, /stream to 1\.1 is already running on this connection/);

  // The owner replacing its own stream is single-flight, not a conflict.
  let replaced;
  a.emit('input', { payload: {} }, (m) => { replaced = m; }, () => {});
  assert.equal(replaced[1].result, 'succeeded', 'same node re-acquires its own scope');

  // A different target on the same connection is a different vehicle: free.
  let other;
  b.emit('input', { payload: { target: { sysid: 2, compid: 1 } } }, (m) => { other = m; }, () => {});
  assert.equal(other[1].result, 'succeeded', 'other targets stay free');

  // Close releases the scope for the next owner.
  a.emit('close', () => {});
  let after;
  b.emit('input', { payload: {} }, (m) => { after = m; }, () => {});
  assert.equal(after[1].result, 'succeeded', 'close freed the target');
  b.emit('close', () => {});
});

test('mavlink-move stream: TTL expiry frees the target for another node (#176)', async () => {
  const conn = { id: 'conn', vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const cfg = {
    delivery: 'stream',
    mode: 'velocity',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 200,
    ttlMs: 0,
  };
  const a = new Node({ ...cfg, ttlMs: 20 });
  const b = new Node({ ...cfg });

  const emitted = [];
  a.send = (messages) => { emitted.push(messages); };
  a.emit('input', { payload: {} }, () => {}, () => {});

  const deadline = Date.now() + 2000;
  while (!emitted.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(emitted[0][1].detail, 'expired', 'stream expired');

  let sent;
  b.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});
  assert.equal(sent[1].result, 'succeeded', 'expiry freed the target');
  a.emit('close', () => {});
  b.emit('close', () => {});
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
        // Real Node-RED gives every node a send() for emits that outlive the
        // input handler — the stream-expiry message is one.
        node.send = () => {};
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
