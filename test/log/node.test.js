'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { StubConnection } = require('../mission/stubs/connection');

function loadNode(conn) {
  const RED = {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'log-node';
        node.type = 'mavlink-log';
        node.status = () => {};
        node.error = () => {};
        node.log = () => {};
        node.warn = () => {};
      },
      registerType(name, ctor) { this.types[name] = ctor; },
      getNode(id) { return id === 'conn' ? conn : undefined; },
    },
  };
  require('../../nodes/mavlink-log')(RED);
  return RED.nodes.types['mavlink-log'];
}

function runInput(node, msg) {
  return new Promise((resolve) => {
    const outputs = [];
    node.emit('input', msg, (messages) => outputs.push(messages), (err) => resolve({ outputs, err }));
  });
}

const BASE = {
  connection: 'conn',
  targetSystem: 42,
  targetComponent: 1,
  timeoutMs: 20,
  maxRetries: 1,
};

test('list confirm returns entries on continue and status on output 1', async () => {
  const conn = new StubConnection();
  conn.onSend((message, deliver) => {
    if (message.name === 'LOG_REQUEST_LIST') {
      deliver({
        name: 'LOG_ENTRY', sysid: 42, compid: 1,
        fields: { id: 1, num_logs: 1, last_log_num: 1, time_utc: 0, size: 15 },
      });
    }
  });
  const Node = loadNode(conn);
  const node = new Node({ ...BASE, operation: 'list' });
  const { outputs, err } = await runInput(node, { payload: {}, filename: 'logs.json' });

  assert.equal(err, undefined);
  assert.deepEqual(outputs.at(-1)[0].payload, [
    { id: 1, numLogs: 1, lastLogNum: 1, timeUtc: 0, size: 15 },
  ]);
  assert.equal(outputs.at(-1)[0].filename, 'logs.json');
  assert.equal(outputs.at(-1)[1].result, 'succeeded');
  assert.equal(outputs.at(-1)[1].node, 'mavlink-log');
});

test('download confirm emits a Buffer carrying the selected log id and closes the transfer', async () => {
  const conn = new StubConnection();
  conn.onSend((message, deliver) => {
    if (message.name === 'LOG_REQUEST_DATA') {
      deliver({
        name: 'LOG_DATA', sysid: 42, compid: 1,
        fields: { id: 7, ofs: 0, count: 3, data: Buffer.from('log') },
      });
    }
  });
  const Node = loadNode(conn);
  const node = new Node({ ...BASE, operation: 'download', logId: 7 });
  const { outputs, err } = await runInput(node, { payload: {}, filename: 'log.bin', topic: 'download' });

  assert.equal(err, undefined);
  const result = outputs.at(-1);
  assert.ok(Buffer.isBuffer(result[0].payload));
  assert.deepEqual(result[0].payload, Buffer.from('log'));
  assert.equal(result[0].logId, 7);
  assert.equal(result[0].filename, 'log.bin');
  assert.equal(result[0].topic, 'download');
  assert.equal(result[1].result, 'succeeded');
  assert.deepEqual(conn.sentNames(), ['LOG_REQUEST_DATA', 'LOG_REQUEST_END']);
});

test('payload id overrides the configured log id without changing target addressing', async () => {
  const conn = new StubConnection();
  conn.onSend((message, deliver) => {
    if (message.name === 'LOG_REQUEST_DATA') {
      assert.equal(message.fields.id, 9);
      deliver({
        name: 'LOG_DATA', sysid: 42, compid: 1,
        fields: { id: 9, ofs: 0, count: 0, data: Buffer.alloc(90) },
      });
    }
  });
  const Node = loadNode(conn);
  const node = new Node({ ...BASE, operation: 'download', logId: 7 });
  const { outputs } = await runInput(node, { payload: { id: 9 } });

  assert.equal(outputs.at(-1)[0].logId, 9);
  assert.equal(conn.sent[0].message.fields.target_system, 42);
  assert.equal(conn.sent[0].message.fields.target_component, 1);
});

test('a second log operation for the same connection and target is reported busy', async (t) => {
  const conn = new StubConnection();
  conn.onSend(() => {});
  const Node = loadNode(conn);
  const first = new Node({ ...BASE, operation: 'download', logId: 7, id: 'first' });
  const second = new Node({ ...BASE, operation: 'list', id: 'second' });
  t.after(() => first.emit('close', () => {}));

  first.emit('input', { payload: {} }, () => {}, () => {});
  const { outputs } = await runInput(second, { payload: {} });

  assert.equal(outputs.at(-1)[1].phase, 'locked');
  assert.equal(conn.sentNames().filter((name) => name === 'LOG_REQUEST_LIST').length, 0);
});
