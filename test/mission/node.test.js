'use strict';

/**
 * mavlink-mission node tests (DESIGN.md §9 chain model, §6, §13). Exercises the
 * thin wrapper: the suppress guard, the Build tier plan, the clear confirmation
 * gate, and an end-to-end download whose progress and terminal records land on
 * output 1 while success fires output 0.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { StubConnection } = require('./stubs/connection');

/** Load the node type against a fresh RED stub with the given connection node. */
function loadNode(connNode, extraNodes) {
  const nodes = Object.assign({ conn: connNode }, extraNodes || {});
  const RED = {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'mission-node';
        node.status = () => {};
        node.error = () => {};
        node.send = () => {};
        node.log = () => {};
        node.warn = () => {};
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
      getNode(id) {
        return nodes[id];
      },
    },
  };
  require('../../nodes/mavlink-mission')(RED);
  return RED.nodes.types['mavlink-mission'];
}

/** Fire one input and resolve with every emitted output once `done` is called. */
function runInput(node, msg) {
  return new Promise((resolve) => {
    const outputs = [];
    node.emit(
      'input',
      msg,
      (m) => outputs.push(m),
      (err) => resolve({ outputs, err })
    );
  });
}

test('payload === false suppresses: no output, no error', async () => {
  const Node = loadNode(new StubConnection());
  const node = new Node({ operation: 'download', connection: 'conn', delivery: 'confirm' });
  const { outputs } = await runInput(node, { payload: false });
  assert.equal(outputs.length, 0);
});

test('Build tier emits the protocol plan on output 0 and sends nothing', async () => {
  const conn = new StubConnection();
  const Node = loadNode(conn);
  const node = new Node({ operation: 'download', connection: 'conn', delivery: 'build', dialect: 'common', firmware: 'custom', missionType: 'mission' });
  const { outputs } = await runInput(node, { payload: {} });

  assert.equal(outputs.length, 1);
  const plan = outputs[0][0].payload;
  assert.equal(plan.operation, 'download');
  assert.deepEqual(plan.messages.map((m) => m.name), ['MISSION_REQUEST_LIST']);
  assert.equal(conn.sent.length, 0, 'Build sends nothing');
  assert.equal(outputs[0][1].result, 'succeeded');
});

test('Build tier plans nothing for a missing operation instead of planning an upload', async () => {
  // A catch-all `else` treated every unknown operation as upload, so a node
  // with no operation answered Build with a zero-item MISSION_COUNT plan. The
  // dispatch is affirmative now (§5): no case matches, so no plan is built.
  // The editor's `operation` select is what reds a hand-edited token.
  const conn = new StubConnection();
  const Node = loadNode(conn);
  const node = new Node({ connection: 'conn', delivery: 'build', dialect: 'common', missionType: 'mission' });
  const { outputs } = await runInput(node, { payload: {} });

  assert.equal(conn.sent.length, 0);
  assert.ok(
    !outputs.some((o) => o[0] && o[0].payload && o[0].payload.messages),
    'no plan is emitted on output 0'
  );
});

test('mission Build concrete dialect has no Vehicle Profile target rung', async () => {
  const conn = new StubConnection();
  const vehicleNode = {
    defaultTargetSystem: 77,
    defaultTargetComponent: 78,
    firmware: 'px4',
  };
  const Node = loadNode(conn, { veh: vehicleNode });
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'build',
    dialect: 'common',
    firmware: 'ardupilot',
    vehicle: 'veh',
    missionType: 'fence',
    targetSystem: '',
    targetComponent: '',
  });

  const { outputs } = await runInput(node, { payload: {} });
  assert.notEqual(outputs[0][0], null, 'concrete Build dialect builds the plan');
  const plan = outputs[0][0].payload;
  assert.equal(plan.missionType, 1, 'fence plan carries mission_type 1');
  assert.ok(Number.isNaN(plan.target.sysid), 'concrete Build dialect has no profile sysid rung');
  assert.ok(Number.isNaN(plan.target.compid), 'concrete Build dialect has no profile compid rung');
});

