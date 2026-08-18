'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

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
  // Guessing REAL32 silently mis-encodes an INT32 parameter (#222). The wire
  // tiers answer an absent/auto type by reading the vehicle (read-before-set);
  // at the build layer an absent type still resolves to nothing, never to a
  // guess.
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

test('mavlink-param confirm set works end to end with a broadcast COMPONENT (compid 0) and a real sysid — deliberate, supported behavior', () => {
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
  });

  let out;
  node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, (m) => { out = m; }, () => {});

  assert.equal(conn.sent.length, 1, 'PARAM_SET was sent');
  assert.equal(conn.subs.length, 1, 'subscription opened');
  assert.equal(conn.subs[0].filter.compid, undefined, 'compid 0 leaves the subscription unscoped by component');

  conn.inject({ name: 'PARAM_VALUE', sysid: 6, compid: 3, fields: { param_id: 'FOO', param_value: 1, param_count: 1, param_index: 0, param_type: 9 } });

  assert.ok(out, 'the echo from any component at sysid 6 confirmed the set');
  assert.equal(out[1].result, 'succeeded');
});

test('mavlink-param confirm set emits a timed-out record and releases the subscription', () => {
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
    timeout: 5, // ms — fire quickly for the test
  });

  return new Promise((resolve) => {
    let out;
    // Wait for the node's own done() rather than a wall clock. The bounded
    // re-send (#249) emits a 'progress' record per attempt before the terminal
    // one, so a fixed delay races the attempts and caught 'progress' on a
    // loaded runner; timeoutResult calls done() immediately after the terminal
    // emit, which is the event this test actually means.
    node.emit(
      'input',
      { payload: { paramId: 'FOO', value: 1 } },
      (m) => { out = m; },
      () => {
        assert.ok(out, 'a terminal record was emitted on timeout');
        assert.equal(out[0], null, 'output 0 must not fire on timeout');
        assert.equal(out[1].result, 'timed-out');
        assert.equal(conn.activeCount(), 0, 'the subscription is torn down on timeout');
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

test('mavlink-param cancels a prior in-flight subscription when a second op starts', () => {
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
  node.emit('input', { payload: { paramId: 'BAR', value: 2 } }, () => {}, () => {});

  // Two subscriptions were created, but the first must have been cancelled so
  // exactly one remains active (no leak).
  assert.equal(conn.subs.length, 2);
  assert.equal(conn.activeCount(), 1, 'only the latest subscription remains active');
});

test('mavlink-param companion identity derives sysid; echo from sysid 42 confirms, sysid 1 ignored', () => {
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
  });

  let result;
  node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, (m) => { result = m; }, () => {});

  // Subscription must be scoped to the companion-derived sysid (42) and compid 1 (autopilot).
  assert.equal(conn.subs.length, 1);
  assert.equal(conn.subs[0].filter.sysid, 42, 'subscription scoped to companion derived sysid');
  assert.equal(conn.subs[0].filter.compid, 1, 'subscription scoped to autopilot compid 1');

  // Echo from sysid 1 — filter blocks it, transaction stays open.
  conn.inject({ name: 'PARAM_VALUE', sysid: 1, compid: 1, fields: { param_id: 'FOO', param_value: 1, param_count: 1, param_index: 0, param_type: 9 } });
  assert.equal(result, undefined, 'echo from sysid 1 does not confirm');

  // Echo from sysid 42 — passes filter and matchesParamEcho, confirms the set.
  conn.inject({ name: 'PARAM_VALUE', sysid: 42, compid: 1, fields: { param_id: 'FOO', param_value: 1, param_count: 1, param_index: 0, param_type: 9 } });
  assert.ok(result, 'echo from derived sysid 42 confirms the set');
  assert.equal(result[1].result, 'succeeded');
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
  const { paramValueToWire } = require('../../lib/codec');
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
  assert.equal(sent[0].payload.fields.param_value, paramValueToWire(3, 'MAV_PARAM_TYPE_INT32'));
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
  const { paramValueToWire } = require('../../lib/codec');
  const { CAP_PARAM_ENCODE_BYTEWISE } = require('../../lib/param');
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
    paramValueToWire(3, 'MAV_PARAM_TYPE_INT32'),
    'BYTEWISE capability encodes via float bit-cast despite ardupilot firmware'
  );
});

