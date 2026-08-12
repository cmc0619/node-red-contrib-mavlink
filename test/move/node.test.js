'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-move node builds a position message and emits status on output 1', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ delivery: 'build', dialect: 'common', action: 'steer',
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
  assert.equal(sent[1].result, 'built');
});

test('mavlink-move inherits Vehicle Profile target when Build dialect uses Vehicle Profile escape', () => {
  const veh = { defaultTargetSystem: 42, defaultTargetComponent: 191 };
  const RED = redStub({ veh });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'build',
    dialect: '__vehicle',
    action: 'steer',
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
    action: 'steer',
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
    action: 'steer',
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
    action: 'steer',
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
    action: 'steer',
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
    action: 'steer',
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
    action: 'steer',
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
    action: 'steer',
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
    action: 'steer',
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

test('mavlink-move blank payload altRef/reference inherit the configured value; explicit payload wins (§6)', () => {
  const veh = { firmware: 'ardupilot' };
  const RED = redStub({ veh });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];

  // goto: a blank payload.altRef keeps the configured msl rather than
  // resetting to the home default.
  const goto = new Node({
    delivery: 'build',
    dialect: 'common',
    action: 'goto',
    altRef: 'msl',
    lat: 47,
    lon: 8,
    alt: 10,
    targetSystem: 5,
    targetComponent: 1,
  });
  for (const blank of [undefined, null, '']) {
    let sent;
    goto.emit('input', { payload: { altRef: blank } }, (m) => { sent = m; }, () => {});
    assert.equal(sent[0].payload.name, 'COMMAND_INT', `blank altRef ${JSON.stringify(blank)} still builds the goto`);
    assert.equal(sent[0].payload.fields.frame, 0, `blank altRef ${JSON.stringify(blank)} inherits msl`);
  }
  let sent;
  goto.emit('input', { payload: { altRef: 'home' } }, (m) => { sent = m; }, () => {});
  assert.equal(sent[0].payload.fields.frame, 3, 'an explicit payload altRef wins');

  // steer: same rule for the reference — Build has no connection, so the
  // body derivation reads the node's own Vehicle Profile (firmwareFor).
  const steer = new Node({
    delivery: 'build',
    dialect: 'common',
    action: 'steer',
    reference: 'body',
    vehicle: 'veh',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    targetSystem: 5,
    targetComponent: 1,
  });
  for (const blank of [undefined, null, '']) {
    steer.emit('input', { payload: { reference: blank } }, (m) => { sent = m; }, () => {});
    assert.equal(sent[0].payload.fields.coordinate_frame, 9, `blank reference ${JSON.stringify(blank)} inherits body (ArduPilot)`);
  }
  steer.emit('input', { payload: { reference: 'world' } }, (m) => { sent = m; }, () => {});
  assert.equal(sent[0].payload.fields.coordinate_frame, 1, 'an explicit payload reference wins');
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
    action: 'steer',
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
    action: 'steer',
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
    assert.equal(sent[1].result, 'streaming');
  }
  node.emit('close', () => {});
});

