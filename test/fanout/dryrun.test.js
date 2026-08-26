'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { executeFanout } = require('../../lib/fanout');
const { offsetLatLon } = require('../../lib/formation');

// ── Dry-run: resolve everything, send nothing ────────────────────────────────

test('dry-run resolves per-member messages with patches and sends nothing', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({
    connection,
    message: builtCommand({ fields: { command: 192, param5: 47.4, param6: 8.5 } }),
    targets: [1, { sysid: 2, param5: 47.5, param6: 8.6 }],
    mode: 'sequential',
    delivery: 'confirm',
    dryRun: true,
    intervalMs: 0,
  });

  assert.equal(connection.sends.length, 0, 'nothing reached the wire');
  assert.equal(result.result, 'dryrun');
  assert.equal(result.success, false, 'nothing dispatched — no phantom success (§2)');
  assert.equal(result.continue, false, 'the continue trigger stays silent');
  assert.equal(result.count, 2);
  const bySysid = Object.fromEntries(result.members.map((m) => [m.sysid, m]));
  assert.equal(bySysid[1].result, 'built');
  assert.equal(bySysid[1].message.fields.target_system, 1);
  assert.equal(bySysid[1].message.fields.param5, 47.4, 'bare target keeps the shared message');
  assert.equal(bySysid[2].message.fields.target_system, 2);
  assert.equal(bySysid[2].message.fields.param5, 47.5, 'the patch is resolved into the preview');
  assert.equal(bySysid[2].message.fields.param6, 8.6);
});

test('dry-run resolves config member metre offsets against the message position (#163)', async () => {
  const connection = connectionStub([peer(1), peer(2)]);
  const message = {
    name: 'COMMAND_INT',
    fields: {
      target_system: 0,
      target_component: 0,
      command: 192,
      frame: 0, // MAV_FRAME_GLOBAL
      x: 474000000,
      y: 85000000,
      z: 10,
    },
  };

  const result = await executeFanout({
    connection,
    message,
    members: [{ sysid: 1 }, { sysid: 2, north: 10, east: 5, up: 2 }],
    mode: 'sequential',
    delivery: 'send',
    dryRun: true,
    intervalMs: 0,
  });

  assert.equal(connection.sends.length, 0);
  assert.equal(result.result, 'dryrun');
  const bySysid = Object.fromEntries(result.members.map((m) => [m.sysid, m]));
  assert.equal(bySysid[1].message.fields.x, 474000000, 'member without offsets keeps the base position');
  const at = offsetLatLon(47.4, 8.5, 10, 5);
  assert.equal(bySysid[2].message.fields.x, Math.round(at.lat * 1e7), 'north/east converted to degE7');
  assert.equal(bySysid[2].message.fields.y, Math.round(at.lon * 1e7));
  assert.equal(bySysid[2].message.fields.z, 12, 'up adds to the up-positive altitude');
});

test('dry-run of a run that would be refused reports the refusal', async () => {
  const connection = connectionStub([peer(1)]);

  const missionStep = await executeFanout({
    connection,
    message: { name: 'MISSION_COUNT', fields: { target_system: 1, target_component: 1, count: 4 } },
    mode: 'sequential',
    delivery: 'send',
    dryRun: true,
    selection: { mode: 'all' },
  });
  assert.equal(missionStep.result, 'refused');
  assert.equal(missionStep.outcomes, null, 'no run executed, so no tally');

  const subsetBroadcast = await executeFanout({
    connection,
    message: builtCommand(),
    mode: 'broadcast',
    delivery: 'send',
    dryRun: true,
    selection: { mode: 'list', sysids: '1' },
  });
  assert.equal(subsetBroadcast.result, 'refused', 'broadcast cannot honour a subset, preview or not');
  assert.equal(connection.sends.length, 0);
});