test('mavlink-param msg.payload.paramEncoding overrides peer capabilities', () => {
  const { CAP_PARAM_ENCODE_BYTEWISE } = require('../../lib/param');
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

test('mavlink-param firmware follows profile not stale config (profile px4 → firmware px4)', () => {
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
    // no firmware in config — it is gone from the UI
  });

  let result;
  node.emit(
    'input',
    { payload: { paramId: 'BAT_N_CELLS', value: 3, paramType: 'MAV_PARAM_TYPE_INT32' } },
    (m) => { result = m; },
    () => {}
  );

  // PX4 encoding: paramValueToWire(3, INT32) produces a float-bit-reinterpretation.
  // The subscription fires with the same value so confirmation succeeds.
  const sentFields = conn.sent[0].message.fields;
  // For PX4 INT32, the wire value is the IEEE 754 reinterpretation of integer bits.
  // We just verify that the firmware affected the encoded value (not raw Number(3)).
  // paramValueToWire(3, 6) → reinterpret int32(3) as float32 → 4.203895e-45
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
  assert.ok(result, 'echo with PX4 encoded value confirms');
  assert.equal(result[1].result, 'succeeded');
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

/* ---------- confirm-tier PARAM_SET re-send (#242) ---------- */

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
    timeout,
  });
}

test('confirm set re-sends PARAM_SET on echo silence and reports attempts', async () => {
  const conn = connStubFull();
  const node = confirmSetNode(redStub({ conn }), conn, 15);

  const outs = [];
  let doneErr;
  node.emit('input', { payload: { paramId: 'FOO', value: 1 } },
    (m) => outs.push(m), (err) => { doneErr = err; });
  await sleep(100);

  assert.equal(conn.sent.length, 3, '3 attempts total: initial send plus two re-sends');
  assert.ok(conn.sent.every((s) => s.message.name === 'PARAM_SET'));
  const progress = outs.filter((m) => m[1] && m[1].result === 'progress');
  assert.deepEqual(progress.map((m) => m[1].detail), ['resend 2/3', 'resend 3/3']);
  assert.ok(progress.every((m) => m[0] === null), 'progress rides output 1 only');
  const terminal = outs[outs.length - 1];
  assert.equal(terminal[0], null);
  assert.equal(terminal[1].result, 'timed-out');
  assert.equal(terminal[1].detail, 'echo timeout');
  assert.equal(terminal[1].attempts, 3, 'attempts in the terminal record');
  assert.ok(doneErr instanceof Error, 'timeout still fails through done');
  assert.equal(conn.activeCount(), 0, 'subscription torn down');
});

test('an echo arriving after a re-send confirms, with the attempts recorded', async () => {
  const conn = connStubFull();
  const node = confirmSetNode(redStub({ conn }), conn, 50);

  let result;
  node.emit('input', { payload: { paramId: 'FOO', value: 1 } }, (m) => { result = m; }, () => {});
  await sleep(75); // past the first echo wait: one re-send has gone out
  assert.equal(conn.sent.length, 2, 'the second attempt is on the wire');
  conn.inject({
    name: 'PARAM_VALUE',
    fields: { param_id: 'FOO', param_value: 1, param_type: 9, param_count: 1, param_index: 0 },
  });

  assert.equal(result[1].result, 'succeeded');
  assert.equal(result[1].detail, 'echo-confirmed');
  assert.equal(result[1].attempts, 2, 'the confirming attempt is recorded');
});

test('closing the node mid-set stops the re-send timer and releases done', async () => {
  const conn = connStubFull();
  const node = confirmSetNode(redStub({ conn }), conn, 15);

  const outs = [];
  let doneCalls = 0;
  node.emit('input', { payload: { paramId: 'FOO', value: 1 } },
    (m) => outs.push(m), () => { doneCalls += 1; });
  node.emit('close', () => {});
  await sleep(60);

  assert.equal(conn.sent.length, 1, 'no re-send after close');
  assert.equal(outs.length, 0, 'nothing emitted from a torn-down node');
  assert.equal(doneCalls, 1, 'the in-flight done was released');
  assert.equal(conn.activeCount(), 0);
});