test('mavlink-move stream: TTL expiry emits an expired message the flow can chain on', async () => {
  const sends = [];
  const conn = { vehicle: {}, send(message) { sends.push(message); } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
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
  assert.equal(status.result, 'expired');
  assert.equal(status.detail, null);
  // Carries the stop packet the vehicle actually got: zero-velocity, not the
  // all-ignore mask PX4 rejects (§14 / #115).
  assert.equal(status.message.fields.type_mask, 3527);
  // ...and it really went to the wire: TTL expiry is an end of control, the
  // one place besides explicit stop and close where the brake fires.
  const brake = sends[sends.length - 1];
  assert.equal(brake.fields.type_mask, 3527, 'TTL expiry sends the brake');
  assert.equal(brake.fields.vx, 0);
  // C11-lite: the record counts setpoints the connection accepted (the
  // brake is not one; the streaming band may coalesce before the wire).
  assert.equal(status.sent, sends.length - 1);
  assert.ok(status.sent >= 1, 'the initial send counts');
});

test('mavlink-move stream: a whitespace ttl inherits the configured TTL, never "run forever"', async () => {
  const conn = { vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
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
  assert.equal(emitted[0][1].result, 'expired');
});

test('mavlink-move stream: a replaced or closed stream expires silently', async () => {
  const conn = { vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
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
    action: 'steer',
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
    action: 'steer',
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
  assert.equal(replaced[1].result, 'streaming', 'same node re-acquires its own scope');

  // A different target on the same connection is a different vehicle: free.
  let other;
  b.emit('input', { payload: { target: { sysid: 2, compid: 1 } } }, (m) => { other = m; }, () => {});
  assert.equal(other[1].result, 'streaming', 'other targets stay free');

  // Close releases the scope for the next owner.
  a.emit('close', () => {});
  let after;
  b.emit('input', { payload: {} }, (m) => { after = m; }, () => {});
  assert.equal(after[1].result, 'streaming', 'close freed the target');
  b.emit('close', () => {});
});

test('mavlink-move stream: TTL expiry frees the target for another node (#176)', async () => {
  const conn = { id: 'conn', vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const cfg = {
    delivery: 'stream',
    action: 'steer',
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
  assert.equal(emitted[0][1].result, 'expired', 'stream expired');

  let sent;
  b.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});
  assert.equal(sent[1].result, 'streaming', 'expiry freed the target');
  a.emit('close', () => {});
  b.emit('close', () => {});
});

test('mavlink-move stream: replacement hands over with no brake; close still brakes', () => {
  const sends = [];
  const conn = { vehicle: {}, send(message) { sends.push(message); } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    // 0.1 Hz: one send per 10 s, so no timer tick lands inside the test —
    // every observed send is an initial setpoint or the brake.
    rateHz: 0.1,
    ttlMs: 0,
  });

  node.emit('input', { payload: {} }, () => {}, () => {});
  node.emit('input', { payload: { velocity: { north: 2, east: 0, up: 0 } } }, () => {}, () => {});

  // GCS practice (§ "Move setpoint matrix"): old setpoint → new setpoint
  // directly, the replacement IS the next command.
  assert.equal(sends.length, 2, 'no brake between old and new');
  assert.equal(sends[0].fields.vx, 1);
  assert.equal(sends[1].fields.vx, 2);

  // Close is an end of control and does brake.
  node.emit('close', () => {});
  assert.equal(sends.length, 3);
  assert.equal(sends[2].fields.type_mask, 3527, 'close sends the brake');
  assert.equal(sends[2].fields.vx, 0);
});

test('mavlink-move stream: a tick send failure never kills the stream and reports once per streak', async () => {
  let failing = false;
  const calls = [];
  const conn = {
    vehicle: {},
    send(message) {
      calls.push(message);
      if (failing) throw new Error('identity unresolved');
    },
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
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
  const statuses = [];
  node.status = (s) => { statuses.push(s); };

  // Wait until the connection has seen `n` more attempts (throwing sends
  // included — an attempt proves the timer is still alive).
  const grow = async (n, why) => {
    const want = calls.length + n;
    const deadline = Date.now() + 2000;
    while (calls.length < want && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(calls.length >= want, why);
  };

  node.emit('input', { payload: {} }, () => {}, () => {});
  failing = true;
  await grow(2, 'the stream keeps its cadence through a failing link');
  failing = false;
  await grow(1, 'the stream still sends after the streak ends');
  failing = true;
  await grow(2, 'the stream survives a second streak');
  failing = false;
  node.emit('close', () => {});

  const failures = emitted.filter((m) => m[0] === null && m[1].result === 'failed');
  assert.equal(failures.length, 2, 'one record per streak: fail…, succeed, fail… → two');
  assert.match(failures[0][1].detail, /send failed/);
  assert.match(failures[0][1].detail, /identity unresolved/);
  // Recovery restores the streaming badge, with no extra record.
  const firstRed = statuses.findIndex((s) => s.fill === 'red');
  assert.ok(firstRed >= 0, 'streak start flips the badge to error');
  assert.ok(
    statuses.slice(firstRed + 1).some((s) => s.fill === 'green' && s.text === 'streaming'),
    'recovery restores the streaming badge'
  );
});

test('mavlink-move stream: a brake-send throw on close still completes close', () => {
  let failing = false;
  const conn = {
    vehicle: {},
    send() {
      if (failing) throw new Error('link down');
    },
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  });
  const warns = [];
  node.warn = (text) => { warns.push(text); };

  node.emit('input', { payload: {} }, () => {}, () => {});
  failing = true;
  let closed = false;
  node.emit('close', () => { closed = true; });

  assert.ok(closed, 'close completed despite the brake throw');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /link down/);
});

test('mavlink-move stream: {action:"stop"} halts the stream, brakes, and records the sent count', async () => {
  const sends = [];
  const conn = { vehicle: {}, send(message) { sends.push(message); } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
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
  const deadline = Date.now() + 2000;
  while (sends.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(sends.length >= 3, 'stream running before the stop');

  let out;
  let doneError;
  node.emit('input', { payload: { action: 'stop' } }, (m) => { out = m; }, (err) => { doneError = err; });

  assert.equal(doneError, undefined);
  const brake = sends[sends.length - 1];
  assert.equal(brake.fields.type_mask, 3527, 'stop sends the brake');
  assert.equal(brake.fields.vx, 0);
  // One input, one trigger: a stop input succeeding fires the continue port.
  assert.ok(out[0], 'stop fires output 0');
  assert.equal(out[1].result, 'stopped');
  assert.equal(out[1].detail, null);
  assert.equal(out[1].message.fields.type_mask, 3527, 'record carries the brake');
  // Every send before the brake was an accepted setpoint.
  assert.equal(out[1].sent, sends.length - 1, 'sent counts setpoints, not the brake');

  const after = sends.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sends.length, after, 'the stream halted');
  node.emit('close', () => {});
  assert.equal(sends.length, after, 'nothing left for close to brake');
});

test('mavlink-move stream: stop with nothing running reports stopped with detail "no stream"', () => {
  const sends = [];
  const conn = { vehicle: {}, send(message) { sends.push(message); } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  });

  // A stop control must not punish a second press (§ "Move setpoint matrix").
  let out;
  let doneError;
  node.emit('input', { payload: { action: 'stop' } }, (m) => { out = m; }, (err) => { doneError = err; });

  assert.equal(doneError, undefined, 'stop with nothing running is not an error');
  assert.ok(out[0], 'still fires output 0');
  assert.equal(out[1].result, 'stopped');
  assert.equal(out[1].detail, 'no stream');
  assert.equal(sends.length, 0, 'nothing running, so nothing sent');
});

test('mavlink-move send delivery refuses {action:"stop"} — only the stream tier owns streams', () => {
  const conn = { vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'send',
    action: 'steer',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
  });

  let out;
  let doneError;
  node.emit('input', { payload: { action: 'stop' } }, (m) => { out = m; }, (err) => { doneError = err; });

  assert.equal(out[0], null);
  assert.equal(out[1].result, 'failed');
  assert.match(doneError.message, /requires stream delivery/);
});

test('mavlink-move: an unknown action throws naming the valid actions', () => {
  const conn = { vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  });

  let out;
  let doneError;
  node.emit('input', { payload: { action: 'hover' } }, (m) => { out = m; }, (err) => { doneError = err; });

  assert.equal(out[0], null);
  assert.equal(out[1].result, 'failed');
  assert.match(doneError.message, /unknown Move action "hover"/);
  assert.match(doneError.message, /stop/, 'names the valid actions');
});

