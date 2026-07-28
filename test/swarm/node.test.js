'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-swarm node emits continue only for all-success aggregate', async () => {
  const connection = connectionStub([peer(1), peer(2)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-swarm')(RED);
  const Node = RED.nodes.types['mavlink-swarm'];
  const node = new Node({
    connection: 'conn',
    actionType: 'command',
    commandId: 400,
    executionMode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });
  let sent;

  await emitInput(node, { payload: {} }, (messages) => {
    sent = messages;
  });

  assert.equal(sent[0].payload.result, 'succeeded');
  assert.equal(sent[1].result, 'succeeded');
  assert.equal(require('../../lib/delivery').isStatusRecord(sent[1]), true, 'output 1 aggregate carries the marker at root');
  assert.equal(connection.sends.length, 2);
});

test('mavlink-swarm node refuses status-record input on output 1 only', async () => {
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-swarm')(RED);
  const Node = RED.nodes.types['mavlink-swarm'];
  const node = new Node({
    connection: 'conn',
    actionType: 'command',
    commandId: 400,
  });
  let sent;

  await emitInput(
    node,
    require('../../lib/delivery').makeStatusRecord({ result: 'failed' }),
    (messages) => {
      sent = messages;
    }
  );

  assert.equal(sent[0], null);
  assert.equal(sent[1].result, 'refused');
  assert.equal(connection.sends.length, 0);
});

test('build+list with no connection succeeds — peer table not needed for explicit sysid list (§6)', async () => {
  const RED = redStub({});  // no connection registered
  require('../../nodes/mavlink-swarm')(RED);
  const Node = RED.nodes.types['mavlink-swarm'];
  const node = new Node({
    connection: '',
    actionType: 'command',
    commandId: 400,
    delivery: 'build',
    selectionMode: 'list',
    sysids: '1,2',
    executionMode: 'sequential',
    intervalMs: 0,
  });
  let sent;
  await emitInput(node, { payload: {} }, (messages) => { sent = messages; });

  assert.equal(sent[1].result, 'succeeded', 'build+list with no connection must succeed');
  assert.equal(sent[1].count, 2, 'both listed sysids built');
  assert.equal(sent[0].payload.result, 'succeeded', 'output 0 carries built aggregate');
});

test('build+all without connection fails loudly naming the rule (§6)', async () => {
  const RED = redStub({});
  require('../../nodes/mavlink-swarm')(RED);
  const Node = RED.nodes.types['mavlink-swarm'];
  const node = new Node({
    connection: '',
    actionType: 'command',
    commandId: 400,
    delivery: 'build',
    selectionMode: 'all',
    intervalMs: 0,
  });
  let sent;
  const err = await emitInput(node, { payload: {} }, (m) => { sent = m; }).then(
    () => null,
    (e) => e
  );

  assert.ok(err, 'error is passed to done for build+all without connection');
  assert.match(err.message, /peer table/i, 'error message names the rule (peer table needed for all)');
  assert.ok(sent, 'output was emitted before done(err)');
  assert.equal(sent[0], null, 'no continue output on failure');
  assert.equal(sent[1].result, 'failed');
  assert.match(sent[1].detail, /peer table/i, 'status record detail names the rule');
});

test('identityId from payload is passed through to connection.send options', async () => {
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-swarm')(RED);
  const Node = RED.nodes.types['mavlink-swarm'];
  const node = new Node({
    connection: 'conn',
    actionType: 'command',
    commandId: 400,
    delivery: 'send',
    intervalMs: 0,
  });
  await emitInput(node, { payload: { identityId: 'my-identity-id' } }, () => {});

  assert.equal(connection.sends.length, 1);
  assert.equal(connection.sends[0].options.identityId, 'my-identity-id',
    'payload.identityId must reach connection.send options');
});

test('config.identity is used as identityId when payload does not override', async () => {
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-swarm')(RED);
  const Node = RED.nodes.types['mavlink-swarm'];
  const node = new Node({
    connection: 'conn',
    actionType: 'command',
    commandId: 400,
    delivery: 'send',
    identity: 'cfg-identity-id',
    intervalMs: 0,
  });
  await emitInput(node, { payload: {} }, () => {});

  assert.equal(connection.sends.length, 1);
  assert.equal(connection.sends[0].options.identityId, 'cfg-identity-id',
    'config.identity must reach connection.send options as identityId');
});

test('mavlink-swarm node gates a safety preset on msg.confirmed / node confirm (§10)', async () => {
  const RED = redStub({ conn: connectionStub([peer(1)]) });
  require('../../nodes/mavlink-swarm')(RED);
  const Node = RED.nodes.types['mavlink-swarm'];

  // No confirmation anywhere → refused, nothing sent.
  const gated = new Node({ connection: 'conn', actionType: 'command', preset: 'flight_termination', delivery: 'send' });
  let sent;
  await emitInput(gated, { payload: { 1: 1 } }, (m) => { sent = m; });
  assert.equal(sent[0], null);
  assert.equal(sent[1].result, 'refused');
  assert.match(sent[1].detail, /confirm/i);

  // msg.confirmed === true clears the gate.
  const conn2 = connectionStub([peer(1)]);
  const RED2 = redStub({ conn: conn2 });
  require('../../nodes/mavlink-swarm')(RED2);
  const okNode = new (RED2.nodes.types['mavlink-swarm'])({
    connection: 'conn', actionType: 'command', preset: 'flight_termination', delivery: 'send',
  });
  await emitInput(okNode, { payload: { 1: 1 }, confirmed: true }, () => {});
  assert.equal(conn2.sends.length, 1);
  assert.equal(conn2.sends[0].message.fields.command, 185);
});

function emitInput(node, msg, send) {
  return new Promise((resolve, reject) => {
    node.emit('input', msg, send, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function peer(sysid) {
  return {
    sysid,
    components: [{ compid: 1, state: 'active', type: 2, autopilot: 3, armed: false }],
  };
}

function connectionStub(rows) {
  return {
    peerTable: {
      snapshot() {
        return rows;
      },
      getComponent(sysid, compid) {
        const row = rows.find((p) => p.sysid === sysid);
        return row && row.components.find((c) => c.compid === compid);
      },
    },
    sends: [],
    send(message, options) {
      this.sends.push({ message, options });
    },
    subscribe() {
      return () => {};
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