test('a fence transfer under a px4 firmware profile runs — the vehicle judges type support (§9)', async () => {
  const conn = new StubConnection();
  conn.vehicle = { firmware: 'px4', targetSystem: 1, targetComponent: 1 };
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 0, mission_type: 1 } });
    }
  });
  const Node = loadNode(conn);
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'confirm',
    missionType: 'fence',
  });
  const { outputs, err } = await runInput(node, { payload: {} });
  assert.equal(err, undefined, 'the transfer is not refused at input');
  assert.equal(conn.sentNames()[0], 'MISSION_REQUEST_LIST', 'the transfer opens on the wire');
  assert.equal(outputs.at(-1)[1].result, 'succeeded');
});

test('build tier plans a fence transfer under a px4 firmware profile (mission_type 1)', async () => {
  const conn = new StubConnection();
  const vehicleNode = { defaultTargetSystem: 1, defaultTargetComponent: 1, firmware: 'px4' };
  const Node = loadNode(conn, { veh: vehicleNode });
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'build',
    dialect: '__vehicle',
    vehicle: 'veh',
    missionType: 'fence',
    targetSystem: '',
    targetComponent: '',
  });
  const { outputs, err } = await runInput(node, { payload: {} });
  assert.equal(err, undefined);
  const plan = outputs[0][0].payload;
  assert.equal(plan.missionType, 1, 'fence plan builds with mission_type 1');
  assert.deepEqual(plan.messages.map((m) => m.name), ['MISSION_REQUEST_LIST']);
});

test('an unknown payload.missionType resolves no type rather than a wrong one', async () => {
  // The editor's Type select is the vocabulary (RED.mavlink.oneOf); a
  // payload override is trusted runtime input. A token that names no type
  // resolves to nothing — never quietly to mission (0), which would run the
  // transfer against the wrong plan.
  const conn = new StubConnection();
  conn.vehicle = { firmware: 'ardupilot', targetSystem: 1, targetComponent: 1 };
  const Node = loadNode(conn);
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'build',
    missionType: 'mission',
  });
  const { outputs } = await runInput(node, { payload: { missionType: 'bogus' } });
  assert.equal(conn.sent.length, 0, 'nothing was sent');
  assert.equal(outputs[0][0].payload.missionType, undefined, 'the type is unresolved, not 0');
});

test("a typo'd Mission delivery starts no transfer — it matches no tier arm", async () => {
  // A typo of 'build' used to fall through to the wire tier and run a real
  // transfer against the vehicle the operator asked only to preview. Each
  // tier is its own switch arm now, so an unsavable token selects neither.
  const conn = new StubConnection();
  conn.vehicle = { firmware: 'ardupilot', targetSystem: 1, targetComponent: 1 };
  const Node = loadNode(conn);
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'biuld',
    missionType: 'mission',
  });
  const { outputs, err } = await runInput(node, { payload: {} });
  assert.equal(err, undefined);
  assert.equal(conn.sent.length, 0, 'a typo of build must not start a real transfer');
  assert.equal(outputs.length, 0, 'no tier ran, so no outcome was reported');
});

test('clear runs on any input — selecting the operation is the confirmation', async () => {
  // The confirm gate (config checkbox / msg.confirmed) was removed by owner
  // ruling (2026-08-13): an operator who selected the Clear operation has
  // already answered the question. This pins the gate's absence — a plain
  // input with no confirmation flag anywhere must clear.
  const conn = new StubConnection();
  conn.vehicle = { firmware: 'ardupilot', targetSystem: 1, targetComponent: 1 };
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_CLEAR_ALL') {
      deliver({ name: 'MISSION_ACK', fields: { type: 0, mission_type: 0 } });
    }
  });

  const Node = loadNode(conn);
  const node = new Node({ operation: 'clear', connection: 'conn', delivery: 'confirm', missionType: 'mission' });
  const res = await runInput(node, { payload: {} });
  const last = res.outputs.at(-1);
  assert.equal(last[0].payload.result, 'succeeded', 'continue port fires on success');
  assert.equal(last[1].result, 'succeeded');
  assert.equal(conn.sentNames().includes('MISSION_CLEAR_ALL'), true);
});

