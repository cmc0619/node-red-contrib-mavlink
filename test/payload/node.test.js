'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-payload node builds command-backed payload messages', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    delivery: 'build',
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
  assert.equal(sent[1].payload.confirmation, 'command_ack');
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('mavlink-payload confirm tier waits for COMMAND_ACK and continues only on ACCEPTED', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
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
  assert.equal(sent[1].payload.result, 'succeeded');
  assert.equal(sent[1].payload.confirmedBy, 'ack');

  node.emit('close', () => {});
});

test('mavlink-payload confirm tier halts the chain on a DENIED ack', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
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
  assert.equal(sent[1].payload.result, 'denied');

  node.emit('close', () => {});
});

test('mavlink-payload inherits Vehicle Profile target when config is empty', () => {
  const conn = { vehicle: { targetSysid: 42, targetCompid: 191 }, send() {}, subscribe() { return () => {}; } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    delivery: 'build',
    topic: 'servo',
    verb: 'set',
    targetSystem: '',
    targetComponent: '',
    connection: 'conn',
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
  const conn = { vehicle: { targetSysid: 42, targetCompid: 191 }, send() {}, subscribe() { return () => {}; } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-payload')(RED);
  const Node = RED.nodes.types['mavlink-payload'];
  const node = new Node({
    delivery: 'build',
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
  assert.equal(sent[1].payload.detail, 'sent (unconfirmed)');
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
