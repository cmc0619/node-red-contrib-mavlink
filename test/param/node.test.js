'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

/** One macrotask: a settled machine's outcome reaches the node's outputs. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('mavlink-param node builds PARAM_SET from msg payload values', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    action: 'set',
    targetSystem: 6,
    targetComponent: 1,
  });
  let sent;

  node.emit(
    'input',
    {
      payload: {
        paramId: 'FOO',
        value: 12,
        paramType: 'MAV_PARAM_TYPE_REAL32',
        firmware: 'ardupilot',
      },
    },
    (messages) => {
      sent = messages;
    },
    () => {}
  );

  assert.equal(sent[0].payload.name, 'PARAM_SET');
  assert.equal(sent[0].payload.fields.param_id, 'FOO');
  assert.equal(sent[0].payload.fields.param_value, 12);
  // The status record leaves output 1 as the top-level message, not msg.payload.
  assert.equal(sent[1].result, 'succeeded');
});

test('mavlink-param reuses its deploy-resolved Connection during input delivery', () => {
  const conn = connStubFull();
  const RED = redStub({ conn });
  const getNode = RED.nodes.getNode.bind(RED.nodes);
  let connectionLookups = 0;
  RED.nodes.getNode = (id) => {
    if (id === 'conn') connectionLookups++;
    return getNode(id);
  };
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'send',
    action: 'read',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
  });

  node.emit('input', { payload: { paramId: 'ARMING_CHECK' } }, () => {}, () => {});

  assert.equal(connectionLookups, 1, 'Connection is resolved once at deploy');
  assert.equal(conn.sent.length, 1);
});

test('a set with no paramType resolves no MAV_PARAM_TYPE rather than guessing REAL32', () => {
  // Guessing REAL32 silently mis-encodes an INT32 parameter. The editor always
  // saves a type (`paramType`, default MAV_PARAM_TYPE_REAL32), so an absent
  // one is drift — and drift resolves to nothing, never to a guess.
  const { buildParamMessage } = require('../../lib/param');
  assert.equal(
    buildParamMessage({
      action: 'set',
      paramId: 'BAT_N_CELLS',
      value: 3,
      target: { sysid: 1, compid: 1 },
      firmware: 'ardupilot',
    }).fields.param_type,
    undefined
  );
});

test('a set with a blank value sends the coercion, not a refusal — the editor owns the box', () => {
  // The driver encodes and sends (§0): a blank value is `Number('')`. The
  // editor's `value` field is deliberately blank-legal because a blank defers
  // to `msg.payload`, and its own validator bounds anything typed there.
  const conn = connStubFull();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    paramType: 'MAV_PARAM_TYPE_REAL32',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
    value: '',
  });

  let err;
  node.emit('input', { payload: { paramId: 'FOO' } }, () => {}, (e) => { err = e; });
  node.emit('close', () => {});

  assert.equal(err, undefined);
  assert.equal(conn.sent.length, 1, 'the set reached the wire');
  assert.equal(conn.sent[0].message.fields.param_value, 0);
});

test('a broadcast target still sends — the editor is what reds it', () => {
  // No vehicle answers as sysid 0, so every Param action would wait forever
  // for a reply. That pair is a *configured* one the editor reds at deploy
  // (mavlink-param.html targetSystem, RED.mavlink.validateTargetSystem, which
  // gates every tier including Build). A payload override is trusted input
  // and rides (§0).
  const conn = connStubFull();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'read',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
  });

  node.emit('input', { payload: { paramId: 'FOO', target: { sysid: 0 } } }, () => {}, () => {});
  node.emit('close', () => {});

  assert.equal(conn.sent.length, 1, 'the read reached the wire');
  assert.equal(conn.sent[0].message.fields.target_system, 0);
});

test('mavlink-param confirm set with compid 0 (editor-refused, §14.149) rides its natural reading: an unscoped echo wait', async () => {
  const conn = connStubFull();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    paramType: 'MAV_PARAM_TYPE_REAL32',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 0,
    timeoutMs: 1000,
    maxRetries: 0,
  });

  let out;
  node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, (m) => { out = m; }, () => {});

  assert.equal(conn.sent.length, 1, 'PARAM_SET was sent');
  assert.equal(conn.subs.length, 1, 'subscription opened');
  assert.equal(conn.subs[0].filter.compid, undefined, 'compid 0 leaves the subscription unscoped by component');

  conn.inject({ name: 'PARAM_VALUE', sysid: 6, compid: 3, fields: { param_id: 'FOO', param_value: 1, param_count: 1, param_index: 0, param_type: 9 } });
  await tick();

  assert.equal(out[1].result, 'succeeded', 'the echo from any component at sysid 6 confirmed the set');
});

test('mavlink-param confirm set fails loud when its echo never comes, and releases the subscription', () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    paramType: 'MAV_PARAM_TYPE_REAL32',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
    timeoutMs: 5, // ms — fire quickly for the test
    maxRetries: 0,
  });

  return new Promise((resolve) => {
    let out;
    node.emit(
      'input',
      { payload: { paramId: 'FOO', value: 1 } },
      (m) => { out = m; },
      () => {
        assert.equal(out[0], null, 'output 0 must not fire on a failure');
        assert.equal(out[1].result, 'failed');
        assert.match(out[1].reason, /stalled at param FOO/);
        assert.equal(conn.activeCount(), 0, 'the subscription is torn down');
        resolve();
      }
    );
  });
});

test('mavlink-param confirm set scopes its PARAM_VALUE subscription to the target vehicle', () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    paramType: 'MAV_PARAM_TYPE_REAL32',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
  });

  node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, () => {}, () => {});

  assert.equal(conn.subs.length, 1, 'one PARAM_VALUE subscription installed');
  assert.equal(conn.subs[0].filter.message, 'PARAM_VALUE');
  assert.equal(conn.subs[0].filter.sysid, 6, 'subscription scoped to target sysid');
  assert.equal(conn.subs[0].filter.compid, 1, 'subscription scoped to target compid');
});

test('mavlink-param inherits Vehicle Profile target when config is empty (build tier via vehicle field)', () => {
  // Build tier reads the profile from config.vehicle (not config.connection).
  const vehicleNode = { defaultTargetSystem: 42, defaultTargetComponent: 191, firmware: 'ardupilot' };
  const RED = redStub({ veh: vehicleNode });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    dialect: '__vehicle',
    action: 'read',
    targetSystem: '',
    targetComponent: '',
    vehicle: 'veh',
  });
  let sent;

  node.emit(
    'input',
    { payload: { paramId: 'ARMING_CHECK' } },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 42);
  assert.equal(sent[0].payload.fields.target_component, 191);
});

test('mavlink-param explicit config value wins over Vehicle Profile', () => {
  const conn = { vehicle: { targetSystem: 42, targetComponent: 191 }, send() {}, subscribe() { return () => {}; } };
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    action: 'read',
    targetSystem: 7,
    targetComponent: 100,
    connection: 'conn',
  });
  let sent;

  node.emit(
    'input',
    { payload: { paramId: 'ARMING_CHECK' } },
    (messages) => { sent = messages; },
    () => {}
  );

  assert.equal(sent[0].payload.fields.target_system, 7);
  assert.equal(sent[0].payload.fields.target_component, 100);
});

test('a second input supersedes the wait in flight and says so on output 1 (Q2)', async () => {
  const conn = connStub();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    paramType: 'MAV_PARAM_TYPE_REAL32',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
    timeoutMs: 1000,
    maxRetries: 0,
  });

  const first = [];
  let firstDone = 0;
  node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, (m) => first.push(m), () => { firstDone += 1; });
  node.emit('input', { payload: { paramId: 'BAR', value: 2 } }, () => {}, () => {});
  await tick();

  assert.equal(conn.subs.length, 2);
  assert.equal(conn.activeCount(), 1, 'only the latest subscription remains active');
  // FOO's PARAM_SET is already on the wire, so its input does not finish
  // without a word: the record says a later input took over.
  const terminal = first.at(-1)[1];
  assert.equal(terminal.result, 'cancelled');
  assert.equal(terminal.detail, 'superseded');
  assert.equal(firstDone, 1);
  node.emit('close', () => {});
});

test('mavlink-param companion identity derives sysid; echo from sysid 42 confirms, sysid 1 ignored', async () => {
  // Companion identity: sysid derived from airframe (42), compid pinned to 1.
  const conn = connStubFull({
    vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' },
  });
  const identityNode = { derivesSysidFromVehicle: true, getIdentity: () => ({ sysid: 42, compid: 191 }) };
  const RED = redStub({ conn, identity: identityNode });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    paramType: 'MAV_PARAM_TYPE_REAL32',
    connection: 'conn',
    identity: 'identity',
    targetSystem: '',
    targetComponent: '',
    timeoutMs: 1000,
    maxRetries: 0,
  });

  const outs = [];
  node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, (m) => { outs.push(m); }, () => {});

  // Subscription must be scoped to the companion-derived sysid (42) and compid 1 (autopilot).
  assert.equal(conn.subs.length, 1);
  assert.equal(conn.subs[0].filter.sysid, 42, 'subscription scoped to companion derived sysid');
  assert.equal(conn.subs[0].filter.compid, 1, 'subscription scoped to autopilot compid 1');

  // Echo from sysid 1 — filter blocks it, transaction stays open.
  conn.inject({ name: 'PARAM_VALUE', sysid: 1, compid: 1, fields: { param_id: 'FOO', param_value: 1, param_count: 1, param_index: 0, param_type: 9 } });
  await tick();
  assert.equal(outs.some((m) => m[1].result === 'succeeded'), false, 'echo from sysid 1 does not confirm');

  // Echo from sysid 42 — passes filter and matchesParamEcho, confirms the set.
  conn.inject({ name: 'PARAM_VALUE', sysid: 42, compid: 1, fields: { param_id: 'FOO', param_value: 1, param_count: 1, param_index: 0, param_type: 9 } });
  await tick();
  assert.equal(outs.at(-1)[1].result, 'succeeded', 'echo from derived sysid 42 confirms the set');
});

test('mavlink-param payload.target overrides companion derivation', () => {
  const conn = connStubFull({
    vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' },
  });
  const identityNode = { derivesSysidFromVehicle: true, getIdentity: () => ({ sysid: 42, compid: 191 }) };
  const RED = redStub({ conn, identity: identityNode });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    paramType: 'MAV_PARAM_TYPE_REAL32',
    connection: 'conn',
    identity: 'identity',
    targetSystem: '',
    targetComponent: '',
  });

  // payload.target.sysid = 50 overrides companion derivation (step 1 wins over step 2).
  node.emit('input', { payload: { paramId: 'FOO', value: 1, target: { sysid: 50 } } }, () => {}, () => {});
  assert.equal(conn.subs[0].filter.sysid, 50, 'payload.target.sysid overrides companion derivation');
});

test('mavlink-param build tier inherits from config.vehicle (sysid 77, compid 78, firmware px4)', () => {
  const vehicleNode = { defaultTargetSystem: 77, defaultTargetComponent: 78, firmware: 'px4' };
  const RED = redStub({ veh: vehicleNode });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    dialect: '__vehicle',
    action: 'read',
    vehicle: 'veh',
    targetSystem: '',
    targetComponent: '',
  });
  let sent;
  node.emit('input', { payload: { paramId: 'ARMING_CHECK' } }, (m) => { sent = m; }, () => {});

  assert.equal(sent[0].payload.fields.target_system, 77, 'sysid from vehicle node');
  assert.equal(sent[0].payload.fields.target_component, 78, 'compid from vehicle node');
});

test('mavlink-param Build concrete dialect uses config firmware', () => {
  const { paramValueToWire } = require('../../lib/codec/param-union');
  const RED = redStub({});
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    dialect: 'common',
    firmware: 'px4',
    action: 'set',
    targetSystem: 1,
    targetComponent: 1,
  });
  let sent;

  node.emit(
    'input',
    { payload: { paramId: 'BAT_N_CELLS', value: 3, paramType: 'MAV_PARAM_TYPE_INT32' } },
    (m) => { sent = m; },
    () => {}
  );

  assert.equal(sent[0].payload.name, 'PARAM_SET');
  assert.equal(sent[0].payload.fields.param_value, paramValueToWire(3, 6));
});

test('mavlink-param payload firmware overrides Build concrete dialect firmware', () => {
  const RED = redStub({});
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'build',
    dialect: 'common',
    firmware: 'ardupilot',
    action: 'set',
    targetSystem: 1,
    targetComponent: 1,
  });
  let sent;

  node.emit(
    'input',
    {
      payload: {
        paramId: 'BAT_N_CELLS',
        value: 3,
        paramType: 'MAV_PARAM_TYPE_INT32',
        firmware: 'px4',
      },
    },
    (m) => { sent = m; },
    () => {}
  );

  assert.notEqual(sent[0].payload.fields.param_value, 3, 'payload firmware wins over config firmware');
});

test('mavlink-param capabilities beat ardupilot firmware for bytewise encoding', () => {
  const { paramValueToWire } = require('../../lib/codec/param-union');
  const CAP_PARAM_ENCODE_BYTEWISE = 16; // MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE
  const peerTable = {
    getComponent(sysid, compid) {
      if (Number(sysid) === 1 && Number(compid) === 1) {
        return { capabilities: CAP_PARAM_ENCODE_BYTEWISE };
      }
      return undefined;
    },
  };
  const conn = connStubFull({
    vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' },
    peerTable,
  });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'send',
    action: 'set',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
  });

  node.emit(
    'input',
    { payload: { paramId: 'BAT_N_CELLS', value: 3, paramType: 'MAV_PARAM_TYPE_INT32' } },
    () => {},
    () => {}
  );

  assert.equal(
    conn.sent[0].message.fields.param_value,
    paramValueToWire(3, 6),
    'BYTEWISE capability encodes via float bit-cast despite ardupilot firmware'
  );
});

test('mavlink-param msg.payload.paramEncoding overrides peer capabilities', () => {
  const CAP_PARAM_ENCODE_BYTEWISE = 16; // MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE
  const peerTable = {
    getComponent() {
      return { capabilities: CAP_PARAM_ENCODE_BYTEWISE };
    },
  };
  const conn = connStubFull({
    vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'px4' },
    peerTable,
  });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'send',
    action: 'set',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
  });

  node.emit(
    'input',
    {
      payload: {
        paramId: 'BAT_N_CELLS',
        value: 3,
        paramType: 'MAV_PARAM_TYPE_INT32',
        paramEncoding: 'c-cast',
      },
    },
    () => {},
    () => {}
  );

  assert.equal(conn.sent[0].message.fields.param_value, 3, 'explicit c-cast wins');
});

test('mavlink-param firmware follows profile not stale config (profile px4 → firmware px4)', async () => {
  // PX4 uses a float-reinterpret encoding for integer params. This test
  // verifies that the request firmware comes from the profile, not config.firmware.
  const conn = connStubFull({ vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'px4' } });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    timeoutMs: 1000,
    maxRetries: 0,
    // no firmware in config — it is gone from the UI
  });

  let result;
  node.emit(
    'input',
    { payload: { paramId: 'BAT_N_CELLS', value: 3, paramType: 'MAV_PARAM_TYPE_INT32' } },
    (m) => { result = m; },
    () => {}
  );

  // paramValueToWire(3, INT32) reinterprets int32(3) as float32 → 4.2e-45,
  // so the firmware affected the encoded value (not raw Number(3)).
  const sentFields = conn.sent[0].message.fields;
  assert.ok(sentFields.param_value !== 3, 'PX4 firmware encodes integer params via float reinterpret');

  // Confirm with the same encoded value coming back from sysid 1.
  conn.inject({
    name: 'PARAM_VALUE',
    sysid: 1,
    compid: 1,
    fields: {
      param_id: 'BAT_N_CELLS',
      param_value: sentFields.param_value,
      param_type: 6,
      param_count: 1,
      param_index: 0,
    },
  });
  await tick();
  assert.equal(result[1].result, 'succeeded', 'echo with PX4 encoded value confirms');
  assert.deepEqual(result[0].payload, { paramId: 'BAT_N_CELLS', paramType: 'MAV_PARAM_TYPE_INT32', value: 3 });
});

test('mavlink-param wire tier inherits from connection vehicle profile', () => {
  const conn = connStubFull({
    vehicle: { targetSystem: 55, targetComponent: 200, firmware: 'ardupilot' },
  });
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'send',
    action: 'read',
    connection: 'conn',
    targetSystem: '',
    targetComponent: '',
  });

  node.emit('input', { payload: { paramId: 'ARMING_CHECK' } }, () => {}, () => {});
  const msg = conn.sent[0].message;
  assert.equal(msg.fields.target_system, 55);
  assert.equal(msg.fields.target_component, 200);
});

test('a Delivery token the editor cannot save performs no tier at all (§5)', () => {
  // The dispatch used to test only 'build' and then send unconditionally, so a
  // typo of 'send' reached the wire and reported 'succeeded'. Each tier is its
  // own switch arm now, and a token the delivery ring cannot save
  // (RED.mavlink.oneOf, mavlink-param.html) matches none of them.
  for (const delivery of ['snd', '']) {
    const conn = connStubFull();
    const RED = redStub({ conn });
    require('../../nodes/mavlink-param')(RED);
    const Node = RED.nodes.types['mavlink-param'];
    const node = new Node({
      delivery,
      action: 'set',
      paramType: 'MAV_PARAM_TYPE_REAL32',
      connection: 'conn',
      targetSystem: 6,
      targetComponent: 1,
      value: 1,
    });

    const outputs = [];
    let err;
    let doneCalls = 0;
    node.emit(
      'input',
      { payload: { paramId: 'FOO' } },
      (m) => { outputs.push(m); },
      (e) => { doneCalls += 1; err = e; }
    );
    node.emit('close', () => {});

    assert.equal(conn.sent.length, 0, `delivery "${delivery}" must not reach the wire`);
    assert.equal(conn.activeCount(), 0, 'no transaction was armed');
    assert.equal(outputs.length, 0, 'no tier ran, so no outcome was reported');
    assert.equal(doneCalls, 1, 'the input is still completed');
    assert.equal(err, undefined, 'a no-op is not a failure');
  }
});

/* ---------- the waits run on lib/param's transfer machines ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function confirmSetNode(RED, conn, timeout) {
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  return new Node({
    delivery: 'confirm',
    action: 'set',
    paramType: 'MAV_PARAM_TYPE_REAL32',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    timeoutMs: timeout,
    // The editor's default budget: three re-sends on silence.
    maxRetries: 3,
  });
}

test('confirm set re-sends PARAM_SET when its echo times out', { timeout: 1000 }, async () => {
  const conn = connStubFull();
  const node = confirmSetNode(redStub({ conn }), conn, 15);

  const outs = [];
  let doneErr;
  const finished = new Promise((resolve) => {
    node.emit('input', { payload: { paramId: 'FOO', value: 1 } },
      (m) => outs.push(m), (err) => { doneErr = err; resolve(); });
  });
  await finished;

  assert.equal(conn.sent.length, 4, 'the initial send is followed by the editor\'s three re-sends');
  assert.ok(conn.sent.every((s) => s.message.name === 'PARAM_SET'));
  const retries = outs.filter((m) => m[1].result === 'progress' && m[1].phase === 'retry');
  assert.deepEqual(retries.map((m) => m[1].retry), [1, 2, 3]);
  const terminal = outs.at(-1);
  assert.equal(terminal[0], null);
  assert.equal(terminal[1].result, 'failed');
  assert.match(terminal[1].reason, /stalled at param FOO after 3 retries/);
  assert.equal(doneErr, undefined, 'action failure halts via badge + output 1, not done(err)');
  assert.equal(conn.activeCount(), 0, 'subscription torn down');
});

test('a PARAM_VALUE echo typed 64-bit settles the set as failed, not as an echo timeout (470#34)', { timeout: 1000 }, async () => {
  // PX4: the echo decodes bytewise through the union, which is where a 64-bit
  // type has no slot. (ArduPilot decodes c-cast and never asks the union.)
  const conn = connStubFull({ vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'px4' } });
  const node = confirmSetNode(redStub({ conn }), conn, 200);

  const outs = [];
  const finished = new Promise((resolve) => {
    node.emit('input', { payload: { paramId: 'FOO', value: 1 } },
      (m) => outs.push(m), () => resolve());
  });
  // The vehicle answers with its own type — REAL64 (10) does not fit the float
  // slot. That is its answer, and the set ends on it rather than waiting out
  // the deadline and re-sending into a parameter it can never confirm.
  conn.inject({ name: 'PARAM_VALUE', sysid: 1, compid: 1, fields: { param_id: 'FOO', param_value: 1, param_count: 1, param_index: 0, param_type: 10 } });
  await finished;

  const records = outs.map((m) => m[1]);
  const failed = records.find((r) => r.result === 'failed');
  assert.ok(failed, 'the set settles as failed');
  assert.match(failed.reason, /kind/, 'the union\'s own missing-row failure, not an echo timeout');
  assert.equal(records.some((r) => r.result === 'succeeded'), false, 'no confirmation follows');
  assert.equal(conn.sent.length, 1, 'no re-send: the vehicle answered, it just cannot be decoded');
});

test('closing the node mid-set stops the re-send timer and releases done quietly', async () => {
  const conn = connStubFull();
  const node = confirmSetNode(redStub({ conn }), conn, 15);

  const outs = [];
  let doneCalls = 0;
  node.emit('input', { payload: { paramId: 'FOO', value: 1 } },
    (m) => outs.push(m), () => { doneCalls += 1; });
  node.emit('close', () => {});
  await sleep(60);

  assert.equal(conn.sent.length, 1, 'the initial send stays on the wire');
  assert.equal(outs.filter((m) => m[1].result !== 'progress').length, 0,
    'no terminal record from a torn-down node (§14.47)');
  assert.equal(doneCalls, 1, 'the in-flight done was released');
  assert.equal(conn.activeCount(), 0);
});

function confirmReadNode(RED, config) {
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  return new Node({
    delivery: 'confirm',
    action: 'read',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    timeoutMs: 1000,
    maxRetries: 0,
    ...config,
  });
}

test('read+confirm awaits the PARAM_VALUE reply and reports the parameter', async () => {
  const conn = connStubFull();
  const node = confirmReadNode(redStub({ conn }), { paramId: 'RC1_MIN' });

  let result;
  node.emit('input', { payload: {} }, (m) => { result = m; }, () => {});

  assert.equal(conn.sent[0].message.name, 'PARAM_REQUEST_READ');
  assert.equal(result, undefined, 'no premature succeeded/sent — the read waits');

  // A different parameter's PARAM_VALUE does not answer this read.
  conn.inject({
    name: 'PARAM_VALUE',
    fields: { param_id: 'RC2_MIN', param_value: 1200, param_type: 9, param_count: 100, param_index: 8 },
  });
  await tick();
  assert.equal(result, undefined);

  conn.inject({
    name: 'PARAM_VALUE',
    fields: { param_id: 'RC1_MIN', param_value: 1100, param_type: 9, param_count: 100, param_index: 7 },
  });
  await tick();
  assert.equal(result[1].result, 'succeeded');
  assert.equal(result[1].detail, 'value-received');
  assert.deepEqual(result[0].payload, { paramId: 'RC1_MIN', paramType: 9, value: 1100, index: 7 });
  assert.equal(conn.activeCount(), 0, 'subscription torn down on settle');
});

test('read+confirm by index matches the reply on param_index', async () => {
  const conn = connStubFull();
  const node = confirmReadNode(redStub({ conn }), { lookup: 'index', paramIndex: 7 });

  let result;
  node.emit('input', { payload: {} }, (m) => { result = m; }, () => {});
  assert.equal(conn.sent[0].message.fields.param_index, 7);

  conn.inject({
    name: 'PARAM_VALUE',
    fields: { param_id: 'RC1_MIN', param_value: 1100, param_type: 9, param_count: 100, param_index: 6 },
  });
  await tick();
  assert.equal(result, undefined, 'a neighbouring index does not answer');
  conn.inject({
    name: 'PARAM_VALUE',
    fields: { param_id: 'RC1_MIN', param_value: 1100, param_type: 9, param_count: 100, param_index: 7 },
  });
  await tick();
  assert.equal(result[1].result, 'succeeded');
});

test('read+confirm re-sends on silence, then fails loud', async () => {
  const conn = connStubFull();
  const node = confirmReadNode(redStub({ conn }), { paramId: 'RC1_MIN', timeoutMs: 5, maxRetries: 2 });

  let result;
  let doneErr;
  await new Promise((resolve) => {
    node.emit('input', { payload: {} }, (m) => { result = m; }, (err) => { doneErr = err; resolve(); });
  });

  assert.equal(conn.sent.filter((s) => s.message.name === 'PARAM_REQUEST_READ').length, 3);
  assert.equal(result[0], null);
  assert.equal(result[1].result, 'failed');
  assert.match(result[1].reason, /stalled at read after 2 retries/);
  assert.equal(doneErr, undefined, 'action failure halts via badge + output 1, not done(err)');
});

test('read and collect decode a PX4 integer through the union, not as its raw float bits (R28)', async () => {
  const { paramValueToWire } = require('../../lib/codec/param-union');
  const px4 = { vehicle: { targetSystem: 1, targetComponent: 1, firmware: 'px4' } };

  const readConn = connStubFull(px4);
  const reader = confirmReadNode(redStub({ conn: readConn }), { paramId: 'BAT_N_CELLS' });
  let read;
  reader.emit('input', { payload: {} }, (m) => { read = m; }, () => {});
  readConn.inject({
    name: 'PARAM_VALUE',
    fields: { param_id: 'BAT_N_CELLS', param_value: paramValueToWire(4, 6), param_type: 6, param_count: 1, param_index: 0 },
  });
  await tick();
  assert.equal(read[0].payload.value, 4, 'not 5.6e-45: a read-then-set round trip writes 4 back');

  const listConn = connStubFull(px4);
  const collector = collectNode(redStub({ conn: listConn }), 1000);
  let list;
  collector.emit('input', { payload: {} }, (m) => { list = m; }, () => {});
  listConn.inject({
    name: 'PARAM_VALUE',
    fields: { param_id: 'BAT_N_CELLS', param_value: paramValueToWire(4, 6), param_type: 6, param_count: 1, param_index: 0 },
  });
  await tick();
  assert.deepEqual(list[0].payload, [{ paramId: 'BAT_N_CELLS', paramType: 6, value: 4, index: 0 }]);
});

/* ---------- collect-tier loss recovery (#242) ---------- */