test('clear Build tier emits the plan without any confirmation flag', async () => {
  const conn = new StubConnection();
  const Node = loadNode(conn);
  const node = new Node({ operation: 'clear', connection: 'conn', delivery: 'build', missionType: 'mission' });
  const ok = await runInput(node, { payload: {} });
  assert.deepEqual(ok.outputs[0][0].payload.messages.map((m) => m.name), ['MISSION_CLEAR_ALL']);
});

test('download end-to-end: progress on output 1, success on both ports', async () => {
  const conn = new StubConnection();
  conn.vehicle = { firmware: 'ardupilot', targetSystem: 1, targetComponent: 1 };
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 2, mission_type: 0 } });
    } else if (message.name === 'MISSION_REQUEST_INT') {
      const seq = message.fields.seq;
      deliver({ name: 'MISSION_ITEM_INT', fields: { seq, command: 16, mission_type: 0 } });
    }
  });

  const Node = loadNode(conn);
  const node = new Node({ operation: 'download', connection: 'conn', delivery: 'confirm', missionType: 'mission' });
  const { outputs } = await runInput(node, { payload: {} });

  // Every emitted item has a status object at output 1 root.
  for (const out of outputs) assert.ok(out[1] && out[1].result);

  // Progress records appeared before the terminal one.
  const progress = outputs.filter((o) => o[1].result === 'progress');
  assert.ok(progress.length >= 2, 'phase/count progress emitted on output 1');

  const terminal = outputs.at(-1);
  assert.equal(terminal[0].payload.result, 'succeeded', 'continue port fires only on success');
  assert.equal(terminal[1].result, 'succeeded');
  assert.equal(terminal[1].count, 2);
});

test('mission resolveTarget inherits Vehicle Profile target when config is empty', async () => {
  const conn = new StubConnection();
  conn.vehicle = { targetSystem: 42, targetComponent: 191, firmware: 'ardupilot' };
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 0, mission_type: 0 } });
    }
  });
  const Node = loadNode(conn);
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'confirm',
    missionType: 'mission',
    targetSystem: '',
    targetComponent: '',
  });

  const { outputs } = await runInput(node, { payload: {} });
  const terminal = outputs.at(-1);
  assert.equal(terminal[1].target.sysid, 42);
  assert.equal(terminal[1].target.compid, 191);
});

test('mission resolveTarget explicit config wins over Vehicle Profile', async () => {
  const conn = new StubConnection();
  conn.vehicle = { targetSystem: 42, targetComponent: 191, firmware: 'ardupilot' };
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 0, mission_type: 0 } });
    }
  });
  const Node = loadNode(conn);
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'confirm',
    missionType: 'mission',
    targetSystem: 7,
    targetComponent: 100,
  });

  const { outputs } = await runInput(node, { payload: {} });
  const terminal = outputs.at(-1);
  assert.equal(terminal[1].target.sysid, 7);
  assert.equal(terminal[1].target.compid, 100);
});