test('mavlink-move stream: {action:"stop"} releases the target for a new stream (#176)', () => {
  const conn = { id: 'conn', vehicle: {}, send() {} };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const cfg = {
    delivery: 'stream',
    action: 'steer',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  };
  const a = new Node({ ...cfg });
  const b = new Node({ ...cfg });

  a.emit('input', { payload: {} }, () => {}, () => {});
  let refused;
  b.emit('input', { payload: {} }, (m) => { refused = m; }, () => {});
  assert.equal(refused[1].result, 'failed', 'target held while a streams');

  let stopped;
  a.emit('input', { payload: { action: 'stop' } }, (m) => { stopped = m; }, () => {});
  assert.equal(stopped[1].result, 'stopped');

  let after;
  b.emit('input', { payload: {} }, (m) => { after = m; }, () => {});
  assert.equal(after[1].result, 'streaming', 'stop freed the target');
  b.emit('close', () => {});
  a.emit('close', () => {});
});

test('mavlink-move advisory dedup: one warn per streak, cleared by a clean input (C8)', () => {
  const make = () => {
    // Firmware rides the connection's Vehicle Profile, so the stub's profile
    // is mutable per input — a real flow's connection can rebind too.
    const conn = { vehicle: { firmware: 'px4' }, send() {} };
    const RED = redStub({ conn });
    require('../../nodes/mavlink-move')(RED);
    const Node = RED.nodes.types['mavlink-move'];
    const node = new Node({
      delivery: 'send',
      action: 'steer',
      connection: 'conn',
      targetSystem: 1,
      targetComponent: 1,
    });
    const warns = [];
    node.warn = (text) => { warns.push(text); };
    return { node, conn, warns };
  };
  // A: PX4 body reference derives BODY_NED (8) — position discarded (§14).
  const bodyOnPx4 = { reference: 'body', velocity: { north: 1, east: 0, up: 0 } };
  // B: ArduPilot absolute-yaw yaw-only — held heading in measurement (§14).
  const yawOnAp = { yaw: 90 };
  // Clean: world velocity works everywhere.
  const clean = { velocity: { north: 1, east: 0, up: 0 } };

  // A refresh-fed stream repeating the same combo must not spam the sidebar —
  // noise gets ignored, which defeats the advisory's whole purpose.
  let s = make();
  s.node.emit('input', { payload: bodyOnPx4 }, () => {}, () => {});
  s.node.emit('input', { payload: bodyOnPx4 }, () => {}, () => {});
  assert.equal(s.warns.length, 1, 'same advisory twice → exactly one warn');
  assert.match(s.warns[0], /BODY_NED/);

  // Only consecutive repeats dedup: a change is news, and so is the return.
  s = make();
  s.node.emit('input', { payload: bodyOnPx4 }, () => {}, () => {});
  s.conn.vehicle.firmware = 'ardupilot';
  s.node.emit('input', { payload: yawOnAp }, () => {}, () => {});
  s.conn.vehicle.firmware = 'px4';
  s.node.emit('input', { payload: bodyOnPx4 }, () => {}, () => {});
  assert.equal(s.warns.length, 3, 'advisory A, B, A → three warns');
  assert.match(s.warns[1], /yaw-only/);

  // A clean input clears the memory, so the advisory's next appearance warns.
  s = make();
  s.node.emit('input', { payload: bodyOnPx4 }, () => {}, () => {});
  s.node.emit('input', { payload: clean }, () => {}, () => {});
  s.node.emit('input', { payload: bodyOnPx4 }, () => {}, () => {});
  assert.equal(s.warns.length, 2, 'advisory, clean, same advisory → two warns');
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
        node.warn = () => {};
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

test('mavlink-move stream: expiry brake failure keeps the documented discriminator (Codex, #240)', async () => {
  // A flow following the node help switches on result === 'expired'. The one
  // moment recovery matters most — the brake never reached the wire — is
  // exactly when that switch must still match; the failure rides its own
  // brakeError field instead.
  const conn = {
    id: 'conn',
    vehicle: {},
    // The brake is deliberately shaped like a velocity setpoint (same mask
    // 3527), so the stub tells them apart by the commanded velocity: the
    // streamed setpoint carries vx=1, the brake vx=0.
    send(message) {
      if (message.fields.vx === 0) throw new Error('link down');
    },
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
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
  node.emit('input', { payload: {} }, () => {}, () => {});

  const deadline = Date.now() + 2000;
  while (!emitted.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(emitted[0][1].result, 'expired', 'the discriminator survives the brake failure');
  assert.match(emitted[0][1].brakeError, /link down/);
  assert.equal(typeof emitted[0][1].sent, 'number');
  node.emit('close', () => {});
});

test('mavlink-move stream: a failed handover send leaves the old stream running (Codex, #240)', () => {
  // The replacement's initial send throwing must not leave the vehicle with
  // no retrying stream and no brake — the old stream keeps the slot.
  const sends = [];
  let failNext = false;
  const conn = {
    id: 'conn',
    vehicle: {},
    send(message) {
      if (failNext) { failNext = false; throw new Error('identity unresolved'); }
      sends.push(message);
    },
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  });

  node.emit('input', { payload: {} }, () => {}, () => {});
  assert.equal(sends.length, 1, 'old stream started');

  failNext = true;
  let failed;
  let doneErr;
  node.emit('input', { payload: { velocity: { north: 2, east: 0, up: 0 } } }, (m) => { failed = m; }, (err) => { doneErr = err; });
  assert.match(doneErr.message, /identity unresolved/);
  assert.equal(failed[1].result, 'failed');

  // The old stream still owns the slot: close brakes it — a dead stream
  // would have nothing to brake.
  node.emit('close', () => {});
  assert.equal(sends.length, 2, 'close braked the surviving stream');
  assert.equal(sends[1].fields.type_mask, 3527);
  assert.equal(sends[1].fields.vx, 0);
});

test('mavlink-move stream: a retarget brakes the old target after the new stream is live (Codex, #240)', () => {
  // Same-target replacement hands over brakeless; a retarget ends control of
  // the OLD target, so that vehicle gets the brake — after the new stream's
  // first send succeeded.
  const sends = [];
  const conn = { id: 'conn', vehicle: {}, send(message) { sends.push(message); } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'stream',
    action: 'steer',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  });

  node.emit('input', { payload: {} }, () => {}, () => {});
  node.emit('input', { payload: { target: { sysid: 2, compid: 1 } } }, () => {}, () => {});

  assert.equal(sends.length, 3, 'setpoint, handover setpoint, old-target brake');
  assert.equal(sends[0].fields.target_system, 1);
  assert.equal(sends[1].fields.target_system, 2, 'the new stream sends before the old is stopped');
  assert.equal(sends[2].fields.target_system, 1, 'the brake goes to the abandoned target');
  assert.equal(sends[2].fields.type_mask, 3527);
  node.emit('close', () => {});
});

test('mavlink-move stream: a failed retarget frees only the new scope, old stream keeps its own (Codex, #240)', () => {
  let failNext = false;
  const conn = {
    id: 'conn',
    vehicle: {},
    send() {
      if (failNext) { failNext = false; throw new Error('identity unresolved'); }
    },
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const cfg = {
    delivery: 'stream',
    action: 'steer',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    rateHz: 0.1,
    ttlMs: 0,
  };
  const a = new Node({ ...cfg });
  const b = new Node({ ...cfg });

  a.emit('input', { payload: {} }, () => {}, () => {});
  failNext = true;
  let doneErr;
  a.emit('input', { payload: { target: { sysid: 2, compid: 1 } } }, () => {}, (err) => { doneErr = err; });
  assert.match(doneErr.message, /identity unresolved/);

  // Target 1 is still held by a's surviving stream; target 2 was released on
  // the way out of the failed retarget.
  let held;
  b.emit('input', { payload: {} }, (m) => { held = m; }, () => {});
  assert.match(held[1].detail, /already running/);
  let freed;
  b.emit('input', { payload: { target: { sysid: 2, compid: 1 } } }, (m) => { freed = m; }, () => {});
  assert.equal(freed[1].result, 'streaming', 'the failed retarget freed its scope');
  a.emit('close', () => {});
  b.emit('close', () => {});
});

// ── Reposition carrier (#239): COMMAND_INT / DO_REPOSITION ─────────────────

/** Fake wire connection with the subscribe/resolveSourceIds surface the
 *  confirm tier's AckWaiter consumes. */
function repositionConn() {
  const sends = [];
  const subs = [];
  return {
    id: 'conn',
    vehicle: {},
    sends,
    subs,
    send(message, opts) { sends.push({ message, opts }); },
    subscribe(filter, handler) { subs.push({ filter, handler }); return () => {}; },
    resolveSourceIds() { return { sysid: 255, compid: 190 }; },
  };
}

const repositionCfg = {
  action: 'goto',
  altRef: 'home',
  lat: 47.1234567,
  lon: 8.5,
  alt: 25,
  targetSystem: 1,
  targetComponent: 1,
};

test('mavlink-move reposition Build tier emits the COMMAND_INT without sending', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, delivery: 'build', dialect: 'common' });

  let sent;
  node.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});

  assert.equal(sent[0].payload.name, 'COMMAND_INT');
  assert.equal(sent[0].payload.fields.command, 192);
  assert.equal(sent[0].payload.fields.frame, 3);
  assert.equal(sent[0].payload.fields.x, 471234567);
  assert.equal(sent[0].payload.fields.y, 85000000);
  assert.equal(sent[0].payload.fields.z, 25);
  assert.equal(sent[0].payload.fields.param1, -1, 'blank speed sentinel');
  assert.ok(Number.isNaN(sent[0].payload.fields.param4), 'blank yaw sentinel');
  assert.equal(sent[1].result, 'built');
  assert.equal(sent[1].detail, null);
});