/* ---------- confirm-tier read waits for the reply (#242) ---------- */

function confirmReadNode(RED, config) {
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  return new Node({
    delivery: 'confirm',
    action: 'read',
    connection: 'conn',
    targetSystem: 1,
    targetComponent: 1,
    ...config,
  });
}

test('read+confirm awaits the PARAM_VALUE reply and reports it', () => {
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
  assert.equal(result, undefined);

  const reply = {
    name: 'PARAM_VALUE',
    fields: { param_id: 'RC1_MIN', param_value: 1100, param_type: 9, param_count: 100, param_index: 7 },
  };
  conn.inject(reply);
  assert.equal(result[1].result, 'succeeded');
  assert.equal(result[1].detail, 'value-received');
  assert.equal(result[0].payload.fields.param_value, 1100, 'the reply is the result');
  assert.equal(conn.activeCount(), 0, 'subscription torn down on settle');
});

test('read+confirm by index matches the reply on param_index', () => {
  const conn = connStubFull();
  const node = confirmReadNode(redStub({ conn }), { lookup: 'index', paramIndex: 7 });

  let result;
  node.emit('input', { payload: {} }, (m) => { result = m; }, () => {});
  assert.equal(conn.sent[0].message.fields.param_index, 7);

  conn.inject({
    name: 'PARAM_VALUE',
    fields: { param_id: 'RC1_MIN', param_value: 1100, param_type: 9, param_count: 100, param_index: 6 },
  });
  assert.equal(result, undefined, 'a neighbouring index does not answer');
  conn.inject({
    name: 'PARAM_VALUE',
    fields: { param_id: 'RC1_MIN', param_value: 1100, param_type: 9, param_count: 100, param_index: 7 },
  });
  assert.equal(result[1].result, 'succeeded');
});

test('read+confirm times out honestly when no reply arrives', async () => {
  const conn = connStubFull();
  const node = confirmReadNode(redStub({ conn }), { paramId: 'RC1_MIN', timeout: 5 });

  let result;
  let doneErr;
  node.emit('input', { payload: {} }, (m) => { result = m; }, (err) => { doneErr = err; });
  await sleep(30);

  assert.equal(result[0], null);
  assert.equal(result[1].result, 'timed-out');
  assert.equal(result[1].detail, 'read timeout');
  assert.ok(doneErr instanceof Error);
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
    timeout,
  });
}

/** A list-member PARAM_VALUE from sysid/compid 1. */
function listValue(index, count) {
  return {
    name: 'PARAM_VALUE',
    fields: { param_id: `P${index}`, param_index: index, param_count: count, param_value: index, param_type: 9 },
  };
}

test('collect completes count 0 as an empty list', () => {
  const conn = connStubFull();
  const node = collectNode(redStub({ conn }), 100);

  let result;
  node.emit('input', { payload: {} }, (m) => { result = m; }, () => {});
  conn.inject({
    name: 'PARAM_VALUE',
    fields: { param_id: '', param_index: 65535, param_count: 0, param_value: 0, param_type: 9 },
  });

  assert.equal(result[1].result, 'succeeded');
  assert.equal(result[1].detail, 'list-complete');
  assert.deepEqual(result[0].payload, []);
});

test('collect re-requests a dropped index on inactivity and completes on its reply', async () => {
  const conn = connStubFull();
  // Timeout 200 → inactivity window 50 ms, nested inside the overall bound.
  const node = collectNode(redStub({ conn }), 200);

  const outs = [];
  node.emit('input', { payload: {} }, (m) => outs.push(m), () => {});
  conn.inject(listValue(0, 3));
  conn.inject(listValue(2, 3)); // index 1 dropped
  await sleep(90);

  const reads = conn.sent.filter((s) => s.message.name === 'PARAM_REQUEST_READ');
  // >= 1 rather than == 1: a slow event loop can let a second inactivity
  // round fire before the assertions run. Every round targets only the gap.
  assert.ok(reads.length >= 1, 'the missing index is re-requested');
  assert.ok(reads.every((s) => s.message.fields.param_index === 1), 'only the gap is re-requested');
  assert.equal(reads[0].options.band, require('../../lib/connection/bands').BAND.BULK);
  assert.ok(
    outs.some((m) => m[0] === null && m[1].result === 'progress' && /re-requesting 1 of 1/.test(m[1].detail)),
    'the refill is visible as a progress record'
  );

  conn.inject(listValue(1, 3));
  const terminal = outs[outs.length - 1];
  assert.equal(terminal[1].detail, 'list-complete');
  assert.deepEqual(terminal[0].payload.map((p) => p.index), [0, 1, 2]);
});