test('upload end-to-end: items from msg.payload.items reach the vehicle and succeed', async () => {
  const conn = new StubConnection();
  conn.vehicle = { firmware: 'ardupilot', targetSystem: 1, targetComponent: 1 };
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_COUNT') {
      deliver({ name: 'MISSION_REQUEST_INT', fields: { seq: 0, mission_type: 0 } });
    } else if (message.name === 'MISSION_ITEM_INT') {
      deliver({ name: 'MISSION_ACK', fields: { type: 0, mission_type: 0 } });
    }
  });

  const Node = loadNode(conn);
  const node = new Node({ operation: 'upload', connection: 'conn', delivery: 'confirm', missionType: 'mission' });
  const { outputs, err } = await runInput(node, {
    payload: { items: [{ frame: 3, command: 16, x: 1, y: 2, z: 3 }] },
  });

  assert.equal(err, undefined);
  const terminal = outputs.at(-1);
  assert.equal(terminal[0].payload.result, 'succeeded');
  assert.equal(terminal[1].count, 1);
  assert.equal(conn.sentNames()[0], 'MISSION_COUNT');
  assert.equal(conn.sent[0].message.fields.count, 1);
});

test('an upload that resolves zero items is refused before any packet — empty upload is not a clear (#241)', async () => {
  const conn = new StubConnection();
  conn.vehicle = { firmware: 'ardupilot', targetSystem: 1, targetComponent: 1 };
  const Node = loadNode(conn);
  const node = new Node({ operation: 'upload', connection: 'conn', delivery: 'confirm', missionType: 'mission', items: '' });

  // Config blank, payload without items → resolves to [].
  let res = await runInput(node, { payload: {} });
  assert.ok(res.err, 'empty upload must fail loud');
  assert.equal(res.outputs[0][0], null);
  assert.equal(res.outputs[0][1].phase, 'empty');
  assert.match(res.outputs[0][1].reason, /Clear/, 'error names the Clear operation as the intended path');
  assert.equal(conn.sent.length, 0, 'no MISSION_COUNT 0 — nothing was sent');

  // Payload explicitly resolving to [] refuses the same way.
  res = await runInput(node, { payload: { items: [] } });
  assert.equal(res.outputs[0][1].phase, 'empty');
  assert.equal(conn.sent.length, 0);
});

test('the empty-upload refusal covers the Build tier — no zero-count plan is emitted (#241)', async () => {
  const conn = new StubConnection();
  const Node = loadNode(conn);
  const node = new Node({
    operation: 'upload',
    connection: 'conn',
    delivery: 'build',
    dialect: 'common',
    firmware: 'ardupilot',
    missionType: 'mission',
    items: '',
  });

  const { outputs, err } = await runInput(node, { payload: {} });
  assert.ok(err, 'Build must not be the softer door');
  assert.equal(outputs[0][0], null, 'no MISSION_COUNT(0) plan on output 0');
  assert.equal(outputs[0][1].phase, 'empty');
});

test('broadcast sysid 0 is refused for download and upload on every tier (#246)', async () => {
  const conn = new StubConnection();
  conn.vehicle = { firmware: 'ardupilot', targetSystem: 1, targetComponent: 1 };
  const Node = loadNode(conn);

  // Configured broadcast target, wire tier.
  const download = new Node({ operation: 'download', connection: 'conn', delivery: 'confirm', missionType: 'mission', targetSystem: 0 });
  let res = await runInput(download, { payload: {} });
  assert.ok(res.err, 'broadcast download must fail loud');
  assert.equal(res.outputs[0][0], null);
  assert.equal(res.outputs[0][1].phase, 'broadcast');
  assert.match(res.outputs[0][1].reason, /broadcast/);
  assert.equal(conn.sent.length, 0, 'no transfer opened toward the fleet');
  assert.equal(conn.subscriberCount(), 0, 'no machine subscribed on sysid 0');

  // Dynamic broadcast target on an upload.
  const upload = new Node({ operation: 'upload', connection: 'conn', delivery: 'confirm', missionType: 'mission' });
  res = await runInput(upload, {
    payload: { target: { sysid: 0 }, items: [{ frame: 3, command: 16, x: 1, y: 2, z: 3 }] },
  });
  assert.equal(res.outputs[0][1].phase, 'broadcast');
  assert.equal(conn.sent.length, 0);

  // Build refuses too: a built broadcast plan forwarded to mavlink-out is the
  // same fleet-wide transfer.
  const build = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'build',
    dialect: 'common',
    firmware: 'ardupilot',
    missionType: 'mission',
    targetSystem: 0,
  });
  res = await runInput(build, { payload: {} });
  assert.equal(res.outputs[0][0], null, 'no broadcast plan on output 0');
  assert.equal(res.outputs[0][1].phase, 'broadcast');
});