function collectNode(RED, timeout) {
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  return new Node({
    delivery: 'collect',
    action: 'request-list',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    timeoutMs: timeout,
    maxRetries: 0,
  });
}

/** A list-member PARAM_VALUE from sysid/compid 1. */
function listValue(index, count) {
  return {
    name: 'PARAM_VALUE',
    fields: { param_id: `P${index}`, param_index: index, param_count: count, param_value: index, param_type: 9 },
  };
}

test('collect completes count 0 as an empty list', async () => {
  const conn = connStubFull();
  const node = collectNode(redStub({ conn }), 100);

  let result;
  node.emit('input', { payload: {} }, (m) => { result = m; }, () => {});
  conn.inject({
    name: 'PARAM_VALUE',
    fields: { param_id: '', param_index: 65535, param_count: 0, param_value: 0, param_type: 9 },
  });
  await tick();

  assert.equal(result[1].result, 'succeeded');
  assert.equal(result[1].detail, 'list-complete');
  assert.deepEqual(result[0].payload, []);
});

test('collect waits for a dropped index without re-requesting it by index', async () => {
  const conn = connStubFull();
  const node = collectNode(redStub({ conn }), 200);

  const outs = [];
  node.emit('input', { payload: {} }, (m) => outs.push(m), () => {});
  conn.inject(listValue(0, 3));
  conn.inject(listValue(2, 3)); // index 1 dropped
  await sleep(90);

  const reads = conn.sent.filter((s) => s.message.name === 'PARAM_REQUEST_READ');
  assert.equal(reads.length, 0, 'a missing list member does not cause a by-index request');

  conn.inject(listValue(1, 3));
  await tick();
  const terminal = outs.at(-1);
  assert.equal(terminal[1].detail, 'list-complete');
  assert.deepEqual(terminal[0].payload.map((p) => p.paramId), ['P0', 'P1', 'P2']);
});