test('mavlink-move reposition Send tier rides the Control band, not Streaming', () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, delivery: 'send', connection: 'conn' });

  let sent;
  node.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});

  assert.equal(conn.sends.length, 1);
  assert.equal(conn.sends[0].message.name, 'COMMAND_INT');
  // BAND.CONTROL is 2; setpoints ride STREAMING (3).
  assert.equal(conn.sends[0].opts.band, 2, 'commands ride the Control band');
  assert.equal(sent[1].result, 'sent');
  assert.equal(sent[1].detail, null);
});

test('mavlink-move retired overrides refuse loud: payload carrier/mode/frame/px4Compat throw, nothing reaches the wire', () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    delivery: 'send',
    action: 'steer',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
  });

  // A payload written for the old surface must not be silently reinterpreted
  // into the wrong wire message — every retired key refuses, naming the new
  // vocabulary, before anything is built or sent.
  const retired = [
    { carrier: 'reposition' },
    { mode: 'velocity' },
    { frame: 'LOCAL_NED' },
    { px4Compat: false },
  ];
  for (const payload of retired) {
    const key = Object.keys(payload)[0];
    let out;
    let doneError;
    node.emit('input', { payload }, (m) => { out = m; }, (err) => { doneError = err; });
    assert.equal(out[0], null, `payload.${key} must not fire the continue port`);
    assert.equal(out[1].result, 'failed', `payload.${key} fails the input`);
    assert.match(doneError.message, new RegExp(`msg\\.payload\\.${key} is retired`), `payload.${key} refuses by name`);
    assert.match(doneError.message, /action-shaped overrides/, 'the error teaches the new vocabulary');
  }
  assert.equal(conn.sends.length, 0, 'nothing reached the wire');

  // The new vocabulary on the same node still works.
  node.emit('input', { payload: {} }, () => {}, () => {});
  assert.equal(conn.sends[0].message.name, 'SET_POSITION_TARGET_LOCAL_NED');
});