test('broadcast clear still builds — MISSION_CLEAR_ALL is an addressed single message that fans out (§10)', async () => {
  const conn = new StubConnection();
  const Node = loadNode(conn);
  const node = new Node({
    operation: 'clear',
    connection: 'conn',
    delivery: 'build',
    dialect: 'common',
    firmware: 'ardupilot',
    missionType: 'mission',
    targetSystem: 0,
  });

  const { outputs, err } = await runInput(node, { payload: {} });
  assert.equal(err, undefined);
  assert.deepEqual(outputs[0][0].payload.messages.map((m) => m.name), ['MISSION_CLEAR_ALL']);
});

test('a busy lock refuses a second same-type transfer on the node', async () => {
  const conn = new StubConnection();
  // First transfer never completes (no reply), so the lock stays held.
  conn.onSend(() => {});
  const Node = loadNode(conn);

  const first = new Node({ operation: 'download', connection: 'conn', delivery: 'confirm', missionType: 'mission', id: 'a' });
  const second = new Node({ operation: 'download', connection: 'conn', delivery: 'confirm', missionType: 'mission', id: 'b' });

  // Start the first (leaves the lock held; its promise never settles here).
  const firstOutputs = [];
  first.emit('input', { payload: {} }, (m) => firstOutputs.push(m), () => {});

  const { outputs } = await runInput(second, { payload: {} });
  assert.equal(outputs.at(-1)[1].phase, 'locked');

  // Clean up the held lock so the shared registry does not leak into other tests.
  first.emit('close', () => {});
});

test('an unknown wire-tier operation craters loud and frees the lock (#222)', async () => {
  const conn = new StubConnection();
  conn.vehicle = { firmware: 'ardupilot', targetSystem: 1, targetComponent: 1 };
  const Node = loadNode(conn);

  // Hand-edited operation: createMachine matches no case and returns
  // undefined, so the wire tier craters on the start() dereference.
  const broken = new Node({ operation: 'downlaod', connection: 'conn', delivery: 'confirm', missionType: 'mission', id: 'a' });
  const res = await runInput(broken, { payload: {} });
  assert.ok(res.err, 'an unknown operation must fail loud');
  assert.match(String(res.err), /reading 'start'/);
  assert.equal(conn.sent.length, 0, 'nothing reached the wire');
  assert.equal(conn.subscriberCount(), 0, 'no subscription opened');
  assert.equal(res.outputs[0][0], null, 'output 0 stays silent');
  assert.equal(res.outputs[0][1].result, 'failed');

  // The crater must not strand the lock: a real download on the same
  // (connection, target, type) runs instead of reporting "busy".
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', fields: { count: 0, mission_type: 0 } });
    }
  });
  const next = new Node({ operation: 'download', connection: 'conn', delivery: 'confirm', missionType: 'mission', id: 'b' });
  const after = await runInput(next, { payload: {} });
  assert.notEqual(after.outputs.at(-1)[1].phase, 'locked', 'the lock came free after the crater');
  assert.equal(after.outputs.at(-1)[1].result, 'succeeded');
});