test('dry-run broadcast previews the one packet and every member hearing it', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({
    connection,
    message: builtCommand(),
    mode: 'broadcast',
    delivery: 'confirm',
    dryRun: true,
    selection: { mode: 'all' },
  });

  assert.equal(connection.sends.length, 0);
  assert.equal(result.result, 'dryrun');
  assert.equal(result.message.fields.target_system, 0, 'the broadcast packet itself');
  assert.deepEqual(result.members.map((m) => m.sysid), [1, 2]);
  assert.deepEqual(result.outcomes, { accepted: [], failed: [], timedOut: [], skipped: [] });
});

// ── Dry-run through the node: config checkbox and per-message flag ───────────

test('config dryRun sends nothing and badges a preview through the node', async () => {
  const connection = connectionStub([peer(1), peer(2)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const node = new (RED.nodes.types['mavlink-fanout'])({
    selectionMode: 'all',
    connection: 'conn',
    executionMode: 'sequential',
    delivery: 'send',
    dryRun: true,
    intervalMs: 0,
  });
  let sent;

  await emitInput(node, { payload: builtCommand() }, (m) => { sent = m; });

  assert.equal(connection.sends.length, 0, 'nothing left the wire');
  assert.equal(sent[0], null, 'output 0 stays silent — a downstream mavlink-out must not send a preview');
  assert.equal(sent[1].result, 'dryrun');
  assert.equal(sent[1].members.length, 2);
  assert.deepEqual(node._status, { fill: 'yellow', shape: 'dot', text: 'dry-run 2' });
});

test('msg.payload.dryRun overrides the config checkbox in both directions', async () => {
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];

  const configOff = new Node({
    selectionMode: 'all',
    connection: 'conn',
    executionMode: 'sequential',
    delivery: 'send',
    dryRun: false,
    intervalMs: 0,
  });
  let previewSent;
  await emitInput(configOff, { payload: { message: builtCommand(), dryRun: true } }, (m) => { previewSent = m; });
  assert.equal(connection.sends.length, 0, 'the per-message flag previews a send-tier node');
  assert.equal(previewSent[1].result, 'dryrun');

  const configOn = new Node({
    selectionMode: 'all',
    connection: 'conn',
    executionMode: 'sequential',
    delivery: 'send',
    dryRun: true,
    intervalMs: 0,
  });
  let liveSent;
  await emitInput(configOn, { payload: { message: builtCommand(), dryRun: false } }, (m) => { liveSent = m; });
  assert.equal(connection.sends.length, 1, 'the per-message flag re-arms a dry-run node');
  assert.equal(liveSent[1].result, 'succeeded');
});

// ── Outcome aggregation: partial failure reported, never hidden ──────────────

test('send tier tallies accepted and failed with stop-on-error off', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)], { failSysids: new Set([2]) });

  const result = await executeFanout({
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
    selection: { mode: 'all' },
    intervalMs: 0,
    stopOnError: false,
  });

  assert.equal(result.result, 'failed');
  assert.equal(result.success, false);
  assert.deepEqual(result.outcomes, { accepted: [1, 3], failed: [2], timedOut: [], skipped: [] });
  assert.equal(result.members.find((m) => m.sysid === 2).result, 'failed');
});

test('stop-on-error tallies the failure and names the skipped members', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)], { failSysids: new Set([1]) });

  const result = await executeFanout({
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
    selection: { mode: 'all' },
    intervalMs: 0,
    stopOnError: true,
  });

  assert.equal(result.success, false);
  assert.deepEqual(result.outcomes, { accepted: [], failed: [1], timedOut: [], skipped: [2, 3] });
  assert.equal(connection.sends.length, 0, 'members after the failure are never sent to');
});

