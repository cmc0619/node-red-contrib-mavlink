'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-payload node builds command-backed payload messages', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'build',
    dialect: 'common',
    topic: 'servo',
    verb: 'set',
    targetSystem: 7,
    targetComponent: 1,
  });
  let sent;

  node.emit(
    'input',
    { payload: { values: { servo: 8, pwm: 1600 } } },
    (messages) => {
      sent = messages;
    },
    () => {}
  );

  assert.equal(sent[0].payload.name, 'COMMAND_LONG');
  assert.equal(sent[0].payload.fields.command, 183);
  assert.equal(sent[0].payload.fields.param2, 1600);
  assert.equal(sent[1].confirmation, 'command_ack');
});

test('the retired carrier config key is not read: a flow saving only carrier fails the build loud', () => {
  // Pre-1.0 rename, delete-and-repick: the choice moved from `carrier` to
  // `sendAs` with no alias or dual-read. A flow still carrying only the old
  // key builds with no choice at all, which the command builder refuses.
  const RED = redStub({});
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    carrier: 'long',
    delivery: 'build',
    dialect: 'common',
    topic: 'servo',
    verb: 'set',
    targetSystem: 7,
    targetComponent: 1,
  });
  let sent;
  let doneErr;

  node.emit(
    'input',
    { payload: { values: { servo: 8, pwm: 1600 } } },
    (messages) => { sent = messages; },
    (err) => { doneErr = err; }
  );

  assert.equal(sent[0], null, 'no built message from the old key alone');
  assert.equal(sent[1].result, 'failed');
  assert.match(doneErr.message, /requires carrier 'int' or 'long'/);
});

test('mavlink-payload reuses its deploy-resolved Connection during input delivery', () => {
  const conn = connStub();
  conn.vehicle = { targetSystem: 7, targetComponent: 1 };
  const RED = redStub({ conn });
  const getNode = RED.nodes.getNode.bind(RED.nodes);
  let connectionLookups = 0;
  RED.nodes.getNode = (id) => {
    if (id === 'conn') connectionLookups++;
    return getNode(id);
  };
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'send',
    topic: 'servo',
    verb: 'set',
    connection: 'conn',
    targetSystem: 7,
    targetComponent: 1,
    timeout: 10000,
    maxRetries: 3,
  });

  node.emit(
    'input',
    { payload: { values: { servo: 8, pwm: 1600 } } },
    () => {},
    () => {}
  );

  assert.equal(connectionLookups, 1, 'Connection is resolved once at deploy');
  assert.equal(conn.sent.length, 1);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('mavlink-payload confirm tier waits for COMMAND_ACK and continues only on ACCEPTED', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'confirm',
    topic: 'servo',
    verb: 'set',
    connection: 'conn',
    targetSystem: 7,
    targetComponent: 1,
    timeout: 2000,
  });

  let sent;
  node.emit('input', { payload: { values: { servo: 8, pwm: 1600 } } }, (m) => { sent = m; }, () => {});
  await tick();

  // The command was enqueued but no output has fired yet — still awaiting ACK.
  assert.equal(conn.sent.length, 1);
  assert.equal(conn.sent[0].message.fields.command, 183);
  assert.equal(sent, undefined, 'no output before the ack arrives');

  conn.injectAck({ command: 183, result: 0 }, 7, 1);
  await tick();

  assert.ok(sent, 'outputs fire once the ack arrives');
  assert.equal(sent[0].payload.result, 'succeeded', 'output 0 continues on ACCEPTED');
  assert.equal(sent[1].result, 'succeeded');
  assert.equal(sent[1].confirmedBy, 'ack');

  node.emit('close', () => {});
});

test('mavlink-payload confirm tier with carrier int sends COMMAND_INT without a confirmation byte (§9)', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'int',
    delivery: 'confirm',
    topic: 'gimbal',
    verb: 'roi-set',
    connection: 'conn',
    targetSystem: 7,
    targetComponent: 1,
    timeout: 2000,
  });

  let sent;
  node.emit('input', { payload: { values: { lat: -35, lon: 149, alt: 50 } } }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(conn.sent.length, 1);
  const message = conn.sent[0].message;
  assert.equal(message.name, 'COMMAND_INT');
  assert.equal(message.fields.command, 195);
  assert.equal(message.fields.x, -350000000, 'degrees scaled to degE7');
  assert.equal(message.fields.y, 1490000000);
  // The AckWaiter's sendFn must not graft the LONG carrier's confirmation
  // byte onto a COMMAND_INT (§9).
  assert.equal('confirmation' in message.fields, false);

  conn.injectAck({ command: 195, result: 0 }, 7, 1);
  await tick();
  assert.ok(sent, 'outputs fire once the ack arrives');
  assert.equal(sent[1].result, 'succeeded');

  node.emit('close', () => {});
});