test('mavlink-move goto + Stream streams global position setpoints on the *_INT twin; command-path params refuse and leave it running', async () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({
    ...repositionCfg,
    delivery: 'stream',
    connection: 'conn',
    rateHz: 200,
    ttlMs: 0,
  });

  // goto + Stream: the same intent, streamed — the wire is the setpoint twin
  // of the altitude reference, always the *_INT number (§6 redesign).
  let started;
  node.emit('input', { payload: {} }, (m) => { started = m; }, () => {});
  assert.equal(started[1].result, 'streaming');
  assert.equal(conn.sends[0].message.name, 'SET_POSITION_TARGET_GLOBAL_INT');
  assert.equal(conn.sends[0].message.fields.coordinate_frame, 6, 'altRef home streams the *_INT twin');
  assert.equal(conn.sends[0].message.fields.lat_int, 471234567);
  let deadline = Date.now() + 2000;
  while (conn.sends.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(conn.sends.length >= 2, 'stream running before the bad input');

  // speed/radius/changeMode belong to the command path — a streamed setpoint
  // cannot carry them, and the refusal must leave the running stream running.
  for (const payload of [{ speed: 5 }, { radius: 80 }, { changeMode: true }]) {
    const key = Object.keys(payload)[0];
    let out;
    let doneError;
    node.emit('input', { payload }, (m) => { out = m; }, (err) => { doneError = err; });
    assert.equal(out[0], null, `payload.${key} must not fire the continue port`);
    assert.equal(out[1].result, 'failed');
    assert.match(doneError.message, new RegExp(`payload\\.${key} belongs to the Go to command path`));
  }

  const before = conn.sends.length;
  deadline = Date.now() + 2000;
  while (conn.sends.length < before + 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  node.emit('close', () => {});
  assert.ok(conn.sends.length >= before + 2, 'the stream survived the refused command params');
});

test('mavlink-move goto + Send refuses a yaw rate through the reposition builder\'s own guard', () => {
  // DO_REPOSITION carries a yaw heading only: the node adds no second guard —
  // buildRepositionMessage's refusal is the single deploy-time error path.
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, delivery: 'send', connection: 'conn' });

  let out;
  let doneError;
  node.emit('input', { payload: { yawRate: 10 } }, (m) => { out = m; }, (err) => { doneError = err; });
  assert.equal(out[0], null);
  assert.equal(out[1].result, 'failed');
  assert.match(doneError.message, /no yaw rate/);
  assert.equal(conn.sends.length, 0, 'nothing reached the wire');
});

