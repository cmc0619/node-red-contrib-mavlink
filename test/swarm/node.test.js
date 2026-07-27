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
  assert.equal(sent[1].payload.result, 'succeeded');
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
  assert.equal(sent[1].payload.result, 'refused');
  assert.equal(connection.sends.length, 0);
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