test('mavlink-payload confirm refuses a broadcast target (sysid 0): nothing sent, failed record, done(err) (#260)', async () => {
  // First responder would settle for the fleet — and the carrier-swap could
  // then re-broadcast the command off one stray wrong-carrier ack.
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'confirm',
    topic: 'servo',
    verb: 'set',
    connection: 'conn',
    targetSystem: 0,
    targetComponent: 1,
    timeout: 2000,
  });

  let out;
  let doneError;
  node.emit('input', { payload: { values: { servo: 8, pwm: 1600 } } }, (m) => { out = m; }, (e) => { doneError = e; });
  await tick();

  assert.equal(conn.sent.length, 0, 'nothing sent to the connection');
  assert.equal(conn.subs.length, 0, 'no COMMAND_ACK subscription opened');
  assert.equal(out[0], null, 'output 0 must not fire');
  assert.equal(out[1].result, 'failed');
  assert.match(out[1].detail, /broadcast \(sysid 0\)/);
  assert.ok(doneError instanceof Error);

  node.emit('close', () => {});
});

test('mavlink-payload confirm tier halts the chain on a DENIED ack', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'confirm',
    topic: 'servo',
    verb: 'set',
    connection: 'conn',
    targetSystem: 7,
    targetComponent: 1,
    timeout: 2000,
  });

  let sent;
  node.emit('input', { payload: { values: { servo: 8, pwm: 1600 } } }, (m) => { sent = m; }, () => {});
  await tick();

  conn.injectAck({ command: 183, result: 2 }, 7, 1);
  await tick();

  assert.equal(sent[0], null, 'output 0 must not continue on DENIED');
  assert.equal(sent[1].result, 'denied');

  node.emit('close', () => {});
});

test('a denied Payload verb carries the ack\'s result_param2 (§9, Codex)', async () => {
  // §9 requires *every* ack-confirmed status record to carry the terminal
  // ack's result_param2 — not just Command's and Move's. A gimbal denial that
  // came with a reason must not reach the operator as a bare 'denied'.
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'confirm',
    topic: 'servo',
    verb: 'set',
    connection: 'conn',
    targetSystem: 7,
    targetComponent: 1,
    timeout: 2000,
  });

  let sent;
  node.emit('input', { payload: { values: { servo: 8, pwm: 1600 } } }, (m) => { sent = m; }, () => {});
  await tick();

  conn.injectAck({ command: 183, result: 2, result_param2: 9 }, 7, 1);
  await tick();

  assert.equal(sent[1].result, 'denied');
  assert.equal(sent[1].resultParam2, 9, 'the denial reason reaches the Payload record');

  node.emit('close', () => {});
});

test('blank Payload timeout keeps the 10000 ms ACK window', async (t) => {
  const timers = installAckTimerHarness(t);
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'confirm',
    topic: 'servo',
    verb: 'set',
    connection: 'conn',
    targetSystem: 7,
    targetComponent: 1,
    timeout: '',
    maxRetries: 3,
  });

  node.emit(
    'input',
    { payload: { values: { servo: 8, pwm: 1600 } } },
    () => {},
    () => {}
  );

  assert.equal(timers.delays[0], 10000);
  conn.injectAck({ command: 183, result: 0 }, 7, 1);
  await new Promise((resolve) => setImmediate(resolve));
  node.emit('close', () => {});
});

test('blank Payload maxRetries keeps three temporary-rejection retries', async (t) => {
  installAckTimerHarness(t);
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'confirm',
    topic: 'servo',
    verb: 'set',
    connection: 'conn',
    targetSystem: 7,
    targetComponent: 1,
    timeout: 10000,
    maxRetries: '',
  });
  let output;

  node.emit(
    'input',
    { payload: { values: { servo: 8, pwm: 1600 } } },
    (messages) => { output = messages; },
    () => {}
  );
  for (let retry = 1; retry <= 3; retry++) {
    conn.injectAck({ command: 183, result: 1 }, 7, 1);
    await Promise.resolve();
    assert.equal(conn.sent.length, retry + 1, `retry ${retry} is sent`);
  }
  conn.injectAck({ command: 183, result: 1 }, 7, 1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    conn.sent.map(({ message }) => message.fields.confirmation),
    [0, 1, 2, 3]
  );
  assert.equal(output[0], null);
  assert.equal(output[1].retries, 3);
  node.emit('close', () => {});
});