test('confirm tier tallies accepted, timed out, and failed across one fleet run', async () => {
  const handlers = [];
  const connection = {
    peerTable: peerTableStub([peer(1), peer(2), peer(3)]),
    sends: [],
    send(message, sendOptions) {
      if (message.fields.target_system === 3) throw new Error('control band saturated');
      this.sends.push({ message, options: sendOptions });
    },
    resolveSourceIds: () => null,
    subscribe(filter, handler) {
      handlers.push(handler);
      return () => {};
    },
  };
  const deliver = (decoded) => handlers.slice().forEach((h) => h(decoded));

  const run = executeFanout({
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'confirm',
    selection: { mode: 'all' },
    intervalMs: 0,
    timeoutMs: 60,
    maxRetries: 0,
    stopOnError: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connection.sends.length, 1, 'member 1 awaits its ack first');
  deliver({ sysid: 1, compid: 1, fields: { command: 400, result: 0 } });
  const result = await run;

  assert.equal(result.success, false, 'partial failure is not a success');
  assert.deepEqual(result.outcomes.accepted, [1]);
  assert.deepEqual(result.outcomes.timedOut, [2], 'the member whose window closed unanswered');
  assert.deepEqual(result.outcomes.failed, [3], 'the member whose send threw');
  assert.deepEqual(result.outcomes.skipped, []);
  assert.equal(result.members.find((m) => m.sysid === 2).result, 'timeout');
});

test('broadcast-with-acks tallies accepted and unconfirmed members', async () => {
  const handlers = [];
  const connection = {
    peerTable: peerTableStub([peer(1), peer(2)]),
    sends: [],
    send(message, sendOptions) { this.sends.push({ message, options: sendOptions }); },
    resolveSourceIds: () => null,
    subscribe(filter, handler) {
      handlers.push(handler);
      return () => {};
    },
  };
  const deliver = (decoded) => handlers.slice().forEach((h) => h(decoded));

  const run = executeFanout({
    connection,
    message: builtCommand(),
    mode: 'broadcast',
    delivery: 'confirm',
    selection: { mode: 'all' },
    timeoutMs: 60,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connection.sends.length, 1, 'one packet for the whole fleet');
  deliver({ sysid: 1, compid: 1, fields: { command: 400, result: 0 } });
  const result = await run;

  assert.equal(result.success, false, 'member 2 never answered');
  assert.deepEqual(result.outcomes.accepted, [1]);
  assert.deepEqual(result.outcomes.timedOut, [2], 'the broadcast unconfirmed marker tallies as timed out');
  assert.deepEqual(result.outcomes.failed, []);
  assert.equal(result.members.find((m) => m.sysid === 2).result, 'unconfirmed');
});

// ── Stubs (mirroring test/fanout/node.test.js) ────────────────────────────────

function emitInput(node, msg, send) {
  return new Promise((resolve, reject) => {
    node.emit('input', msg, send, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function builtCommand(overrides = {}) {
  return {
    name: overrides.name || 'COMMAND_LONG',
    fields: {
      target_system: 0,
      target_component: 0,
      command: 400,
      confirmation: 0,
      param1: 0,
      param2: 0,
      param3: 0,
      param4: 0,
      param5: 0,
      param6: 0,
      param7: 0,
      ...(overrides.fields || {}),
    },
  };
}

function peer(sysid) {
  return {
    sysid,
    components: [{ compid: 1, state: 'active', type: 2, autopilot: 3, firmware: 'ardupilot', armed: false, flightMode: 0 }],
  };
}

function peerTableStub(rows) {
  return {
    snapshot() {
      return rows;
    },
    getComponent(sysid, compid) {
      const row = rows.find((p) => p.sysid === sysid);
      return row && row.components.find((c) => c.compid === compid);
    },
  };
}

function connectionStub(rows, options = {}) {
  return {
    peerTable: peerTableStub(rows),
    sends: [],
    send(message, sendOptions) {
      if (options.failSysids && options.failSysids.has(message.fields.target_system)) {
        throw new Error(`send failed for ${message.fields.target_system}`);
      }
      this.sends.push({ message, options: sendOptions });
    },
    resolveSourceIds: () => null,
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
        node._status = null;
        node.status = (status) => { node._status = status; };
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
