'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-fanout node emits continue only for all-success aggregate', async () => {
  const connection = connectionStub([peer(1), peer(2)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({
    connection: 'conn',
    actionType: 'command',
    carrier: 'long',
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
  assert.equal(connection.sends.length, 2);
});

test('build+list with no connection succeeds — peer table not needed for explicit sysid list (§6)', async () => {
  const RED = redStub({});  // no connection registered
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({
    connection: '',
    actionType: 'command',
    carrier: 'long',
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

test('sysid list rejects values outside 1..255 (config and payload)', async () => {
  const RED = redStub({});
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];

  const fromConfig = new Node({
    connection: '',
    actionType: 'command',
    carrier: 'long',
    commandId: 400,
    delivery: 'build',
    selectionMode: 'list',
    sysids: '1,256',
    intervalMs: 0,
  });
  let sentConfig;
  const errConfig = await emitInput(fromConfig, { payload: {} }, (m) => { sentConfig = m; }).then(
    () => null,
    (e) => e
  );
  assert.ok(errConfig, 'out-of-range config sysid fails the input');
  assert.match(errConfig.message, /1\.\.255/, 'error names the valid range');
  assert.match(errConfig.message, /256/, 'error names the bad token');
  assert.equal(sentConfig[1].result, 'failed');

  const fromPayload = new Node({
    connection: '',
    actionType: 'command',
    carrier: 'long',
    commandId: 400,
    delivery: 'build',
    selectionMode: 'list',
    sysids: '1,2',
    intervalMs: 0,
  });
  let sentPayload;
  const errPayload = await emitInput(
    fromPayload,
    { payload: { sysids: '0,3' } },
    (m) => { sentPayload = m; }
  ).then(
    () => null,
    (e) => e
  );
  assert.ok(errPayload, 'out-of-range payload sysid (0 = broadcast) fails the input');
  assert.match(errPayload.message, /1\.\.255/);
  assert.equal(sentPayload[1].result, 'failed');
});

test('build+all without connection fails loudly naming the rule (§6)', async () => {
  const RED = redStub({});
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({
    connection: '',
    actionType: 'command',
    carrier: 'long',
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
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({
    connection: 'conn',
    actionType: 'command',
    carrier: 'long',
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
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({
    connection: 'conn',
    actionType: 'command',
    carrier: 'long',
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

test('mavlink-fanout node gates a safety preset on msg.confirmed / node confirm (§10)', async () => {
  const RED = redStub({ conn: connectionStub([peer(1)]) });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];

  // No confirmation anywhere → refused, nothing sent.
  const gated = new Node({ connection: 'conn', carrier: 'long', actionType: 'command',
    preset: 'flight_termination', delivery: 'send' });
  let sent;
  const err = await emitInput(gated, { payload: { 1: 1 } }, (m) => { sent = m; }).then(
    () => null,
    (e) => e
  );
  assert.ok(err, 'refused safety preset is passed to done(err)');
  assert.match(err.message, /mavlink-fanout: refused/);
  assert.ok(sent, 'status output is emitted before done(err)');
  assert.equal(sent[0], null);
  assert.equal(sent[1].result, 'refused');
  assert.match(sent[1].detail, /confirm/i);

  // msg.confirmed === true clears the gate.
  const conn2 = connectionStub([peer(1)]);
  const RED2 = redStub({ conn: conn2 });
  require('../../nodes/mavlink-fanout')(RED2);
  const okNode = new (RED2.nodes.types['mavlink-fanout'])({
    connection: 'conn', actionType: 'command',
    carrier: 'long', preset: 'flight_termination', delivery: 'send',
  });
  await emitInput(okNode, { payload: { 1: 1 }, confirmed: true }, () => {});
  assert.equal(conn2.sends.length, 1);
  assert.equal(conn2.sends[0].message.fields.command, 185);
});

test('msg.payload.memberParams reaches the fan-out action per member', async () => {
  const connection = connectionStub([peer(1), peer(2)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({
    connection: 'conn',
    actionType: 'command',
    carrier: 'long',
    commandId: 192,
    executionMode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });
  let sent;

  await emitInput(node, {
    payload: {
      params: { 5: 47.4, 6: 8.5 },
      memberParams: { 2: { 5: 47.5, 6: 8.6 } },
    },
  }, (messages) => { sent = messages; });

  assert.equal(sent[1].result, 'succeeded');
  const bySysid = Object.fromEntries(
    connection.sends.map((s) => [s.message.fields.target_system, s.message.fields])
  );
  assert.equal(bySysid[1].param5, 47.4, 'member without an override keeps the shared params');
  assert.equal(bySysid[1].param6, 8.5);
  assert.equal(bySysid[2].param5, 47.5, 'payload.memberParams overrides that member');
  assert.equal(bySysid[2].param6, 8.6);
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

test('close cancels an in-flight fan-out and waits for it to unwind (#54/#57)', async () => {
  // The bug: mavlink-fanout had no close handler at all. A redeploy landing
  // mid-run left the member loop walking its list, sending arm/mode commands
  // to real vehicles from a node Node-RED had already torn down.
  //
  // A 60 s inter-member interval parks the loop in the pause, so close is
  // guaranteed to land mid-run rather than racing a finished one.
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({
    connection: 'conn',
    actionType: 'command',
    carrier: 'long',
    commandId: 400,
    executionMode: 'sequential',
    delivery: 'send',
    intervalMs: 60000,
  });

  let emitted = false;
  let inputSettled = false;
  const run = emitInput(node, { payload: {} }, () => { emitted = true; })
    .then(() => { inputSettled = true; });

  // Let the first member's send happen and the loop reach the pause.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connection.sends.length, 1, 'parked in the interval after member 1');
  assert.equal(inputSettled, false, 'run is still in flight');

  const closedAt = Date.now();
  await new Promise((resolve) => node.emit('close', resolve));
  const closeMs = Date.now() - closedAt;
  // Capture before awaiting run: afterwards the assertion would hold trivially
  // and stop proving that close itself waited for the unwind.
  const inputSettledAtClose = inputSettled;
  await run;

  assert.ok(closeMs < 5000, `close returned promptly (${closeMs}ms), not after the 60 s interval`);
  assert.equal(inputSettledAtClose, true, 'close waited for the run to unwind before reporting closed');
  assert.equal(connection.sends.length, 1, 'members 2 and 3 never receive a command');
  assert.equal(emitted, false, 'a cancelled run emits nothing onto a closed node');
});

test('close cancels every concurrent fan-out, not just the newest (Greptile #140)', async () => {
  // Node-RED does not serialise async input handlers: two messages arriving
  // close together re-enter and run concurrently. Tracking one slot would let
  // close cancel only the second run and return as soon as it settled, leaving
  // the first still walking its member list.
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({
    connection: 'conn',
    actionType: 'command',
    carrier: 'long',
    commandId: 400,
    executionMode: 'sequential',
    delivery: 'send',
    intervalMs: 60000,
  });

  let firstSettled = false;
  let secondSettled = false;
  const first = emitInput(node, { payload: {} }, () => {}).then(() => { firstSettled = true; });
  const second = emitInput(node, { payload: {} }, () => {}).then(() => { secondSettled = true; });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connection.sends.length, 2, 'both runs sent to their first member');
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);

  await new Promise((resolve) => node.emit('close', resolve));
  await Promise.all([first, second]);

  assert.equal(firstSettled, true, 'the older run was cancelled and awaited too');
  assert.equal(secondSettled, true);
  assert.equal(connection.sends.length, 2, 'neither run advanced past member 1');
});