test('mavlink-payload inherits Vehicle Profile target when config is empty', () => {
  const veh = { defaultTargetSystem: 42, defaultTargetComponent: 191 };
  const RED = redStub({ veh });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'build',
    dialect: '__vehicle',
    topic: 'servo',
    verb: 'set',
    targetSystem: '',
    targetComponent: '',
    vehicle: 'veh',
  });
  let sent;

  node.emit(
    'input',
    { payload: { values: { servo: 1, pwm: 1500 } } },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 42);
  assert.equal(sent[0].payload.fields.target_component, 191);
});

test('mavlink-payload explicit config value wins over Vehicle Profile', () => {
  const conn = { vehicle: { targetSystem: 42, targetComponent: 191 }, send() {}, subscribe() { return () => {}; } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'build',
    dialect: 'common',
    topic: 'servo',
    verb: 'set',
    targetSystem: 7,
    targetComponent: 100,
    connection: 'conn',
  });
  let sent;

  node.emit(
    'input',
    { payload: { values: { servo: 1, pwm: 1500 } } },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 7);
  assert.equal(sent[0].payload.fields.target_component, 100);
});

test('mavlink-payload gimbal manager setpoint stays unconfirmed even on the confirm tier', () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'confirm',
    topic: 'gimbal',
    verb: 'aim',
    path: 'manager',
    connection: 'conn',
    targetSystem: 2,
    targetComponent: 154,
  });

  let sent;
  node.emit('input', { payload: { values: { pitch: -15, yaw: 90 } } }, (m) => { sent = m; }, () => {});

  // No ACK is possible, so it is sent immediately with no subscription.
  assert.equal(conn.subs.length, 0, 'no COMMAND_ACK subscription for the manager setpoint');
  assert.equal(conn.sent.length, 1);
  assert.equal(conn.sent[0].message.name, 'GIMBAL_MANAGER_SET_PITCHYAW');
  assert.equal(sent[1].detail, 'sent (unconfirmed)');
});

test('mavlink-payload companion identity derives sysid; compid stays config-resolved (compidFromConfig)', () => {
  const sends = [];
  const conn = {
    vehicle: { targetSystem: 10, targetComponent: 2 },
    send(message, opts) { sends.push({ message, opts }); },
    resolveSourceIds: () => null,
    subscribe() { return () => {}; },
  };
  const comp1 = {
    derivesSysidFromVehicle: true,
    getIdentity: () => ({ sysid: 42, compid: 191 }),
  };
  const RED = redStub({ conn, comp1 });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'send',
    topic: 'servo',
    verb: 'set',
    identity: 'comp1',
    connection: 'conn',
    targetSystem: '',
    targetComponent: '',
  });

  node.emit('input', { payload: { values: { servo: 1, pwm: 1500 } } }, () => {}, () => {});

  assert.equal(sends.length, 1, 'message was sent');
  assert.equal(sends[0].opts.target.sysid, 42, 'sysid derived from companion airframe');
  // Payload's compid is config-resolved (companion does NOT pin it to 1)
  // With empty config targetComponent, falls back to connection profile (targetComponent: 2)
  assert.equal(sends[0].opts.target.compid, 2, 'compid from connection profile (compidFromConfig exception)');
});

test('mavlink-payload companion + explicit compid config → {companion sysid, config compid}', () => {
  const sends = [];
  const conn = {
    vehicle: { targetSystem: 10, targetComponent: 2 },
    send(message, opts) { sends.push({ message, opts }); },
    resolveSourceIds: () => null,
    subscribe() { return () => {}; },
  };
  const comp1 = {
    derivesSysidFromVehicle: true,
    getIdentity: () => ({ sysid: 42, compid: 191 }),
  };
  const RED = redStub({ conn, comp1 });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'send',
    topic: 'servo',
    verb: 'set',
    identity: 'comp1',
    connection: 'conn',
    targetSystem: '',
    targetComponent: 100,
  });

  node.emit('input', { payload: { values: { servo: 1, pwm: 1500 } } }, () => {}, () => {});

  assert.equal(sends[0].opts.target.sysid, 42, 'sysid derived from companion airframe');
  assert.equal(sends[0].opts.target.compid, 100, 'compid from node config (payload device address)');
});