test('mavlink-move steer refuses Send & confirm — setpoints carry no ack', () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  // The editor never offers confirm on steer; the runtime refuses it loud
  // rather than waiting on an acknowledgement that cannot exist (§9).
  const node = new Node({
    delivery: 'confirm',
    action: 'steer',
    vNorth: 1,
    vEast: 0,
    vUp: 0,
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
  });

  let out;
  let doneError;
  node.emit('input', { payload: {} }, (m) => { out = m; }, (err) => { doneError = err; });
  assert.equal(out[0], null);
  assert.equal(out[1].result, 'failed');
  assert.match(doneError.message, /Send & confirm exists on the Go to action only/);
  assert.equal(conn.sends.length, 0, 'nothing reached the wire');
});

test('mavlink-move steer body reference derives the frame from the connection firmware and fails closed without one (§14)', () => {
  const make = (firmware) => {
    const conn = { vehicle: firmware ? { firmware } : {}, sends: [], send(message) { this.sends.push(message); } };
    const RED = redStub({ conn });
    require('../../nodes/mavlink-move')(RED);
    const Node = RED.nodes.types['mavlink-move'];
    const node = new Node({
      delivery: 'send',
      action: 'steer',
      reference: 'body',
      vNorth: 1,
      vEast: 0,
      vUp: 0,
      connection: 'conn',
      targetSystem: 1,
      targetComponent: 1,
    });
    return { node, conn };
  };

  // Measured (§14 2026-08-05): the stacks read different body frames.
  const ap = make('ardupilot');
  ap.node.emit('input', { payload: {} }, () => {}, () => {});
  assert.equal(ap.conn.sends[0].fields.coordinate_frame, 9, 'ArduPilot body rides BODY_OFFSET_NED');

  const px4 = make('px4');
  px4.node.emit('input', { payload: {} }, () => {}, () => {});
  assert.equal(px4.conn.sends[0].fields.coordinate_frame, 8, 'PX4 body rides BODY_NED');

  // No firmware fails closed — an unadapted guess would be silently dropped.
  const bare = make(null);
  let out;
  let doneError;
  bare.node.emit('input', { payload: {} }, (m) => { out = m; }, (err) => { doneError = err; });
  assert.equal(out[0], null);
  assert.equal(out[1].result, 'failed');
  assert.match(doneError.message, /Vehicle Profile with firmware ardupilot or px4/);
  assert.equal(bare.conn.sends.length, 0, 'nothing reached the wire');
});

test('mavlink-move reposition confirm: ACCEPTED fires continue with resultCode 0', async () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, delivery: 'confirm', connection: 'conn' });

  let out;
  let doneError;
  let doneCalled = false;
  node.emit('input', { payload: {} }, (m) => { out = m; }, (err) => { doneCalled = true; doneError = err; });

  // The waiter sends synchronously and subscribes to COMMAND_ACK.
  assert.equal(conn.sends.length, 1);
  assert.equal(conn.sends[0].message.name, 'COMMAND_INT');
  assert.equal(conn.subs.length, 1);
  assert.equal(conn.subs[0].filter.message, 'COMMAND_ACK');

  conn.subs[0].handler({ sysid: 1, compid: 1, fields: { command: 192, result: 0 } });
  const deadline = Date.now() + 2000;
  while (!doneCalled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(doneError, undefined);
  assert.ok(out[0], 'ACCEPTED fires the continue port');
  assert.equal(out[0].payload.result, 'accepted');
  assert.equal(out[0].payload.resultCode, 0);
  assert.equal(out[1].result, 'accepted');
  assert.equal(out[1].detail, null);
  assert.equal(out[1].confirmedBy, 'ack');
  assert.equal(out[1].resultCode, 0);
  assert.equal(out[1].message.fields.command, 192);
  node.emit('close', () => {});
});