test('collect re-arms its window on every frame, and a failure reports what arrived (R32)', async () => {
  // One un-rearmed 100 ms deadline ended this steadily progressing stream at
  // 101 ms as a "list timeout" that dropped every frame received.
  const conn = connStubFull();
  const node = collectNode(redStub({ conn }), 100);

  const outs = [];
  node.emit('input', { payload: {} }, (m) => outs.push(m), () => {});
  for (let index = 0; index < 20; index += 1) {
    conn.inject(listValue(index, 21));
    await sleep(10);
  }
  await sleep(150);

  const terminal = outs.at(-1)[1];
  assert.equal(terminal.result, 'failed', 'index 20 never came');
  assert.equal(terminal.received, 20, 'the record says how much of the table arrived');
});

test('an out-of-range PARAM_VALUE warns once and cannot complete the collect', async () => {
  const conn = connStubFull();
  const RED = redStub({ conn });
  const node = collectNode(RED, 100);
  const warns = [];
  node.warn = (text) => warns.push(text);

  let result;
  node.emit('input', { payload: {} }, (m) => { result = m; }, () => {});
  conn.inject(listValue(0, 2));
  conn.inject(listValue(9, 2));
  conn.inject(listValue(9, 2));
  await tick();

  assert.equal(result[1].result, 'progress', 'a bogus index must not satisfy the completion check');
  assert.equal(warns.length, 1, 'warned once, deduped');
  assert.match(warns[0], /index 9/);

  conn.inject(listValue(1, 2));
  await tick();
  assert.deepEqual(result[0].payload.map((p) => p.paramId), ['P0', 'P1']);
});