test('mavlink-payload payload.target beats companion derivation', () => {
  const sends = [];
  const conn = {
    vehicle: { targetSystem: 10, targetComponent: 2 },
    send(message, opts) { sends.push({ message, opts }); },
    resolveSourceIds: () => null,
    subscribe() { return () => {}; },
  };
  const comp1 = {
    derivesSysidFromVehicle: true,
    getIdentity: () => ({ sysid: 42, compid: 191 }),
  };
  const RED = redStub({ conn, comp1 });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'send',
    topic: 'servo',
    verb: 'set',
    identity: 'comp1',
    connection: 'conn',
    targetSystem: '',
    targetComponent: '',
  });

  node.emit(
    'input',
    { payload: { target: { sysid: 99, compid: 50 }, values: { servo: 1, pwm: 1500 } } },
    () => {},
    () => {}
  );

  assert.equal(sends[0].opts.target.sysid, 99, 'payload.target.sysid beats companion');
  assert.equal(sends[0].opts.target.compid, 50, 'payload.target.compid beats companion');
});

test('mavlink-payload build tier inherits from config.vehicle stub', () => {
  const veh1 = { defaultTargetSystem: 77, defaultTargetComponent: 78 };
  const RED = redStub({ veh1 });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'build',
    dialect: '__vehicle',
    topic: 'servo',
    verb: 'set',
    vehicle: 'veh1',
    targetSystem: '',
    targetComponent: '',
  });
  let sent;

  node.emit(
    'input',
    { payload: { values: { servo: 1, pwm: 1500 } } },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 77);
  assert.equal(sent[0].payload.fields.target_component, 78);
});

test('mavlink-payload build tier concrete dialect does not inherit Vehicle Profile target', () => {
  const veh1 = { defaultTargetSystem: 77, defaultTargetComponent: 78 };
  const RED = redStub({ veh1 });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'build',
    dialect: 'common',
    topic: 'servo',
    verb: 'set',
    vehicle: 'veh1',
    targetSystem: '',
    targetComponent: '',
  });
  let sent;

  node.emit(
    'input',
    { payload: { values: { servo: 1, pwm: 1500 } } },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.ok(Number.isNaN(sent[0].payload.fields.target_system), 'concrete dialect has no profile sysid rung');
  assert.ok(Number.isNaN(sent[0].payload.fields.target_component), 'concrete dialect has no profile compid rung');
});

test('mavlink-payload build tier ignores connection vehicle when vehicle field is set', () => {
  const veh1 = { defaultTargetSystem: 77, defaultTargetComponent: 78 };
  const conn = { vehicle: { targetSystem: 99, targetComponent: 99 }, send() {}, subscribe() { return () => {}; } };
  const RED = redStub({ veh1, conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    sendAs: 'long',
    delivery: 'build',
    dialect: '__vehicle',
    topic: 'servo',
    verb: 'set',
    vehicle: 'veh1',
    connection: 'conn',
    targetSystem: '',
    targetComponent: '',
  });
  let sent;

  node.emit(
    'input',
    { payload: { values: { servo: 1, pwm: 1500 } } },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 77, 'vehicle profile used, not connection profile');
  assert.equal(sent[0].payload.fields.target_component, 78, 'vehicle profile used, not connection profile');
});

/**
 * Connection stub with subscribe/send and COMMAND_ACK injection.
 */
function connStub() {
  const subs = [];
  const sent = [];
  return {
    subs,
    sent,
    send(message, opts) {
      sent.push({ message, opts });
    },
    resolveSourceIds: () => null,
    subscribe(filter, handler) {
      const entry = { filter, handler };
      subs.push(entry);
      return () => {
        const i = subs.indexOf(entry);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    injectAck(fields, sysid, compid) {
      const decoded = { name: 'COMMAND_ACK', sysid, compid, fields };
      for (const { handler } of subs.slice()) handler(decoded);
    },
  };
}

function installAckTimerHarness(t) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const active = new Set();
  const delays = [];

  globalThis.setTimeout = (fn, delay) => {
    const handle = {};
    active.add(handle);
    delays.push(delay);
    if (delay === 1000) {
      queueMicrotask(() => {
        if (active.delete(handle)) fn();
      });
    }
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    active.delete(handle);
  };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  return { delays };
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
