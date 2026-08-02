'use strict';

/**
 * mavlink-command node tests (DESIGN.md §9). Covers the review findings:
 *   - safety confirmation requires a strict boolean true (not a truthy token)
 *   - the status record is emitted as the top-level message on output 1
 *   - the Build tier reports a 'built' status record on output 1
 *   - the async input handler contains throws/rejections as a terminal status
 *     plus done(err), never an unhandled rejection
 *
 * A minimal Node-RED stub drives the node constructor; no live runtime.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Build tier: output 0 carries the COMMAND_LONG and output 1 a top-level status record', async () => {
  const RED = redStub({});
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({ carrier: 'long', mode: 'preset', preset: 'arm', delivery: 'build' });

  let sent;
  node.emit('input', { payload: null }, (m) => { sent = m; }, () => {});
  await tick();

  assert.ok(sent, 'outputs fired');
  assert.equal(sent[0].payload.name, 'COMMAND_LONG');
  assert.equal(sent[1].result, 'built');
});

test('Build tier with carrier int: output 0 carries a COMMAND_INT with config frame and degE7 coords', async () => {
  const RED = redStub({});
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  // reposition (MAV_CMD_DO_REPOSITION) carries lat/lon in params 5/6 —
  // entered as degrees, scaled to degE7 by the INT carrier (§9).
  const node = new Node({
    carrier: 'int',
    frame: '3', // GLOBAL_RELATIVE_ALT
    mode: 'preset',
    preset: 'reposition',
    delivery: 'build',
    targetSystem: '1',
    targetComponent: '1',
  });

  let sent;
  node.emit('input', { payload: { 5: -35, 6: 149, 7: 50 } }, (m) => { sent = m; }, () => {});
  await tick();

  assert.ok(sent, 'outputs fired');
  assert.equal(sent[0].payload.name, 'COMMAND_INT');
  assert.equal(sent[0].payload.fields.frame, 3, 'config.frame reaches the built message');
  assert.equal(sent[0].payload.fields.x, -350000000);
  assert.equal(sent[0].payload.fields.y, 1490000000);
  assert.equal(sent[0].payload.fields.z, 50);
  assert.equal('confirmation' in sent[0].payload.fields, false);
  assert.equal(sent[1].result, 'built');
});

test('Safety preset refuses a truthy-but-non-boolean confirmation token', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'flight_termination',
    delivery: 'confirm',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
  });

  let sent;
  // The string "false" is truthy — it must NOT arm a safety command.
  node.emit('input', { payload: { 1: 1 }, confirmed: 'false' }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(sent[0], null, 'output 0 must not fire');
  assert.equal(sent[1].result, 'unconfirmed');
  assert.equal(conn.sent.length, 0, 'nothing is sent to the vehicle');
});

test('Safety preset Build tier also requires msg.confirmed === true', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'flight_termination',
    delivery: 'build',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
  });

  let sent;
  node.emit('input', { payload: { 1: 1 } }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(sent[0], null, 'build must not emit an unconfirmed safety command');
  assert.equal(sent[1].result, 'unconfirmed');
});

test('Safety preset with confirmed === true proceeds to send the command', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'flight_termination',
    delivery: 'confirm',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
    timeout: '2000',
  });

  node.emit('input', { payload: { 1: 1 }, confirmed: true }, () => {}, () => {});
  await tick();

  assert.equal(conn.sent.length, 1, 'boolean true arms the command');
  assert.equal(conn.sent[0].message.fields.command, 185);

  node.emit('close', () => {});
});

test('Async handler contains a throw as a terminal failed status plus done(err)', async () => {
  const conn = {
    // Throws when the AckWaiter tries to subscribe.
    subscribe() { throw new Error('boom'); },
    send() {},
  };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'confirm',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
  });

  let sent;
  let doneErr;
  node.emit('input', { payload: { 1: 1 } }, (m) => { sent = m; }, (err) => { doneErr = err; });
  await tick();

  assert.ok(sent, 'a terminal status was emitted');
  assert.equal(sent[0], null);
  assert.equal(sent[1].result, 'failed');
  assert.ok(sent[1].detail.includes('boom'));
  assert.ok(doneErr instanceof Error, 'done(err) was called');
});

test('two consecutive INT inputs both fail loud when dialect lookup fails', async () => {
  let dialectLookups = 0;
  const vehicle = {
    getDialect() {
      dialectLookups++;
      throw new Error('temporary dialect failure');
    },
  };
  const conn = connStub({ id: 'vehicle', targetSysid: 1, targetCompid: 1 });
  const RED = redStub({ conn, vehicle });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'int',
    frame: '3',
    mode: 'preset',
    preset: 'reposition',
    delivery: 'send',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
    timeout: '10000',
    maxRetries: '3',
  });
  const outputs = [];
  const doneErrors = [];

  for (let i = 0; i < 2; i++) {
    node.emit(
      'input',
      { payload: { 5: -35, 6: 149, 7: 50 } },
      (messages) => { outputs.push(messages); },
      (err) => { doneErrors.push(err); }
    );
    await tick();
  }

  assert.equal(dialectLookups, 2, 'failed lookup is retried for the next input');
  assert.equal(conn.sent.length, 0, 'no historically scaled command reaches the wire');
  assert.equal(outputs.length, 2);
  assert.equal(doneErrors.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(outputs[i][0], null, 'output 0 stays terminally silent');
    assert.equal(outputs[i][1].result, 'failed');
    assert.match(outputs[i][1].detail, /temporary dialect failure/);
    assert.match(doneErrors[i].message, /temporary dialect failure/);
  }
});

test('resolveTarget: wire tier empty config inherits Vehicle Profile target from connNode.vehicle', async () => {
  const conn = connStub({ targetSysid: 42, targetCompid: 191 });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  // Wire tier (send) with empty target config — must inherit from connNode.vehicle.
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'send',
    connection: 'conn',
    targetSystem: '',
    targetComponent: '',
  });

  let sent;
  node.emit('input', { payload: null }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(sent[0].payload.fields.target_system, 42);
  assert.equal(sent[0].payload.fields.target_component, 191);
});

test('resolveTarget: explicit config value wins over Vehicle Profile', async () => {
  const conn = connStub({ targetSysid: 42, targetCompid: 191 });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'build',
    connection: 'conn',
    targetSystem: '7',
    targetComponent: '100',
  });

  let sent;
  node.emit('input', { payload: null }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(sent[0].payload.fields.target_system, 7);
  assert.equal(sent[0].payload.fields.target_component, 100);
});

test('Send/confirm tier with no connection fails loud instead of silently building', async () => {
  const RED = redStub({});
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  // No connection bound but delivery is confirm — this must not degrade to Build.
  const node = new Node({ carrier: 'long', mode: 'preset', preset: 'arm', delivery: 'confirm' });

  let sent;
  let doneError;
  node.emit(
    'input',
    { payload: { 1: 1 } },
    (m) => { sent = m; },
    (err) => { doneError = err; }
  );
  await tick();

  assert.equal(sent[0], null, 'output 0 must not fire');
  assert.equal(sent[1].result, 'failed');
  assert.ok(/no connection/.test(sent[1].detail));
  assert.match(doneError.message, /no connection/);
});

test('resolveTarget: companion identity derives {airframe sysid, 1} as target', async () => {
  const identityStub = {
    role: 'companion',
    derivesSysidFromVehicle: true,
    getIdentity: () => ({ sysid: 42, compid: 191 }),
  };
  const conn = connStub({ targetSysid: 99, targetCompid: 99 });
  const RED = redStub({ conn, identity: identityStub });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'send',
    connection: 'conn',
    identity: 'identity',
    targetSystem: '',
    targetComponent: '',
  });

  let sent;
  node.emit('input', { payload: null }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(sent[0].payload.fields.target_system, 42, 'companion sysid derived from airframe');
  assert.equal(sent[0].payload.fields.target_component, 1, 'companion compid pinned to 1');
});

test('resolveTarget: msg.payload.target overrides companion derivation', async () => {
  const identityStub = {
    role: 'companion',
    derivesSysidFromVehicle: true,
    getIdentity: () => ({ sysid: 42, compid: 191 }),
  };
  const conn = connStub({ targetSysid: 99, targetCompid: 99 });
  const RED = redStub({ conn, identity: identityStub });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'send',
    connection: 'conn',
    identity: 'identity',
    targetSystem: '',
    targetComponent: '',
  });

  let sent;
  node.emit('input', { payload: { target: { sysid: 10, compid: 20 } } }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(sent[0].payload.fields.target_system, 10, 'payload.target.sysid wins over companion derivation');
  assert.equal(sent[0].payload.fields.target_component, 20, 'payload.target.compid wins over companion derivation');
});

test('resolveTarget: config 0 is broadcast and survives (new semantics)', async () => {
  const conn = connStub({ targetSysid: 42, targetCompid: 191 });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'send',
    connection: 'conn',
    targetSystem: '0',
    targetComponent: '0',
  });

  let sent;
  node.emit('input', { payload: null }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(sent[0].payload.fields.target_system, 0, 'config 0 = broadcast, must not be treated as inherit');
  assert.equal(sent[0].payload.fields.target_component, 0, 'config 0 compid = broadcast, must not be treated as inherit');
});

test('resolveTarget: build tier inherits from config.vehicle profile stub', async () => {
  const vehicleStub = {
    defaultTargetSystem: 77,
    defaultTargetComponent: 78,
    firmware: 'ardupilot',
  };
  const RED = redStub({ vehicle: vehicleStub });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'build',
    dialect: '__vehicle',
    vehicle: 'vehicle',
    targetSystem: '',
    targetComponent: '',
  });

  let sent;
  node.emit('input', { payload: null }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(sent[0].payload.fields.target_system, 77, 'build tier inherits sysid from config.vehicle');
  assert.equal(sent[0].payload.fields.target_component, 78, 'build tier inherits compid from config.vehicle');
});

test('resolveTarget: build tier ignores config.vehicle profile unless dialect is __vehicle', async () => {
  const vehicleStub = {
    defaultTargetSystem: 77,
    defaultTargetComponent: 78,
    firmware: 'ardupilot',
  };
  const RED = redStub({ vehicle: vehicleStub });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'build',
    dialect: 'common',
    vehicle: 'vehicle',
    targetSystem: '',
    targetComponent: '',
  });

  let sent;
  node.emit('input', { payload: null }, (m) => { sent = m; }, () => {});
  await tick();

  assert.ok(Number.isNaN(sent[0].payload.fields.target_system), 'non-__vehicle Build does not inherit sysid from config.vehicle');
  assert.ok(Number.isNaN(sent[0].payload.fields.target_component), 'non-__vehicle Build does not inherit compid from config.vehicle');
});

test('ack-matcher pin: companion target used for COMMAND_ACK matching; ack from sysid 1 ignored', async () => {
  const identityStub = {
    role: 'companion',
    derivesSysidFromVehicle: true,
    getIdentity: () => ({ sysid: 42, compid: 191 }),
  };
  const conn = connStubWithInject({ targetSysid: 1, targetCompid: 1 });
  const RED = redStub({ conn, identity: identityStub });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'arm',   // commandId 400
    delivery: 'confirm',
    connection: 'conn',
    identity: 'identity',
    targetSystem: '',
    targetComponent: '',
    timeout: '5000',
  });

  let result;
  node.emit('input', { payload: null }, (m) => { result = m; }, () => {});
  await tick();

  // Wrong source — sysid 1 must not settle the transaction.
  conn.injectAck({ command: 400, result: 0 }, 1, 1);
  await tick();
  assert.equal(result, undefined, 'ack from sysid 1 must not settle the transaction');

  // Correct source — sysid 42 compid 1 (companion derived target) must settle.
  conn.injectAck({ command: 400, result: 0 }, 42, 1);
  await tick();

  assert.ok(result, 'ack from companion-derived target settles the transaction');
  assert.equal(result[1].result, 'accepted');

  node.emit('close', () => {});
});

function connStubWithInject(vehicleOverride) {
  const subs = [];
  const sent = [];
  return {
    subs,
    sent,
    peerTable: null,
    vehicle: vehicleOverride !== undefined
      ? vehicleOverride
      : { targetSysid: 1, targetCompid: 1 },
    send(message, opts) { sent.push({ message, opts }); },
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

function connStub(vehicleOverride) {
  const subs = [];
  const sent = [];
  return {
    subs,
    sent,
    peerTable: null,
    vehicle: vehicleOverride !== undefined
      ? vehicleOverride
      : { targetSysid: 1, targetCompid: 1 },
    send(message, opts) { sent.push({ message, opts }); },
    subscribe(filter, handler) {
      const entry = { filter, handler };
      subs.push(entry);
      return () => {
        const i = subs.indexOf(entry);
        if (i >= 0) subs.splice(i, 1);
      };
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
    httpAdmin: { get() {} },
    auth: { needsPermission() { return (_req, _res, next) => next && next(); } },
  };
}
