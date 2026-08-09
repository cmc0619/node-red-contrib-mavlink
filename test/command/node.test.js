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

const { StubPeerTable } = require('../../lib/command/test/stubs/connection');

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
    resolveSourceIds: () => null,
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
  const conn = connStub({ id: 'vehicle', targetSystem: 1, targetComponent: 1 });
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

  function runFailedInput() {
    return new Promise((resolve, reject) => {
      let outputCaptured = false;
      let doneCalled = false;
      const finishWhenTerminal = () => {
        if (outputCaptured && doneCalled) resolve();
      };

      node.emit(
        'input',
        { payload: { 5: -35, 6: 149, 7: 50 } },
        (messages) => {
          outputs.push(messages);
          outputCaptured = true;
          finishWhenTerminal();
        },
        (err) => {
          try {
            assert.ok(err instanceof Error, 'done(err) receives the dialect failure');
            doneErrors.push(err);
            doneCalled = true;
            finishWhenTerminal();
          } catch (assertionError) {
            reject(assertionError);
          }
        }
      );
    });
  }

  for (let i = 0; i < 2; i++) {
    await runFailedInput();
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
  const conn = connStub({ targetSystem: 42, targetComponent: 191 });
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
  const conn = connStub({ targetSystem: 42, targetComponent: 191 });
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

test('resolveTarget: companion identity derives {airframe sysid, 1} as target', async () => {
  const identityStub = {
    role: 'companion',
    derivesSysidFromVehicle: true,
    getIdentity: () => ({ sysid: 42, compid: 191 }),
  };
  const conn = connStub({ targetSystem: 99, targetComponent: 99 });
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
  const conn = connStub({ targetSystem: 99, targetComponent: 99 });
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
  const conn = connStub({ targetSystem: 42, targetComponent: 191 });
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
  const conn = connStubWithInject({ targetSystem: 1, targetComponent: 1 });
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

test('blank Command timeout keeps the 10000 ms ACK window', async (t) => {
  const timers = installAckTimerHarness(t);
  const conn = connStubWithInject();
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
    timeout: '',
    maxRetries: '3',
  });

  node.emit('input', { payload: null }, () => {}, () => {});
  await Promise.resolve();

  assert.equal(timers.delays[0], 10000);
  conn.injectAck({ command: 400, result: 0 }, 1, 1);
  await new Promise((resolve) => setImmediate(resolve));
  node.emit('close', () => {});
});

test('blank Command maxRetries keeps three temporary-rejection retries', async (t) => {
  installAckTimerHarness(t);
  const conn = connStubWithInject();
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
    timeout: '10000',
    maxRetries: '',
  });
  let output;

  node.emit('input', { payload: null }, (messages) => { output = messages; }, () => {});
  await Promise.resolve();
  for (let retry = 1; retry <= 3; retry++) {
    conn.injectAck({ command: 400, result: 1 }, 1, 1);
    await Promise.resolve();
    assert.equal(conn.sent.length, retry + 1, `retry ${retry} is sent`);
  }
  conn.injectAck({ command: 400, result: 1 }, 1, 1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    conn.sent.map(({ message }) => message.fields.confirmation),
    [0, 1, 2, 3]
  );
  assert.equal(output[0], null);
  assert.equal(output[1].retries, 3);
  node.emit('close', () => {});
});

function installAckTimerHarness(t) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const active = new Set();
  const delays = [];

  globalThis.setTimeout = (fn, delay) => {
    const handle = {};
    active.add(handle);
    delays.push(delay);
    if (delay === 1000) {
      queueMicrotask(() => {
        if (active.delete(handle)) fn();
      });
    }
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    active.delete(handle);
  };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  return { delays };
}

function connStubWithInject(vehicleOverride) {
  const subs = [];
  const sent = [];
  return {
    subs,
    sent,
    peerTable: null,
    vehicle: vehicleOverride !== undefined
      ? vehicleOverride
      : { targetSystem: 1, targetComponent: 1 },
    send(message, opts) { sent.push({ message, opts }); },
    resolveSourceIds: () => null,
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
      : { targetSystem: 1, targetComponent: 1 },
    send(message, opts) { sent.push({ message, opts }); },
    resolveSourceIds: () => null,
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

test('a redeploy-cancelled ack wait finishes quietly, not as a command failure (#54/#57)', async () => {
  // close() cancels the in-flight AckWaiter, which settles the run as
  // 'cancelled'. That used to fall into the generic terminal-failure branch:
  // status + done(err) on a node being torn down, so any Catch node wired for
  // "command failed → failsafe" fired on a mere redeploy. mavlink-mission
  // already had the quiet branch; command and payload did not.
  const subs = [];
  const connection = {
    peerTable: null,
    vehicle: null,
    // Never answers — the wait can only end by cancellation.
    send() {},
    resolveSourceIds: () => null,
    subscribe(filter, handler) {
      const entry = { filter, handler };
      subs.push(entry);
      return () => {
        const i = subs.indexOf(entry);
        if (i >= 0) subs.splice(i, 1);
      };
    },
  };
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    connection: 'conn',
    carrier: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'confirm',
    targetSystem: '1',
    targetComponent: '1',
    timeout: '60000',
    maxRetries: '0',
  });

  let emitted = false;
  let doneErr = 'not-called';
  node.emit('input', { payload: {} }, () => { emitted = true; }, (err) => { doneErr = err; });
  await tick();

  // The redeploy.
  await new Promise((resolve) => node.emit('close', resolve));
  await tick();
  await tick();

  assert.equal(doneErr, undefined, 'done() called with no error — a cancel is not a failure');
  assert.equal(emitted, false, 'nothing is emitted onto a node being torn down');
});

test('a redeploy-cancelled completion wait finishes quietly (accepted-risk M1)', async () => {
  // Complete tier: after ACCEPTED the node awaits waitForCompletion. Without a
  // cancel handle, close() left its poll + timeout running for up to
  // completionTimeout (60 s default), after which the handler resumed and
  // emitted status/records onto the closed node.
  const conn = connStubWithInject();
  conn.peerTable = new StubPeerTable();
  conn.peerTable.setComponent(1, 1, { armed: false }); // ARM never satisfies
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    connection: 'conn',
    carrier: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'complete',
    targetSystem: '1',
    targetComponent: '1',
    timeout: '60000',
    maxRetries: '0',
  });

  let emitted = false;
  let doneErr = 'not-called';
  node.emit('input', { payload: {} }, () => { emitted = true; }, (err) => { doneErr = err; });
  await tick();

  // ACCEPTED moves the run into the completion wait.
  conn.injectAck({ command: 400, result: 0 }, 1, 1);
  await tick();

  // The redeploy, mid-wait.
  await new Promise((resolve) => node.emit('close', resolve));
  await tick();
  await tick();

  assert.equal(doneErr, undefined, 'done() called with no error — a cancel is not a failure');
  assert.equal(emitted, false, 'nothing is emitted onto a node being torn down');
});
