'use strict';

/**
 * mavlink-mission node tests (DESIGN.md §9 chain model, §6, §13). Exercises the
 * thin wrapper: the suppress guard, the Build tier plan, the clear confirmation
 * gate, firmware gating at the node, and an end-to-end download
 * whose progress and terminal records land on output 1 while success fires
 * output 0.
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

test('Build tier refuses a missing operation instead of planning an upload', async () => {
  // buildPlan's catch-all `else` treated every unknown operation as upload, so
  // a node with no operation answered Build with a zero-item MISSION_COUNT plan
  // and `succeeded` — the wire tier's createMachine rejects the same input.
  // Build must not be the softer of the two doors (Codex, #222).
  const conn = new StubConnection();
  const Node = loadNode(conn);
  const node = new Node({ connection: 'conn', delivery: 'build', dialect: 'common', missionType: 'mission' });
  const { outputs, err } = await runInput(node, { payload: {} });

  assert.ok(err, 'a missing operation must fail loud');
  assert.match(String(err), /unknown mission operation/);
  assert.equal(conn.sent.length, 0);
  assert.ok(
    !outputs.some((o) => o[0] && o[0].payload && o[0].payload.messages),
    'no plan is emitted on output 0'
  );
});

test('mission Build concrete dialect uses config firmware and no Vehicle Profile target rung', async () => {
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
  assert.notEqual(outputs[0][0], null, 'concrete Build dialect must build rather than gate on stale profile firmware');
  const plan = outputs[0][0].payload;
  assert.equal(plan.missionType, 1, 'ardupilot config firmware permits fence');
  assert.ok(Number.isNaN(plan.target.sysid), 'concrete Build dialect has no profile sysid rung');
  assert.ok(Number.isNaN(plan.target.compid), 'concrete Build dialect has no profile compid rung');
});

test('firmware gating: PX4 refuses a fence transfer at the node (§11)', async () => {
  const conn = new StubConnection();
  // Vehicle profile with px4 firmware — the node must consult the profile, not config.firmware.
  conn.vehicle = { firmware: 'px4', targetSystem: 1, targetComponent: 1 };
  const Node = loadNode(conn);
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'confirm',
    missionType: 'fence',
  });
  const { outputs } = await runInput(node, { payload: {} });
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0][0], null);
  assert.equal(outputs[0][1].phase, 'gated');
});

test('clear is refused without confirmation and runs once confirmed', async () => {
  const conn = new StubConnection();
  conn.vehicle = { firmware: 'ardupilot', targetSystem: 1, targetComponent: 1 };
  conn.onSend((message, deliver) => {
    if (message.name === 'MISSION_CLEAR_ALL') {
      deliver({ name: 'MISSION_ACK', fields: { type: 0, mission_type: 0 } });
    }
  });

  const Node = loadNode(conn);

  const unconfirmed = new Node({ operation: 'clear', connection: 'conn', delivery: 'confirm', confirmClear: false });
  let res = await runInput(unconfirmed, { payload: {} });
  assert.equal(res.outputs[0][0], null);
  assert.equal(res.outputs[0][1].phase, 'unconfirmed');
  assert.equal(conn.sent.length, 0, 'nothing sent without confirmation');

  const confirmed = new Node({ operation: 'clear', connection: 'conn', delivery: 'confirm', confirmClear: true });
  res = await runInput(confirmed, { payload: {} });
  const last = res.outputs.at(-1);
  assert.equal(last[0].payload.result, 'succeeded', 'continue port fires on success');
  assert.equal(last[1].result, 'succeeded');
  assert.equal(conn.sentNames().includes('MISSION_CLEAR_ALL'), true);
});

test('clear Build tier is gated before the plan is built (§9 destructive gate)', async () => {
  const conn = new StubConnection();
  const Node = loadNode(conn);

  // Build tier + no confirmation → no MISSION_CLEAR_ALL plan on output 0.
  const unconfirmed = new Node({ operation: 'clear', connection: 'conn', delivery: 'build', confirmClear: false });
  const refused = await runInput(unconfirmed, { payload: {} });
  assert.equal(refused.outputs.length, 1);
  assert.equal(refused.outputs[0][0], null, 'no destructive plan emitted on output 0 without confirm');
  assert.equal(refused.outputs[0][1].phase, 'unconfirmed');

  // Build tier + confirmation → the plan is produced.
  const confirmed = new Node({ operation: 'clear', connection: 'conn', delivery: 'build', confirmClear: true });
  const ok = await runInput(confirmed, { payload: {} });
  assert.deepEqual(ok.outputs[0][0].payload.messages.map((m) => m.name), ['MISSION_CLEAR_ALL']);
});

test('firmware gate follows the Connection Vehicle Profile, not stale node config (§11)', async () => {
  const conn = new StubConnection();
  // Bound profile is PX4; the node config independently (and stalely) says ardupilot.
  conn.vehicle = { firmware: 'px4', targetSystem: 1, targetComponent: 1 };
  const Node = loadNode(conn);
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'confirm', // wire tier — profile comes from conn.vehicle
    firmware: 'ardupilot', // stale config value, must NOT be consulted
    missionType: 'fence',
  });

  const { outputs } = await runInput(node, { payload: {} });
  assert.equal(outputs[0][1].phase, 'gated', 'PX4 profile gates the fence transfer');
  assert.match(outputs[0][1].reason, /px4/);
});

test('payload.firmware overrides profile firmware', async () => {
  const conn = new StubConnection();
  // Profile is ardupilot (allows fence), but payload overrides to px4 (blocks fence).
  conn.vehicle = { firmware: 'ardupilot', targetSystem: 1, targetComponent: 1 };
  const Node = loadNode(conn);
  const node = new Node({
    operation: 'download',
    connection: 'conn',
    delivery: 'confirm',
    missionType: 'fence',
  });

  const { outputs } = await runInput(node, { payload: { firmware: 'px4' } });
  assert.equal(outputs[0][1].phase, 'gated', 'payload.firmware=px4 gates the fence transfer');
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