test('a 65535 set-echo stream cannot postpone the refill (#249)', async () => {
  const conn = connStubFull();
  // Timeout 400 → inactivity window 100 ms. A concurrent set echoes every
  // 25 ms; the collector ignores those frames (index 65535 is not a list
  // member), so they must not push the stall detector back — re-arming on
  // them postponed the refill forever while a real index was missing.
  const node = collectNode(redStub({ conn }), 400);

  const outs = [];
  node.emit('input', { payload: {} }, (m) => outs.push(m), () => {});
  conn.inject(listValue(0, 2)); // index 1 never arrives on its own
  const echoes = setInterval(() => conn.inject(listValue(65535, 2)), 25);
  await sleep(160);
  clearInterval(echoes);

  const reads = conn.sent.filter((s) => s.message.name === 'PARAM_REQUEST_READ');
  assert.ok(reads.length >= 1, 'the missing index is re-requested despite the echo stream');
  assert.ok(reads.every((s) => s.message.fields.param_index === 1), 'only the gap is re-requested');

  conn.inject(listValue(1, 2));
  const terminal = outs[outs.length - 1];
  assert.equal(terminal[1].detail, 'list-complete');
  assert.deepEqual(terminal[0].payload.map((p) => p.index), [0, 1]);
});

test('collect refill is bounded; the overall timeout stays the terminal authority', async () => {
  const conn = connStubFull();
  // Timeout 400 → inactivity window 100 ms: three refill rounds fit inside.
  const node = collectNode(redStub({ conn }), 400);

  const outs = [];
  let doneErr;
  node.emit('input', { payload: {} }, (m) => outs.push(m), (err) => { doneErr = err; });
  conn.inject(listValue(0, 2)); // index 1 never arrives
  await sleep(520);

  const reads = conn.sent.filter((s) => s.message.name === 'PARAM_REQUEST_READ');
  assert.equal(reads.length, 3, 'refill rounds are bounded');
  const terminal = outs[outs.length - 1];
  assert.equal(terminal[0], null);
  assert.equal(terminal[1].result, 'timed-out');
  assert.equal(terminal[1].detail, 'list timeout');
  assert.ok(doneErr instanceof Error);
  assert.equal(conn.activeCount(), 0, 'subscription and timers torn down');
});

test('an out-of-range PARAM_VALUE warns once and cannot complete the collect', () => {
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

  assert.equal(result, undefined, 'a bogus index must not satisfy the completion check');
  assert.equal(warns.length, 1, 'warned once, deduped');
  assert.match(warns[0], /index 9/);

  conn.inject(listValue(1, 2));
  assert.deepEqual(result[0].payload.map((p) => p.index), [0, 1]);
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
    peerTable: opts.peerTable || null,
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

// ── read-before-set: an Auto type asks the vehicle (owner-selected parity) ───

test('an auto-typed confirm set reads the type from the vehicle, then sets with it', () => {
  const conn = connStubFull();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    paramType: 'auto',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
  });

  const outs = [];
  let err;
  node.emit('input', { payload: { paramId: 'BAT_N_CELLS', value: 3 } },
    (m) => outs.push(m), (e) => { err = e; });

  assert.equal(conn.sent.length, 1, 'nothing but the read is on the wire yet');
  assert.equal(conn.sent[0].message.name, 'PARAM_REQUEST_READ');
  assert.equal(conn.sent[0].message.fields.param_id, 'BAT_N_CELLS');

  // The authority answers with its own type: INT32 (6).
  conn.inject({ name: 'PARAM_VALUE', sysid: 6, compid: 1, fields: { param_id: 'BAT_N_CELLS', param_value: 4, param_count: 10, param_index: 2, param_type: 6 } });

  assert.equal(conn.sent.length, 2, 'the set follows the answer');
  assert.equal(conn.sent[1].message.name, 'PARAM_SET');
  assert.equal(conn.sent[1].message.fields.param_type, 6, 'encoded with the vehicle’s type, never a guess (#222)');

  conn.inject({ name: 'PARAM_VALUE', sysid: 6, compid: 1, fields: { param_id: 'BAT_N_CELLS', param_value: 3, param_count: 10, param_index: 2, param_type: 6 } });

  const terminal = outs[outs.length - 1];
  assert.equal(terminal[1].result, 'succeeded');
  assert.equal(terminal[1].detail, 'echo-confirmed');
  assert.equal(err, undefined);
  node.emit('close', () => {});
});

