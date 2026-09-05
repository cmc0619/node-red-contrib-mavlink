'use strict';

/**
 * mavlink-command node tests (DESIGN.md §9). Covers the review findings:
 *   - safety presets pack and send without a confirm gate (operator chose the preset)
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

const { StubPeerTable } = require('./stubs/connection');
const { loadBundled } = require('../../lib/metadata/bundled');

const COMMON_BUNDLE = loadBundled('common');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Build tier: output 0 carries the COMMAND_LONG and output 1 a top-level status record', async () => {
  const RED = redStub({});
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({ params: '{}', sendAs: 'long', mode: 'preset', preset: 'arm', delivery: 'build' });

  let sent;
  node.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});
  await tick();

  assert.ok(sent, 'outputs fired');
  assert.ok(sent[0], sent[1] && sent[1].detail);
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
    params: '{}',
    sendAs: 'int',
    frame: '3', // GLOBAL_RELATIVE_ALT
    mode: 'preset',
    preset: 'reposition',
    delivery: 'build',
    dialect: 'common',
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

test('Build tier: payload.mode resolves through the AP profile into param2', async () => {
  const { loadBundled } = require('../../lib/metadata/bundled');
  const vehicle = {
    defaultTargetSystem: 1,
    defaultTargetComponent: 1,
    firmware: 'ardupilot',
    vehicleFamily: 'copter',
    getDialect: () => loadBundled('ardupilotmega'),
  };
  const RED = redStub({ veh: vehicle });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'set_mode',
    delivery: 'build',
    dialect: '__vehicle',
    vehicle: 'veh',
  });

  let sent;
  node.emit('input', { payload: { mode: 'GUIDED' } }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(sent[0].payload.fields.param2, 4, 'COPTER_MODE_GUIDED');
  assert.equal(sent[0].payload.fields.param1, 1, 'custom-mode-enabled bit set');

  // An unknown name builds NaN — the loud tail, nothing invented (§5).
  let bad;
  node.emit('input', { payload: { mode: 'WARP_9' } }, (m) => { bad = m; }, () => {});
  await tick();
  assert.equal(Number.isNaN(bad[0].payload.fields.param2), true);
});

test('Build tier: an explicit custom-mode param suppresses the whole named pair', async () => {
  // PX4's resolution is a pair (param2 main_mode, param3 sub_mode). Filling one
  // side from the name while the flow supplied the other would command a mode
  // nobody asked for — main 5 with Hold's sub 3 maps to nothing (Gitar, #346).
  const { loadBundled } = require('../../lib/metadata/bundled');
  const vehicle = {
    defaultTargetSystem: 1,
    defaultTargetComponent: 1,
    firmware: 'px4',
    vehicleFamily: 'copter',
    getDialect: () => loadBundled('common'),
  };
  const RED = redStub({ veh: vehicle });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'set_mode',
    delivery: 'build',
    dialect: '__vehicle',
    vehicle: 'veh',
  });

  // Name alone: the decomposed pair rides (Hold = main 4, sub 3).
  let named;
  node.emit('input', { payload: { mode: 'Hold' } }, (m) => { named = m; }, () => {});
  await tick();
  assert.equal(named[0].payload.fields.param2, 4, 'main_mode from the name');
  assert.equal(named[0].payload.fields.param3, 3, 'sub_mode from the name');

  // Name plus an explicit param2: the number wins whole, so the name's sub
  // must NOT leak into param3 and mint a combination never requested.
  let mixed;
  node.emit('input', { payload: { mode: 'Hold', 2: 5 } }, (m) => { mixed = m; }, () => {});
  await tick();
  assert.equal(mixed[0].payload.fields.param2, 5, 'explicit number wins');
  assert.notEqual(mixed[0].payload.fields.param3, 3, "the name's sub_mode must not ride along");
});

test('Safety preset Build tier packs Flight Termination without a confirm gate', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    sendAs: 'long',
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

  assert.equal(sent[1].result, 'built');
  assert.equal(sent[0].payload.fields.command, 185);
});

test('Safety preset Send tier packs Flight Termination without a confirm gate', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'flight_termination',
    delivery: 'send',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
  });

  node.emit('input', { payload: { 1: 1 } }, () => {}, () => {});
  await tick();

  assert.equal(conn.sent.length, 1, 'selecting the preset is enough to send');
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
    params: '{}',
    sendAs: 'long',
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
    params: '{}',
    sendAs: 'int',
    frame: '3',
    mode: 'preset',
    preset: 'reposition',
    delivery: 'send',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
    timeoutMs: '10000',
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
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'send',
    connection: 'conn',
    targetSystem: '',
    targetComponent: '',
  });

  let sent;
  node.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});
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
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'build',
    connection: 'conn',
    targetSystem: '7',
    targetComponent: '100',
  });

  let sent;
  node.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});
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
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'send',
    connection: 'conn',
    identity: 'identity',
    targetSystem: '',
    targetComponent: '',
  });

  let sent;
  node.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});
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
    params: '{}',
    sendAs: 'long',
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
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'send',
    connection: 'conn',
    targetSystem: '0',
    targetComponent: '0',
  });

  let sent;
  node.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});
  await tick();

  assert.equal(sent[0].payload.fields.target_system, 0, 'config 0 = broadcast, must not be treated as inherit');
  assert.equal(sent[0].payload.fields.target_component, 0, 'config 0 compid = broadcast, must not be treated as inherit');
});

test('a broadcast target on the confirm tier still sends — the editor is what reds it (#260)', async () => {
  // One ack cannot answer for a fleet, so a *configured* sysid 0 on an acked
  // tier reds at deploy (mavlink-command.html targetSystem,
  // RED.mavlink.validateTargetSystem). A profile default or a
  // msg.payload.target override is trusted input and rides (§0).
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'confirm',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
  });

  node.emit('input', { payload: { target: { sysid: 0 } } }, () => {}, () => {});
  await tick();

  assert.equal(conn.sent.length, 1, 'the command reached the wire');
  assert.equal(conn.sent[0].message.fields.target_system, 0);
  node.emit('close', () => {});
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
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'build',
    dialect: '__vehicle',
    vehicle: 'vehicle',
    targetSystem: '',
    targetComponent: '',
  });

  let sent;
  node.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});
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
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'build',
    dialect: 'common',
    vehicle: 'vehicle',
    targetSystem: '',
    targetComponent: '',
  });

  let sent;
  node.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});
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
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',   // commandId 400
    delivery: 'confirm',
    connection: 'conn',
    identity: 'identity',
    targetSystem: '',
    targetComponent: '',
    timeoutMs: '5000',
  });

  let result;
  node.emit('input', { payload: {} }, (m) => { result = m; }, () => {});
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

test('a hand-edited garbage Command mode resolves no command — nothing is built', async () => {
  // Only Preset and Advanced are modes. A token the editor cannot save
  // (`mode` carries RED.mavlink.oneOf) matches neither, so no preset and no
  // command id resolve, and the message craters at the wire's own guard
  // rather than silently building the preset branch.
  const conn = connStubWithInject();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    sendAs: 'long',
    mode: 'presett',
    preset: 'arm',
    delivery: 'build',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
  });

  let sent;
  node.emit('input', { payload: {} }, (m) => { sent = m; }, () => {});
  await Promise.resolve();

  assert.ok(Number.isNaN(sent[0].payload.fields.command), 'no command id was resolved');
  assert.equal(conn.sent.length, 0, 'nothing reached the wire');
});

test('a silent ACK window sends once, then settles the unconfirmed record', async (t) => {
  // The harness fires the 1000 ms window timer via microtask, so the window
  // drains before the setImmediate below.
  installAckTimerHarness(t);
  const conn = connStubWithInject();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'confirm',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
    timeoutMs: '1000',
    maxRetries: '3',
  });
  let output;
  let doneErr;

  node.emit('input', { payload: {} }, (messages) => { output = messages; }, (err) => { doneErr = err; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(conn.sent.length, 1, 'the command is sent exactly once');
  // The §9 classification after the window: peer-table check (no table here)
  // → the unconfirmed record.
  assert.equal(output[0], null, 'output 0 must not fire');
  assert.equal(output[1].result, 'unconfirmed');
  assert.equal(output[1].resultCode, null);
  assert.equal(output[1].confirmedBy, undefined);
  assert.equal(output[1].retries, 0);
  assert.equal(output[1].detail, 'no terminal COMMAND_ACK received within timeout');
  assert.equal(doneErr, undefined, 'action failure halts via badge + output 1, not done(err)');
  node.emit('close', () => {});
});

// ── No-defaults ruling extended to Command (owner, 2026-08-14) ──────────────
// DESIGN.md §14 had left both sites explicitly un-ruled ("COMMAND_LONG is a
// defensible default"); the owner has now ruled the Move precedent applies.

test('a "Send as" token that is not a carrier builds nothing at all', async () => {
  // The carrier dispatch has one case per carrier and no default arm (§5), so
  // a blank or typo'd token selects neither COMMAND_LONG nor COMMAND_INT. The
  // editor's `sendAs` select is what reds it (RED.mavlink.oneOf).
  for (const sendAs of ['lng', '']) {
    const RED = redStub({});
    require('../../nodes/mavlink-command')(RED);
    const Node = RED.nodes.types['mavlink-command'];
    const node = new Node({ params: '{}', sendAs, mode: 'preset', preset: 'arm', delivery: 'build' });

    let output;
    node.emit('input', { payload: {} }, (m) => { output = m; }, () => {});
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(output[0].payload, undefined, 'the carrier selects no builder');
  }
});

test('a Delivery token the editor cannot save runs no tier at all (§5)', async () => {
  // Confirm/Complete used to be reached by falling *out* of the delivery
  // switch, so a typo of 'confirm' ran a full send-and-await AckWaiter
  // transaction against the vehicle. Every tier is its own arm now, and a
  // token the delivery select cannot save (RED.mavlink.oneOf,
  // mavlink-command.html) selects none of them.
  for (const delivery of ['cnfirm', '']) {
    const conn = connStubWithInject();
    const RED = redStub({ conn });
    require('../../nodes/mavlink-command')(RED);
    const Node = RED.nodes.types['mavlink-command'];
    const node = new Node({
      params: '{}',
      sendAs: 'long',
      mode: 'preset',
      preset: 'arm',
      delivery,
      connection: 'conn',
      targetSystem: '1',
      targetComponent: '1',
    });

    const outputs = [];
    let err;
    let doneCalls = 0;
    node.emit(
      'input',
      { payload: { 1: 1 } },
      (m) => { outputs.push(m); },
      (e) => { doneCalls += 1; err = e; }
    );
    await tick();
    node.emit('close', () => {});

    assert.equal(conn.sent.length, 0, `delivery "${delivery}" must not reach the wire`);
    assert.equal(conn.subs.length, 0, 'no ack wait was opened');
    assert.equal(outputs.length, 0, 'no tier ran, so no outcome was reported');
    assert.equal(doneCalls, 1, 'the input is still completed');
    assert.equal(err, undefined, 'a no-op is not a failure');
  }
});

test('Advanced mode never reads preset — an unset preset field does not refuse', async () => {
  // The editor default is 'arm', never blank, but Advanced mode ignores the
  // field entirely (resolveCommandId reads advancedCommand instead); the
  // preset guard must not fire there.
  const RED = redStub({});
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    sendAs: 'long',
    mode: 'advanced',
    advancedCommand: '400', // MAV_CMD_COMPONENT_ARM_DISARM
    preset: 'not-a-real-preset',
    delivery: 'build',
  });

  let output;
  node.emit('input', { payload: { 1: 1 } }, (m) => { output = m; }, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(output[1].result, 'built');
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
    peerTable: { getComponent: () => undefined },
    vehicle: vehicleOverride !== undefined
      ? vehicleOverride
      : { id: 'vehicleProfile', targetSystem: 1, targetComponent: 1 },
    send(message, opts) { sent.push({ message, opts }); },
    resolveSourceIds: () => ({ sysid: 255, compid: 190 }),
    subscribe(filter, handler) {
      const entry = { filter, handler };
      subs.push(entry);
      return () => {
        const i = subs.indexOf(entry);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    // The decoder zero-fills omitted target_system/target_component (§14).
    injectAck(fields, sysid, compid) {
      const decoded = {
        name: 'COMMAND_ACK',
        sysid,
        compid,
        fields: { target_system: 0, target_component: 0, ...fields },
      };
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
    peerTable: { getComponent: () => undefined },
    vehicle: vehicleOverride !== undefined
      ? vehicleOverride
      : { id: 'vehicleProfile', targetSystem: 1, targetComponent: 1 },
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
  const registry = {
    vehicleProfile: { getDialect: () => COMMON_BUNDLE },
    ...nodesById,
  };
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
        return registry[id];
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
    peerTable: { getComponent: () => undefined },
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
    params: '{}',
    connection: 'conn',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'confirm',
    targetSystem: '1',
    targetComponent: '1',
    timeoutMs: '60000',
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

test('ack settle and close in one synchronous stack cannot spawn a zombie wait (Codex)', async () => {
  // The handoff race: the ACCEPTED ack settles the waiter, and close() runs in
  // the SAME synchronous stack — before the async continuation can record
  // _activeCompletion. The sweep then has nothing to cancel, and the
  // continuation would create a live 60 s wait on a torn-down node. The
  // generation guard cancels it at creation instead.
  const conn = connStubWithInject();
  conn.peerTable = new StubPeerTable();
  conn.peerTable.setComponent(1, 1, { armed: false }); // ARM never satisfies
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    connection: 'conn',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'complete',
    targetSystem: '1',
    targetComponent: '1',
    timeoutMs: '60000',
    maxRetries: '0',
  });

  let emitted = false;
  let doneErr = 'not-called';
  node.emit('input', { payload: {} }, () => { emitted = true; }, (err) => { doneErr = err; });
  await tick();

  // Same stack: settle ACCEPTED, then close, with no tick between — the
  // continuation has not run yet when the close sweep fires.
  let closed = false;
  conn.injectAck({ command: 400, result: 0 }, 1, 1);
  node.emit('close', () => { closed = true; });

  await tick();
  await tick();

  assert.equal(closed, true, 'close completed');
  assert.equal(doneErr, undefined, 'the stale run finishes quietly');
  assert.equal(emitted, false, 'nothing is emitted onto the closed node');

  // The wait must be dead: checkCompletion reads peerTable.getComponent, so
  // count calls through a wrapper and confirm no zombie keeps polling after
  // close. The window must exceed DEFAULT_POLL_MS (500 ms): the node does not
  // pass pollMs, so a leaked interval first fires at 500 ms (CodeRabbit, #236).
  let reads = 0;
  const realGetComponent = conn.peerTable.getComponent.bind(conn.peerTable);
  conn.peerTable.getComponent = (...args) => { reads += 1; return realGetComponent(...args); };
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(reads, 0, 'no completion polling after close');
});

test('a base-mode-only Set Mode completes at the ack — the wire zero-fill is not a request for mode 0', async () => {
  // Completion receives the *requested* params, sparse. The wire array
  // zero-fills a blank custom mode, and custom_mode 0 is a real mode
  // (ArduPilot STABILIZE) — judged from the wire view, a base-only set would
  // wait for flightMode 0 the vehicle was never asked to enter and falsely
  // time out. With param 2 never supplied, the set completes as satisfied.
  const conn = connStubWithInject();
  conn.peerTable = new StubPeerTable();
  conn.peerTable.setComponent(1, 1, { flightMode: 5 }); // any mode but 0
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: JSON.stringify({ 1: 81 }), // base_mode only; no custom mode
    connection: 'conn',
    sendAs: 'long',
    mode: 'preset',
    preset: 'set_mode',
    delivery: 'complete',
    targetSystem: '1',
    targetComponent: '1',
    timeoutMs: '60000',
    maxRetries: '0',
  });

  let output;
  node.emit('input', { payload: {} }, (messages) => { output = messages; }, () => {});
  await tick();
  conn.injectAck({ command: 176, result: 0 }, 1, 1); // MAV_CMD_DO_SET_MODE
  await tick();
  await tick();

  assert.ok(output, 'the run settled at the ack instead of polling for a mode change');
  assert.equal(output[1].result, 'accepted');
  assert.match(output[1].detail, /mode set/);
  assert.equal(output[1].confirmedBy, 'ack',
    'state never spoke — the accepted ack is the whole confirmation, attributed honestly');
  node.emit('close', () => {});
});

test('a base-mode-only Set Mode whose ack is lost stays unconfirmed — no success from a merely-existing peer (Codex)', async (t) => {
  // The other half of the sparse-params contract: on the ACK-TIMEOUT path the
  // peer-table check exists to prove a lost return leg ("ack timeout but
  // armed"). A base-only set has nothing state can prove, so an existing peer
  // is zero evidence the command ever arrived — reporting accepted there is
  // the §0 rule 3 false success. It must fall through to unconfirmed.
  installAckTimerHarness(t);
  const conn = connStubWithInject();
  conn.peerTable = new StubPeerTable();
  conn.peerTable.setComponent(1, 1, { flightMode: 5 });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: JSON.stringify({ 1: 81 }), // base_mode only; no custom mode
    connection: 'conn',
    sendAs: 'long',
    mode: 'preset',
    preset: 'set_mode',
    delivery: 'complete',
    targetSystem: '1',
    targetComponent: '1',
    timeoutMs: '1000',
    maxRetries: '0',
  });

  let output;
  node.emit('input', { payload: {} }, (messages) => { output = messages; }, () => {});
  // No ack ever arrives; the harness fires the ack window immediately. The
  // harness also swallows zero-delay timers, so waits go through setImmediate.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(output, 'the timeout settled');
  assert.equal(output[1].result, 'unconfirmed');
  assert.equal(output[1].confirmedBy, undefined);
  node.emit('close', () => {});
});

test('a completion already satisfied at the ack cannot emit through a same-stack close (Codex)', async () => {
  // The settle-before-cancel variant: the peer state already satisfies the
  // completion when the ACCEPTED ack arrives, so waitForCompletion() resolves
  // success from its immediate poll at creation. The settle-once cancel() is
  // then a no-op — only the post-await generation check keeps the stale run
  // from emitting that success onto the torn-down node.
  const conn = connStubWithInject();
  conn.peerTable = new StubPeerTable();
  conn.peerTable.setComponent(1, 1, { armed: true }); // ARM already satisfied
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    connection: 'conn',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'complete',
    targetSystem: '1',
    targetComponent: '1',
    timeoutMs: '60000',
    maxRetries: '0',
  });

  let emitted = false;
  let doneErr = 'not-called';
  node.emit('input', { payload: {} }, () => { emitted = true; }, (err) => { doneErr = err; });
  await tick();

  // Same stack: settle ACCEPTED, then close, with no tick between.
  let closed = false;
  conn.injectAck({ command: 400, result: 0 }, 1, 1);
  node.emit('close', () => { closed = true; });

  await tick();
  await tick();

  assert.equal(closed, true, 'close completed');
  assert.equal(doneErr, undefined, 'the stale run finishes quietly');
  assert.equal(emitted, false, 'a pre-settled success is not emitted onto the closed node');
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
    params: '{}',
    connection: 'conn',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'complete',
    targetSystem: '1',
    targetComponent: '1',
    timeoutMs: '60000',
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

test('IN_PROGRESS moves the badge and the terminal record carries result_param2 (§9)', async () => {
  const conn = connStubWithInject();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'confirm',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
    timeoutMs: '10000',
    maxRetries: '0',
  });
  const statuses = [];
  node.status = (s) => statuses.push(s.text);
  let output;

  node.emit('input', { payload: {} }, (messages) => { output = messages; }, () => {});
  await tick();

  // A takeoff-style command answers IN_PROGRESS for seconds before its
  // terminal ack: the badge tracks the vehicle's own percentage, and 255
  // (unknown) reports the plain wait rather than "255%".
  conn.injectAck({ command: 400, result: 5, progress: 45 }, 1, 1);
  conn.injectAck({ command: 400, result: 5, progress: 255 }, 1, 1);
  await tick();
  assert.ok(statuses.some((text) => text.includes('in progress 45%')), 'badge reports the percentage');
  assert.ok(
    statuses.some((text) => text.startsWith('in progress ') && !/\d/.test(text)),
    'unknown progress drops the percentage instead of showing 255%'
  );

  conn.injectAck({ command: 400, result: 0, result_param2: 12 }, 1, 1);
  await tick();

  assert.equal(output[1].result, 'accepted');
  assert.equal(output[1].resultParam2, 12, 'the ack detail reaches the status record');
  node.emit('close', () => {});
});

test('a denial reports its result_param2 rather than a bare name (§9)', async () => {
  const conn = connStubWithInject();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'confirm',
    connection: 'conn',
    targetSystem: '1',
    targetComponent: '1',
    timeoutMs: '10000',
    maxRetries: '0',
  });
  node.status = () => {};
  let output;

  node.emit('input', { payload: {} }, (messages) => { output = messages; }, () => {});
  await tick();
  conn.injectAck({ command: 400, result: 2, result_param2: -5 }, 1, 1);
  await tick();

  assert.equal(output[1].result, 'denied');
  assert.equal(output[1].resultParam2, -5);
  node.emit('close', () => {});
});

test('a completion timeout keeps the accepted ack\'s result_param2 (CodeRabbit)', async () => {
  // Complete tier reaches the completion wait only through an ACCEPTED ack, so
  // this settle had an ack — it was the vehicle *state* that never arrived.
  // `null` is the contract's "no ack at all", which would misreport this path.
  const conn = connStubWithInject();
  conn.peerTable = new StubPeerTable();
  conn.peerTable.setComponent(1, 1, { armed: false }); // ARM never satisfies
  const RED = redStub({ conn });
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    params: '{}',
    connection: 'conn',
    sendAs: 'long',
    mode: 'preset',
    preset: 'arm',
    delivery: 'complete',
    targetSystem: '1',
    targetComponent: '1',
    timeoutMs: '60000',
    maxRetries: '0',
    completionTimeout: '60',
  });
  node.status = () => {};
  let output;

  node.emit('input', { payload: {} }, (messages) => { output = messages; }, () => {});
  await tick();

  conn.injectAck({ command: 400, result: 0, result_param2: 7 }, 1, 1);
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(output[1].result, 'timeout');
  assert.equal(output[1].confirmedBy, undefined, 'nothing confirmed the completion');
  assert.equal(output[1].resultParam2, 7, 'the ack that did arrive is not erased by the state timeout');
  node.emit('close', () => {});
});