test('mavlink-move reposition confirm: COMMAND_INT_ONLY and UNSUPPORTED_MAV_FRAME surface as verbatim MAV_RESULT names', async () => {
  // The two wrong-carrier/wrong-frame answers the issue names must surface
  // with their MAV_RESULT name as the result, and their code — never silence,
  // never a silent resend. Same words the AckWaiter (and mavlink-command)
  // publish: one vocabulary, no translation layer.
  const cases = [
    { result: 8, name: 'command_int_only' },
    { result: 9, name: 'command_unsupported_mav_frame' },
    { result: 2, name: 'denied' },
  ];
  for (const { result, name } of cases) {
    const conn = repositionConn();
    const RED = redStub({ conn });
    require('../../nodes/mavlink-move')(RED);
    const Node = RED.nodes.types['mavlink-move'];
    const node = new Node({ ...repositionCfg, delivery: 'confirm', connection: 'conn' });

    let out;
    let doneError;
    node.emit('input', { payload: {} }, (m) => { out = m; }, (err) => { doneError = err; });
    conn.subs[0].handler({ sysid: 1, compid: 1, fields: { command: 192, result } });
    const deadline = Date.now() + 2000;
    while (!doneError && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(out[0], null, `${name} must not fire continue`);
    assert.equal(out[1].result, name, `${name} is the result, verbatim`);
    assert.equal(out[1].resultCode, result, `${name} carries its MAV_RESULT code`);
    assert.equal(out[1].detail, null, 'the name lives in result, not detail');
    assert.equal(out[1].confirmedBy, 'ack');
    assert.match(doneError.message, new RegExp(name));
    node.emit('close', () => {});
  }
});

test('mavlink-move reposition confirm: a missing ack reports unconfirmed', async () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  // ackTimeout is the Command-style bound on the wait; blank inherits 10 s.
  const node = new Node({ ...repositionCfg, delivery: 'confirm', connection: 'conn', ackTimeout: 20 });

  let out;
  let doneError;
  node.emit('input', { payload: {} }, (m) => { out = m; }, (err) => { doneError = err; });
  const deadline = Date.now() + 2000;
  while (!doneError && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(out[0], null, 'a lost ack must not fire continue');
  assert.equal(out[1].result, 'unconfirmed');
  assert.equal(out[1].confirmedBy, 'none');
  assert.equal(out[1].resultCode, null);
  // A re-sent goto is the same goto, so this carrier opts into the timeout
  // re-send the library leaves off by default (#249): initial send plus 3.
  assert.equal(conn.sends.length, 4, 'the silent windows re-send the reposition');
  assert.equal(out[1].retries, 3);
  assert.match(doneError.message, /timed out waiting for COMMAND_ACK/);
  node.emit('close', () => {});
});

test('mavlink-move reposition confirm refuses a broadcast target (sysid 0): nothing sent, failed record, done(err) (#260)', () => {
  // The ack matcher accepts any source at sysid 0 — the first vehicle to
  // answer would settle the goto for the whole fleet. Thrown before any send
  // or subscription, through the same failInput path as the carrier refusals.
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, targetSystem: 0, delivery: 'confirm', connection: 'conn' });

  let out;
  let doneError;
  node.emit('input', { payload: {} }, (m) => { out = m; }, (err) => { doneError = err; });

  assert.equal(conn.sends.length, 0, 'nothing reached the wire');
  assert.equal(conn.subs.length, 0, 'no COMMAND_ACK subscription opened');
  assert.equal(out[0], null, 'output 0 must not fire');
  assert.equal(out[1].result, 'failed');
  assert.match(out[1].detail, /broadcast \(sysid 0\)/);
  assert.ok(doneError instanceof Error);
});

test('mavlink-move reposition confirm: close cancels the wait quietly', async () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, delivery: 'confirm', connection: 'conn' });

  let out;
  let doneError;
  let doneCalled = false;
  node.emit('input', { payload: {} }, (m) => { out = m; }, (err) => { doneCalled = true; doneError = err; });
  node.emit('close', () => {});
  const deadline = Date.now() + 2000;
  while (!doneCalled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // A redeploy is not a failed command: no error, no record.
  assert.ok(doneCalled, 'the cancelled input still completes');
  assert.equal(doneError, undefined);
  assert.equal(out, undefined, 'no outcome is emitted for a torn-down node');
});

test('mavlink-move reposition confirm: a second goto supersedes the first wait quietly', async () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, delivery: 'confirm', connection: 'conn' });

  const first = { out: undefined, err: undefined, done: false };
  node.emit(
    'input',
    { payload: {} },
    (m) => { first.out = m; },
    (err) => { first.done = true; first.err = err; }
  );
  assert.equal(conn.sends.length, 1, 'the first goto is on the wire');

  // A new goto arrives while the first is still waiting for its ack: the
  // superseded wait is not a failed command, and the new one is a fresh
  // COMMAND_INT with its own ack wait.
  const second = { out: undefined, err: undefined, done: false };
  node.emit(
    'input',
    { payload: { position: { lat: 47.5, lon: 8.5, alt: 30 } } },
    (m) => { second.out = m; },
    (err) => { second.done = true; second.err = err; }
  );

  assert.equal(conn.sends.length, 2, 'the second goto sent its own COMMAND_INT');
  assert.equal(conn.sends[1].message.name, 'COMMAND_INT');
  assert.equal(conn.sends[1].message.fields.x, 475000000, 'the new position is what went out');
  assert.equal(conn.subs.length, 2, 'the second wait has its own subscription');

  conn.subs[1].handler({ sysid: 1, compid: 1, fields: { command: 192, result: 0 } });
  const deadline = Date.now() + 2000;
  while (!(first.done && second.done) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // The superseded input completes through the 'cancelled' branch: no error,
  // no record, nothing on continue.
  assert.ok(first.done, 'the superseded input still completes');
  assert.equal(first.err, undefined);
  assert.equal(first.out, undefined, 'no outcome is emitted for the superseded goto');
  // The replacement runs to its ack normally.
  assert.ok(second.done, 'the replacement input completes after its ACK');
  assert.equal(second.err, undefined);
  assert.equal(second.out[0].payload.result, 'accepted');
  assert.equal(second.out[1].result, 'accepted');
  assert.equal(second.out[1].detail, null);
  node.emit('close', () => {});
});