/**
 * Connection stub that records subscription filters and unsubscribe calls.
 */
function connStub(opts) {
  opts = opts || {};
  const subs = [];
  return {
    subs,
    // Wire-tier profile must carry firmware — runtime no longer invents ardupilot.
    vehicle: opts.vehicle || { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' },
    peerTable: { getComponent: () => undefined },
    send() {},
    subscribe(filter, handler) {
      const entry = { filter, handler, active: true };
      subs.push(entry);
      return () => {
        entry.active = false;
      };
    },
    activeCount() {
      return subs.filter((s) => s.active).length;
    },
  };
}

/**
 * Extended connection stub that also records sent messages and supports
 * injecting inbound decoded messages to active subscribers.
 */
function connStubFull(opts) {
  opts = opts || {};
  const subs = [];
  const sent = [];
  const stub = {
    subs,
    sent,
    vehicle: opts.vehicle || { targetSystem: 1, targetComponent: 1, firmware: 'ardupilot' },
    peerTable: opts.peerTable || { getComponent: () => undefined },
    send(message, options) {
      sent.push({ message, options });
    },
    subscribe(filter, handler) {
      const entry = { filter, handler, active: true };
      subs.push(entry);
      return () => { entry.active = false; };
    },
    activeCount() {
      return subs.filter((s) => s.active).length;
    },
    inject(decoded) {
      const d = { sysid: 1, compid: 1, ...decoded };
      for (const entry of subs.slice()) {
        if (!entry.active) continue;
        if (entry.filter.message !== undefined && entry.filter.message !== d.name) continue;
        if (entry.filter.sysid !== undefined && entry.filter.sysid !== d.sysid) continue;
        if (entry.filter.compid !== undefined && entry.filter.compid !== d.compid) continue;
        entry.handler(d);
      }
    },
  };
  return stub;
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
        node.warn = () => {};
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