test('an auto-typed fire-and-forget set reads first too, then reports sent', () => {
  const conn = connStubFull();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'send',
    action: 'set',
    paramType: 'auto',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
  });

  const outs = [];
  let err;
  node.emit('input', { payload: { paramId: 'FOO', value: 7 } },
    (m) => outs.push(m), (e) => { err = e; });

  assert.equal(conn.sent[0].message.name, 'PARAM_REQUEST_READ');
  conn.inject({ name: 'PARAM_VALUE', sysid: 6, compid: 1, fields: { param_id: 'FOO', param_value: 1, param_count: 1, param_index: 0, param_type: 2 } });

  assert.equal(conn.sent.length, 2);
  assert.equal(conn.sent[1].message.name, 'PARAM_SET');
  assert.equal(conn.sent[1].message.fields.param_type, 2);
  const terminal = outs[outs.length - 1];
  assert.equal(terminal[1].result, 'succeeded');
  assert.equal(terminal[1].detail, 'sent');
  assert.equal(err, undefined);
  assert.equal(conn.activeCount(), 0, 'the fire-and-forget set holds no subscription open');
  node.emit('close', () => {});
});

test('an explicit payload type wins over Auto — no read, straight to the set', () => {
  const conn = connStubFull();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'send',
    action: 'set',
    paramType: 'auto',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
  });

  node.emit('input', { payload: { paramId: 'FOO', value: 7, paramType: 'MAV_PARAM_TYPE_UINT8' } },
    () => {}, () => {});

  assert.equal(conn.sent.length, 1);
  assert.equal(conn.sent[0].message.name, 'PARAM_SET', 'an explicit type asks the vehicle nothing');
  assert.equal(conn.sent[0].message.fields.param_type, 1);
  node.emit('close', () => {});
});

test('a reply naming no usable type fails the set loud — never a fallback guess', () => {
  const conn = connStubFull();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    paramType: 'auto',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
  });

  let err;
  node.emit('input', { payload: { paramId: 'FOO', value: 7 } }, () => {}, (e) => { err = e; });

  // param_type 0: "the frame did not tell us".
  conn.inject({ name: 'PARAM_VALUE', sysid: 6, compid: 1, fields: { param_id: 'FOO', param_value: 1, param_count: 1, param_index: 0, param_type: 0 } });

  assert.ok(err, 'the set fails loud');
  assert.match(err.message, /no usable type for FOO/);
  assert.equal(conn.sent.length, 1, 'no PARAM_SET was encoded from a guess');
  node.emit('close', () => {});
});

test('type-read silence times out loud, and no PARAM_SET follows', () => {
  const conn = connStubFull();
  const RED = redStub({ conn });
  require('../../nodes/mavlink-param')(RED);
  const Node = RED.nodes.types['mavlink-param'];
  const node = new Node({
    delivery: 'confirm',
    action: 'set',
    paramType: 'auto',
    connection: 'conn',
    targetSystem: 6,
    targetComponent: 1,
    timeout: 5, // ms — fire quickly for the test
  });

  return new Promise((resolve) => {
    const outs = [];
    node.emit('input', { payload: { paramId: 'FOO', value: 7 } },
      (m) => outs.push(m),
      (e) => {
        const terminal = outs[outs.length - 1];
        assert.equal(terminal[1].result, 'timed-out');
        assert.equal(terminal[1].detail, 'type-read timeout');
        assert.ok(e, 'done carries the error');
        assert.equal(conn.sent.length, 1, 'only the read went out');
        assert.equal(conn.activeCount(), 0, 'the read subscription is released');
        resolve();
      });
  });
});