test('mission companion identity: target derived from airframe sysid, compid pinned to 1', async () => {
  const conn = new StubConnection();
  conn.vehicle = { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' };
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      // Deliver MISSION_COUNT from the companion-derived sysid 42.
      deliver({ name: 'MISSION_COUNT', sysid: 42, compid: 1, fields: { count: 0, mission_type: 0 } });
    }
  });
  const identityNode = { derivesSysidFromVehicle: true, getIdentity: () => ({ sysid: 42, compid: 191 }) };
  const Node = loadNode(conn, { identity: identityNode });
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'confirm',
    identity: 'identity',
    missionType: 'mission',
    targetSystem: '',
    targetComponent: '',
  });

  const { outputs } = await runInput(node, { payload: {} });
  const terminal = outputs.at(-1);
  // Target must be {sysid: 42, compid: 1} — derived from companion, not profile default.
  assert.equal(terminal[1].target.sysid, 42, 'companion derives sysid from airframe');
  assert.equal(terminal[1].target.compid, 1, 'companion pins compid to 1 (autopilot)');
  assert.equal(terminal[1].result, 'succeeded');
});

test('mission companion: payload.target overrides companion derivation', async () => {
  const conn = new StubConnection();
  conn.vehicle = { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' };
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      deliver({ name: 'MISSION_COUNT', sysid: 50, compid: 1, fields: { count: 0, mission_type: 0 } });
    }
  });
  const identityNode = { derivesSysidFromVehicle: true, getIdentity: () => ({ sysid: 42, compid: 191 }) };
  const Node = loadNode(conn, { identity: identityNode });
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'confirm',
    identity: 'identity',
    missionType: 'mission',
  });

  // payload.target.sysid = 50 overrides companion derivation.
  const { outputs } = await runInput(node, { payload: { target: { sysid: 50 } } });
  const terminal = outputs.at(-1);
  assert.equal(terminal[1].target.sysid, 50, 'payload.target.sysid overrides companion derivation');
  assert.equal(terminal[1].result, 'succeeded');
});

test('mission build tier inherits from config.vehicle (sysid 77, compid 78)', async () => {
  const conn = new StubConnection();
  const vehicleNode = { defaultTargetSystem: 77, defaultTargetComponent: 78, firmware: 'ardupilot' };
  const Node = loadNode(conn, { veh: vehicleNode });
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'build',
    dialect: '__vehicle',
    vehicle: 'veh',
    missionType: 'mission',
    targetSystem: '',
    targetComponent: '',
  });

  const { outputs } = await runInput(node, { payload: {} });
  const plan = outputs[0][0].payload;
  assert.equal(plan.target.sysid, 77, 'build tier target sysid from config.vehicle');
  assert.equal(plan.target.compid, 78, 'build tier target compid from config.vehicle');
});

test('mission protocol subscription keyed on resolved target (companion sysid 42)', async () => {
  // Verify that when companion derives sysid=42, the machine subscribes to sysid=42
  // and responses from sysid=1 are not accepted.
  const conn = new StubConnection();
  conn.vehicle = { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' };

  // Deliver MISSION_COUNT from sysid=1 first (should be ignored since subscription is sysid=42).
  // Then deliver from sysid=42 (should be accepted).
  let sendCount = 0;
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_REQUEST_LIST') {
      sendCount += 1;
      if (sendCount === 1) {
        // Wrong sysid — subscription filter should reject it.
        deliver({ name: 'MISSION_COUNT', sysid: 1, compid: 1, fields: { count: 0, mission_type: 0 } });
        // Correct sysid — should complete the download.
        deliver({ name: 'MISSION_COUNT', sysid: 42, compid: 1, fields: { count: 0, mission_type: 0 } });
      }
    }
  });

  const identityNode = { derivesSysidFromVehicle: true, getIdentity: () => ({ sysid: 42, compid: 191 }) };
  const Node = loadNode(conn, { identity: identityNode });
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'confirm',
    identity: 'identity',
    missionType: 'mission',
  });

  const { outputs } = await runInput(node, { payload: {} });
  const terminal = outputs.at(-1);
  // The download must succeed driven by the sysid=42 response, not the sysid=1 one.
  assert.equal(terminal[1].result, 'succeeded', 'download completes using sysid=42 response');
  assert.equal(terminal[1].target.sysid, 42);
});
