'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { isStatusRecord } = require('../../lib/delivery');

test('mavlink-param node builds PARAM_SET from msg payload values', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    action: 'set',
    targetSystem: 6,
    targetComponent: 1,
    firmware: 'ardupilot',
  });
  let sent;

  node.emit(
    'input',
    { payload: { paramId: 'FOO', value: 12, paramType: 'MAV_PARAM_TYPE_REAL32' } },
    (messages) => {
      sent = messages;
    },
    () => {}
  );

  assert.equal(sent[0].payload.name, 'PARAM_SET');
  assert.equal(sent[0].payload.fields.param_id, 'FOO');
  assert.equal(sent[0].payload.fields.param_value, 12);
  // The status record leaves output 1 as the top-level message carrying the
  // shared delivery marker (not wrapped in msg.payload), so a miswire refuses.
  assert.ok(isStatusRecord(sent[1]), 'output 1 carries the shared status marker at top level');
  assert.equal(sent[1].result, 'built');
});

test('mavlink-param refuses a status record fed into its input (miswire)', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({ delivery: 'build', action: 'set' });

  // Capture a real status record from a build, then feed it straight back in.
  let first;
  node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, (m) => { first = m; }, () => {});
  const record = first[1];
  assert.ok(isStatusRecord(record));

  let second;
  node.emit('input', record, (m) => { second = m; }, () => {});
  assert.equal(second[0], null, 'output 0 must not fire on a miswire');
  assert.ok(isStatusRecord(second[1]));
  assert.equal(second[1].result, 'refused');
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
      assert.ok(isStatusRecord(out[1]));
      assert.equal(out[1].result, 'timed-out');
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

test('mavlink-param inherits Vehicle Profile target when config is empty', () => {
  const conn = { vehicle: { targetSysid: 42, targetCompid: 191 }, send() {}, subscribe() { return () => {}; } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    action: 'read',
    targetSystem: '',
    targetComponent: '',
    connection: 'conn',
    firmware: 'ardupilot',
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
  const conn = { vehicle: { targetSysid: 42, targetCompid: 191 }, send() {}, subscribe() { return () => {}; } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    action: 'read',
    targetSystem: 7,
    targetComponent: 100,
    connection: 'conn',
    firmware: 'ardupilot',
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

/**
 * Connection stub that records subscription filters and unsubscribe calls.
 */
function connStub() {
  const subs = [];
  return {
    subs,
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