test('mavlink-move reposition CHANGE_MODE wiring: config opt-in, payload boolean override', () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, delivery: 'send', connection: 'conn', changeMode: true });

  node.emit('input', { payload: {} }, () => {}, () => {});
  assert.equal(conn.sends[0].message.fields.param2, 1, 'checkbox opt-in sets the flag');
  node.emit('input', { payload: { changeMode: false } }, () => {}, () => {});
  assert.equal(conn.sends[1].message.fields.param2, 0, 'payload false overrides the checkbox');

  let doneError;
  node.emit('input', { payload: { changeMode: 'yes' } }, () => {}, (err) => { doneError = err; });
  assert.match(doneError.message, /changeMode must be boolean/, 'a truthy token refuses');
});

test('mavlink-move reposition confirm: IN_PROGRESS moves the badge and result_param2 joins the record (§9)', async () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, delivery: 'confirm', connection: 'conn' });
  const statuses = [];
  node.status = (s) => statuses.push(s.text);

  let out;
  let doneCalled = false;
  node.emit('input', { payload: {} }, (m) => { out = m; }, () => { doneCalled = true; });

  conn.subs[0].handler({ sysid: 1, compid: 1, fields: { command: 192, result: 5, progress: 60 } });
  assert.ok(statuses.some((text) => text.includes('reposition 60%')), 'badge follows the vehicle');

  conn.subs[0].handler({ sysid: 1, compid: 1, fields: { command: 192, result: 2, result_param2: 4 } });
  const deadline = Date.now() + 2000;
  while (!doneCalled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(out[1].result, 'denied');
  assert.equal(out[1].resultCode, 2);
  assert.equal(out[1].resultParam2, 4, 'the denial reason reaches the status record');
  node.emit('close', () => {});
});

// ── Coupling pin: the SITL verdict against REAL Move status records ──────────
//
// Move's and Command's result vocabularies are now unified: the reposition
// confirm tier passes the AckWaiter outcome.result through verbatim, exactly
// like mavlink-command — 'accepted' for MAV_RESULT_ACCEPTED, the MAV_RESULT
// name for every terminal refusal ('denied', 'command_int_only', …), and
// 'unconfirmed' for a lost ack. 'succeeded' is banned from this node: it once
// meant both "on the wire" and "the vehicle agreed", which is how silence
// could classify as success. These pins drive the real node and feed its real
// record to the real verdictFrom, so any drift back toward 'succeeded' — in
// either the node or the harness — fails here first. Only the debug tag is
// authored, because that genuinely is flow configuration.

const { PROFILE, verdictFrom } = require('../../sitl/run-example-suite');

/** Wrap a real Move status record the way the SITL harness scrapes it. */
function asRepositionSummary(record) {
  return {
    debug: [
      { tag: 'debug:arm status', result: 'accepted', detail: null, resultCode: 0, excerpt: '' },
      { ...record, tag: 'debug:reposition status (resultCode + retries)', excerpt: '' },
    ],
    errors: [],
  };
}

test('SITL 37/38 verdicts read the record mavlink-move actually emits (accepted)', async () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, delivery: 'confirm', connection: 'conn' });

  let out;
  let doneCalled = false;
  node.emit('input', { payload: {} }, (m) => { out = m; }, () => { doneCalled = true; });
  conn.subs[0].handler({ sysid: 1, compid: 1, fields: { command: 192, result: 0 } });
  const deadline = Date.now() + 2000;
  while (!doneCalled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  node.emit('close', () => {});

  assert.equal(out[1].result, 'accepted', "the record says 'accepted', never 'succeeded'");
  const summary = asRepositionSummary(out[1]);
  // Both examples must call a real acceptance a pass. 37 asserting AP accepts
  // is the case that was dead on arrival.
  assert.equal(verdictFrom(PROFILE['27-move-reposition-carrier'], summary, '').status, 'PASS');
  assert.equal(verdictFrom(PROFILE['30-px4-move-reposition'], summary, '').status, 'PASS');
});

test('SITL 37/38 verdicts read the record mavlink-move actually emits (no ack)', async () => {
  const conn = repositionConn();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  const node = new Node({ ...repositionCfg, delivery: 'confirm', connection: 'conn', ackTimeout: 20 });

  let out;
  let doneError;
  node.emit('input', { payload: {} }, (m) => { out = m; }, (err) => { doneError = err; });
  const deadline = Date.now() + 2000;
  while (!doneError && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  node.emit('close', () => {});

  assert.equal(out[1].result, 'unconfirmed', 'silence is unconfirmed, the shared word');
  const summary = asRepositionSummary(out[1]);
  // Silence measures nothing, on the asserting example and the measuring one
  // alike. This is the case that classified PASS on 38.
  for (const key of ['27-move-reposition-carrier', '30-px4-move-reposition']) {
    const verdict = verdictFrom(PROFILE[key], summary, '');
    assert.equal(verdict.status, 'FAIL', `${key} must not pass without an ack`);
    assert.match(verdict.reason, /no ACK|unconfirmed|timeout/i);
  }
});
