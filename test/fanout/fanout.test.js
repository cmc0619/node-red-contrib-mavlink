'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeFanout,
  classifyMessage,
  selectFanoutMembers,
} = require('../../lib/fanout');
const { BAND } = require('../../lib/connection/bands');
const { streamLocks } = require('../../lib/delivery/lock');
const { offsetLatLon } = require('../../lib/formation');

test('selection resolves all, explicit list, and filters while excluding stale peers', () => {
  const peerTable = peerTableStub([
    peer(1, { type: 2, firmware: 'ardupilot', armed: true }),
    peer(2, { type: 3, firmware: 'px4', armed: false }),
    peer(3, { type: 2, firmware: 'ardupilot', armed: true, state: 'stale' }),
    { sysid: 4, components: [{ compid: 154, state: 'active', type: 26 }] },
  ]);

  assert.deepEqual(selectFanoutMembers(peerTable, { mode: 'all' }).map((m) => m.sysid), [1, 2]);
  assert.deepEqual(selectFanoutMembers(peerTable, { mode: 'list', sysids: '2, 3' }).map((m) => m.sysid), [2]);
  assert.deepEqual(
    selectFanoutMembers(peerTable, {
      mode: 'filter',
      filter: { type: 2, firmware: 'ardupilot', armed: true },
    }).map((m) => m.sysid),
    [1]
  );
});

test('a list selection coerces its sysids — an entry naming no vehicle selects none', () => {
  const peerTable = peerTableStub([peer(1), peer(2), peer(4)]);

  // The editor bounds every configured sysid (the members table,
  // mavlink-fanout.html) and a `msg.payload.targets` list is trusted runtime
  // input, so this coerces. An unreadable entry matches no peer, and the
  // aggregate record names the members that were actually selected.
  for (const bad of [[1, 'abc'], [1, 300], [1, 0], '1, 300', '1, abc']) {
    assert.deepEqual(
      selectFanoutMembers(peerTable, { mode: 'list', sysids: bad }).map((m) => m.sysid),
      [1],
      `${JSON.stringify(bad)} selects only the entry that names a vehicle`
    );
  }

  // Readable lists are untouched, in either spelling.
  assert.deepEqual(selectFanoutMembers(peerTable, { mode: 'list', sysids: [1, 4] }).map((m) => m.sysid), [1, 4]);
  assert.deepEqual(selectFanoutMembers(peerTable, { mode: 'list', sysids: ['1', '4'] }).map((m) => m.sysid), [1, 4]);
});

test('an empty resolution records which selection produced it (#226)', async () => {
  // The node's loud/quiet decision branches on the field: a filter matching
  // zero vehicles is an answer, a named list reaching nobody is a fault.
  const emptyFilter = await executeFanout({
    connection: connectionStub([peer(1, { firmware: 'ardupilot' })]),
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
    selection: { mode: 'filter', filter: { firmware: 'px4' } },
  });
  assert.equal(emptyFilter.result, 'empty');
  assert.equal(emptyFilter.success, false);
  assert.equal(emptyFilter.continue, false, 'no phantom success (§2)');
  assert.equal(emptyFilter.selection, 'filter');

  const emptyList = await executeFanout({
    connection: connectionStub([peer(1)]),
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
    selection: { mode: 'list', sysids: '9' },
  });
  assert.equal(emptyList.result, 'empty');
  assert.equal(emptyList.selection, 'list');
});

// ── Delivery tier membership (owner ruling, 2026-08-14) ──────────────────────

test("a typo'd delivery tier sends nothing — it matches no tier arm", async () => {
  // Each tier is an affirmative switch arm (§5), so a token the editor cannot
  // save (`delivery` carries RED.mavlink.oneOf) selects neither Confirm nor
  // Send. Nothing reaches the wire; the aggregate craters on the record that
  // was never produced.
  const connection = connectionStub([peer(1, { firmware: 'ardupilot' })]);
  const result = await executeFanout({
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'cofnirm',
    selection: { mode: 'all' },
  });
  assert.equal(connection.sends.length, 0, 'nothing reached the wire');
  assert.equal(result.success, false, 'and nothing is reported as delivered');
  assert.equal(result.continue, false, 'no phantom success (§2)');
});

// ── The replicator contract: message in, kind inferred from its name ──────────

test('classifyMessage infers confirmation and band from the message name', () => {
  assert.equal(classifyMessage(builtCommand(), 'sequential').kind.confirmation, 'command_ack');
  assert.equal(classifyMessage(builtCommand({ name: 'COMMAND_INT' }), 'sequential').kind.commandId, 400);
  assert.equal(classifyMessage(builtParamSet(), 'sequential').kind.confirmation, 'param_echo');
  assert.equal(classifyMessage(builtSetpoint(), 'sequential').kind.confirmation, 'none');
  // An unknown-but-targeted message replicates fire-and-forget.
  assert.equal(
    classifyMessage({ name: 'SET_MODE', fields: { target_system: 1, base_mode: 1, custom_mode: 4 } }, 'sequential')
      .kind.confirmation,
    'none'
  );
});

test('a payload that is not a built message craters — no build-tier guardrail', () => {
  const connection = connectionStub([peer(1)]);
  // No shape guard: a malformed payload reads `.name`/`.fields` off a non-object
  // or a message with no fields and craters (TypeError), rather than a curated
  // "wire a Build node" refusal.
  for (const bad of [null, 42, 'arm', {}, { name: 'COMMAND_LONG' }]) {
    assert.throws(
      () => executeFanout({ mode: 'sequential', selection: { mode: 'all' }, connection, message: bad, delivery: 'send' })
    );
  }
  assert.equal(connection.sends.length, 0);
});

test('mission transfer steps and PARAM_REQUEST_LIST are refused — not single-message actions (§10)', async () => {
  const connection = connectionStub([peer(1)]);

  for (const name of [
    'MISSION_COUNT',
    'MISSION_ITEM_INT',
    'MISSION_REQUEST_LIST',
    'MISSION_ACK',
    'MISSION_WRITE_PARTIAL_LIST',
  ]) {
    const refused = await executeFanout({ mode: 'sequential', selection: { mode: 'all' },
      connection,
      message: { name, fields: { target_system: 1, target_component: 1, count: 4 } },
      delivery: 'send',
    });
    assert.equal(refused.result, 'refused', `${name} must refuse`);
    assert.match(refused.detail, /mission transfer/);
  }

  const paramList = await executeFanout({ mode: 'sequential', selection: { mode: 'all' },
    connection,
    message: { name: 'PARAM_REQUEST_LIST', fields: { target_system: 1, target_component: 1 } },
    delivery: 'send',
  });
  assert.equal(paramList.result, 'refused');
  assert.match(paramList.detail, /bulk transfer/);
  assert.equal(connection.sends.length, 0);
});

test('single-shot MISSION_* commands replicate — the family name is not the rule (§10)', async () => {
  // MISSION_SET_CURRENT ("everyone jump to waypoint 5") and MISSION_CLEAR_ALL
  // ("everyone wipe your mission") are addressed single messages, not steps in
  // a transfer. A MISSION_ prefix match refused them; the explicit step list
  // does not. Neither carries a COMMAND_ACK, so both stay fire-and-forget.
  const connection = connectionStub([peer(1), peer(2)]);

  const setCurrent = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: { name: 'MISSION_SET_CURRENT', fields: { target_system: 0, target_component: 0, seq: 5 } },
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  assert.equal(setCurrent.success, true);
  assert.deepEqual(connection.sends.map((s) => s.message.fields.target_system), [1, 2]);
  assert.equal(connection.sends[0].message.fields.seq, 5);

  const clearAll = await executeFanout({ selection: { mode: 'all' },
    connection: connectionStub([peer(1)]),
    message: { name: 'MISSION_CLEAR_ALL', fields: { target_system: 0, target_component: 0, mission_type: 0 } },
    mode: 'sequential',
    delivery: 'send',
  });
  assert.equal(clearAll.success, true);
});

test('every offboard setpoint rides the streaming band, not just the position pair', async () => {
  // A SET_POSITION_TARGET_ prefix left SET_ATTITUDE_TARGET and
  // SET_ACTUATOR_CONTROL_TARGET on the control band, where a 50 Hz stream
  // competes with arm/RTL for the queue.
  for (const name of [
    'SET_POSITION_TARGET_LOCAL_NED',
    'SET_POSITION_TARGET_GLOBAL_INT',
    'SET_ATTITUDE_TARGET',
    'SET_ACTUATOR_CONTROL_TARGET',
  ]) {
    const kind = classifyMessage(
      { name, fields: { target_system: 1, target_component: 1 } },
      'sequential'
    ).kind;
    assert.equal(kind.band, BAND.STREAMING, `${name} must ride the streaming band`);
    assert.equal(kind.confirmation, 'none', `${name} carries no acknowledgement`);
  }
});

test('a message with no target_system field cannot be retargeted and is refused', async () => {
  const connection = connectionStub([peer(1)]);
  const result = await executeFanout({ mode: 'sequential', selection: { mode: 'all' },
    connection,
    message: { name: 'HEARTBEAT', fields: { type: 6, autopilot: 8 } },
    delivery: 'send',
  });
  assert.equal(result.result, 'refused');
  assert.match(result.detail, /target_system/);
});

// ── Replication mechanics ─────────────────────────────────────────────────────

test('sequential execution paces retargeted sends between members', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const waits = [];

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 25,
    wait: async (ms) => waits.push(ms),
  });

  assert.equal(result.success, true);
  assert.equal(result.action, 'COMMAND_LONG', 'aggregate names the replicated message');
  assert.deepEqual(waits, [25, 25]);
  assert.deepEqual(connection.sends.map((s) => s.message.fields.target_system), [1, 2, 3]);
  assert.deepEqual(connection.sends.map((s) => s.message.fields.target_component), [1, 1, 1]);
});

test('retargeting does not invent target_component on a system-only message', async () => {
  const connection = connectionStub([peer(1)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: { name: 'SET_MODE', fields: { target_system: 9, base_mode: 1, custom_mode: 4 } },
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(result.success, true);
  assert.equal(connection.sends[0].message.fields.target_system, 1);
  assert.equal('target_component' in connection.sends[0].message.fields, false);
});

test('broadcast sends one autopilot-pinned packet with target_system zero', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    mode: 'broadcast',
    delivery: 'send',
  });

  assert.equal(result.success, true);
  assert.equal(connection.sends.length, 1);
  assert.equal(connection.sends[0].message.fields.target_system, 0);
  assert.equal(connection.sends[0].message.fields.target_component, 1);
});

test('bands follow the message kind: setpoints stream, commands ride control', async () => {
  const connection = connectionStub([peer(1)]);
  await executeFanout({ mode: 'sequential', selection: { mode: 'all' }, connection, message: builtSetpoint(), delivery: 'send' });
  await executeFanout({ mode: 'sequential', selection: { mode: 'all' }, connection, message: builtCommand(), delivery: 'send' });
  const [setpoint, command] = connection.sends;
  assert.notEqual(setpoint.options.band, command.options.band);
});

test('aggregation continues only when every selected member succeeds', async () => {
  const allOk = await executeFanout({ selection: { mode: 'all' },
    connection: connectionStub([peer(1), peer(2)]),
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
  });

  const partial = await executeFanout({ selection: { mode: 'all' },
    connection: connectionStub([peer(1), peer(2)], { failSysids: new Set([2]) }),
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(allOk.success, true);
  assert.equal(allOk.continue, true);
  assert.equal(partial.success, false);
  assert.equal(partial.continue, false);
  assert.equal(partial.members.find((m) => m.sysid === 2).result, 'failed');
});

test('dry run expands members and retargets messages without sending', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
    dryRun: true,
  });

  assert.equal(result.result, 'dry_run');
  assert.equal(result.success, true);
  assert.equal(connection.sends.length, 0);
  assert.deepEqual(result.members.map((m) => m.message.fields.target_system), [1, 2]);
});

test('member expiring mid-run is reported failed while later members continue', async () => {
  const rows = [peer(1), peer(2), peer(3)];
  const connection = connectionStub(rows, {
    afterSend(message) {
      if (message.fields.target_system === 1) {
        rows[1].components[0].state = 'stale';
      }
    },
  });

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(result.success, false);
  assert.deepEqual(connection.sends.map((s) => s.message.fields.target_system), [1, 3]);
  assert.equal(result.members.find((m) => m.sysid === 2).result, 'failed');
  assert.match(result.members.find((m) => m.sysid === 2).detail, /expired|stale/);
});

test('suppress does nothing', () => {
});

// ── Broadcast guards (§10) ────────────────────────────────────────────────────

test('broadcast aggregate warns about mixed firmware for uniform commands', async () => {
  const connection = connectionStub([
    peer(1, { firmware: 'ardupilot', flightMode: 4 }),
    peer(2, { firmware: 'px4', flightMode: 4 }),
  ]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand({ fields: { param1: 1 } }),
    mode: 'broadcast',
    delivery: 'send',
  });

  assert.equal(result.success, true);
  assert.match(result.warnings.join('\n'), /mixed firmware/);
});

test('broadcast refuses a filtered or explicit-list selection and sends nothing (§10)', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const list = await executeFanout({
    connection,
    message: builtCommand(),
    mode: 'broadcast',
    delivery: 'send',
    selection: { mode: 'list', sysids: '1' },
  });
  const filter = await executeFanout({
    connection,
    message: builtCommand(),
    mode: 'broadcast',
    delivery: 'send',
    selection: { mode: 'filter', filter: { firmware: 'px4' } },
  });

  assert.equal(list.result, 'refused');
  assert.match(list.detail, /broadcast/);
  assert.match(list.detail, /list/);
  assert.equal(filter.result, 'refused');
  assert.match(filter.detail, /filter/);
  assert.equal(connection.sends.length, 0, 'a refused broadcast blasts nobody');
});

test('broadcast still allows an explicit all-vehicles selection', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({
    connection,
    message: builtCommand(),
    mode: 'broadcast',
    delivery: 'send',
    selection: { mode: 'all' },
  });

  assert.equal(result.success, true);
  assert.equal(connection.sends.length, 1);
  assert.equal(connection.sends[0].message.fields.target_system, 0);
});

test('broadcast refuses when stale peers exist even under all-vehicles selection (§10)', async () => {
  const connection = connectionStub([
    peer(1),
    peer(2, { state: 'stale' }),
  ]);

  const result = await executeFanout({
    connection,
    message: builtCommand(),
    mode: 'broadcast',
    delivery: 'send',
    selection: { mode: 'all' },
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /stale|expired/);
  assert.equal(connection.sends.length, 0);
});

test('PARAM_SET is sequential-only — a broadcast set makes the echoes a storm (§10)', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtParamSet(),
    mode: 'broadcast',
    delivery: 'send',
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /sequential/);
  assert.equal(connection.sends.length, 0);
});

test('DO_FLIGHTTERMINATION fans out without a confirm gate', async () => {
  const message = builtCommand({ fields: { command: 185, param1: 1 } });
  const connection = connectionStub([peer(1)]);
  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message,
    mode: 'sequential',
    delivery: 'send',
  });
  assert.equal(result.success, true);
  assert.equal(connection.sends[0].message.fields.command, 185);
});

test('a broadcast position setpoint packs without a confirm gate', async () => {
  const positionMask = 3576;
  const connection = connectionStub([peer(1), peer(2)]);
  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtSetpoint({ fields: { type_mask: positionMask, x: 10, y: 5, z: -20, vx: 0 } }),
    mode: 'broadcast',
    delivery: 'send',
  });
  assert.equal(result.success, true);
  assert.equal(connection.sends.length, 1);
  assert.equal(connection.sends[0].message.fields.target_system, 0);
});

test('sequential position setpoints are not confirm-gated — the hazard is broadcast convergence (#245)', async () => {
  const connection = connectionStub([peer(1), peer(2)]);
  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtSetpoint({ fields: { type_mask: 3576, x: 10, y: 5, z: -20, vx: 0 } }),
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });
  assert.equal(result.success, true);
  assert.equal(connection.sends.length, 2);
});

// ── Single-owner setpoint streams (#245) ──────────────────────────────────────

test('a setpoint fan-out refuses a lock-held member and continues with the rest (#245)', async () => {
  const connection = connectionStub([peer(1), peer(2)], { id: 'conn-A' });
  // Simulate a Move stream owning vehicle 1 on this connection: the shared
  // process-wide `streamLocks` registry IS the contract, so acquire on it
  // exactly as nodes/mavlink-move.js does.
  const release = streamLocks.acquire('conn-A', { sysid: 1, compid: 1 });
  try {
    const result = await executeFanout({ selection: { mode: 'all' },
      connection,
      message: builtSetpoint(),
      mode: 'sequential',
      delivery: 'send',
      intervalMs: 0,
    });
    assert.equal(result.success, false);
    const bySysid = Object.fromEntries(result.members.map((m) => [m.sysid, m]));
    assert.equal(bySysid[1].result, 'refused');
    assert.match(bySysid[1].detail, /setpoint stream to 1\.1 is already running/);
    assert.equal(bySysid[2].result, 'sent', 'the free member is still commanded (§10 continue doctrine)');
    assert.deepEqual(connection.sends.map((s) => s.message.fields.target_system), [2]);
  } finally {
    release();
  }

  // Released, the same run succeeds — the refusal was the lock, nothing else.
  const after = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtSetpoint(),
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });
  assert.equal(after.success, true);
});

test('the lock key is (connection, target): another connection or a command is unaffected (#245)', async () => {
  const release = streamLocks.acquire('conn-A', { sysid: 1, compid: 1 });
  try {
    // Same sysid on a different connection is a different vehicle.
    const crossConn = await executeFanout({ selection: { mode: 'all' },
      connection: connectionStub([peer(1)], { id: 'conn-B' }),
      message: builtSetpoint(),
      mode: 'sequential',
      delivery: 'send',
    });
    assert.equal(crossConn.success, true);

    // A command to the locked vehicle is not a stream conflict: the lock's
    // scope is setpoint streams, and a command has its own ack visibility.
    const command = await executeFanout({ selection: { mode: 'all' },
      connection: connectionStub([peer(1)], { id: 'conn-A' }),
      message: builtCommand(),
      mode: 'sequential',
      delivery: 'send',
    });
    assert.equal(command.success, true);
  } finally {
    release();
  }
});

test('a broadcast setpoint refuses entirely while any member is lock-held (#245)', async () => {
  // One packet reaches every vehicle and cannot exclude the streamed-to one.
  const connection = connectionStub([peer(1), peer(2)], { id: 'conn-A' });
  const release = streamLocks.acquire('conn-A', { sysid: 2, compid: 1 });
  try {
    const result = await executeFanout({ selection: { mode: 'all' },
      connection,
      message: builtSetpoint(),
      mode: 'broadcast',
      delivery: 'send',
    });
    assert.equal(result.result, 'refused');
    assert.match(result.detail, /setpoint stream to 2\.1/);
    assert.match(result.detail, /broadcast cannot exclude/);
    assert.equal(connection.sends.length, 0);
  } finally {
    release();
  }
});

test('one-shot setpoint runs hold nothing: a stream may start right after (#245)', async () => {
  // The lock marks a persistent stream owner. A fan-out setpoint has no
  // lifetime to own — a Move stream starting after it supersedes it, exactly
  // like Move's own handover setpoint — so the run leaves the registry
  // untouched and a Move-style acquire succeeds immediately.
  const connection = connectionStub([peer(1)], { id: 'conn-A' });
  await executeFanout({ selection: { mode: 'all' }, connection, message: builtSetpoint(), mode: 'sequential', delivery: 'send' });
  assert.equal(streamLocks.isHeld('conn-A', { sysid: 1, compid: 1 }), false);
  const release = streamLocks.acquire('conn-A', { sysid: 1, compid: 1 });
  assert.notEqual(release, null, 'a Move-style acquire succeeds after the one-shot');
  release();
});

test('the lock guards the wire: build tier and dry run pass while it is held (#245)', async () => {
  const connection = connectionStub([peer(1)], { id: 'conn-A' });
  const release = streamLocks.acquire('conn-A', { sysid: 1, compid: 1 });
  try {
    const built = await executeFanout({ selection: { mode: 'all' },
      connection,
      message: builtSetpoint(),
      mode: 'sequential',
      delivery: 'build',
    });
    assert.equal(built.success, true);
    const preview = await executeFanout({ selection: { mode: 'all' },
      connection,
      message: builtSetpoint(),
      mode: 'sequential',
      delivery: 'send',
      dryRun: true,
    });
    assert.equal(preview.result, 'dry_run');
    assert.equal(connection.sends.length, 0);
  } finally {
    release();
  }
});

// ── Per-target overrides (targets) ────────────────────────────────────────────

test('targets selects the listed sysids and patches wire fields per member', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand({ fields: { command: 192, param7: 30 } }),
    // Wire units — Fan-out is a raw surface; on COMMAND_LONG the reposition
    // lat/lon ride param5/param6 as plain degrees floats.
    targets: [
      { sysid: 1, param5: 47.4, param6: 8.5 },
      { sysid: 3, param5: 47.6, param6: 8.7 },
    ],
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  assert.equal(result.success, true);
  assert.equal(result.count, 2, 'the targets list is the selection — sysid 2 excluded');
  const bySysid = Object.fromEntries(
    connection.sends.map((s) => [s.message.fields.target_system, s.message.fields])
  );
  assert.equal(bySysid[1].param5, 47.4);
  assert.equal(bySysid[3].param5, 47.6);
  assert.equal(bySysid[1].param7, 30, 'shared fields still apply under a patch');
  assert.equal(bySysid[3].param7, 30);
  assert.equal(bySysid[2], undefined);
});

test('bare-sysid targets replicate the shared message unpatched', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    targets: [1, 3],
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  assert.equal(result.success, true);
  assert.deepEqual(connection.sends.map((s) => s.message.fields.target_system), [1, 3]);
});

test('a patch cannot cross-address another vehicle — target_system is forced back', async () => {
  const connection = connectionStub([peer(1)]);

  await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    targets: [{ sysid: 1, target_system: 99 }],
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(connection.sends[0].message.fields.target_system, 1);
});

test('broadcast refuses targets — one packet carries one field set (§10)', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    targets: [{ sysid: 1, param5: -35 }],
    mode: 'broadcast',
    delivery: 'send',
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /uniform/);
  assert.equal(connection.sends.length, 0, 'nothing reaches the wire');
});

test('duplicate sysids in targets refuse — last-wins merging would silently drop a patch (§10, #265)', async () => {
  // The override map merges last-wins, so a duplicated entry shrank the fleet
  // and dropped the first patch — an operator error reported as success.
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    targets: [{ sysid: 1, param5: 47.4 }, 2, { sysid: 1, param5: 47.6 }],
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /sysid 1 more than once/);
  assert.equal(connection.sends.length, 0, 'nothing reaches the wire');
});

test('a targets patch may not rewrite `command` — the safety gate runs once, on the base', async () => {
  // The run is classified and gated from the base message before any patch is
  // applied, so a patch rewriting `command` would send an operation that was
  // never gated: `{sysid, command: 185}` under a base of ARM put Flight
  // Termination on the wire with no confirmation.
  const connection = connectionStub([peer(1)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand({ fields: { command: 400, param1: 1 } }),
    targets: [{ sysid: 1, command: 185 }],
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /may not patch `command`/);
  assert.equal(connection.sends.length, 0, 'nothing reaches the wire');
});

// ── Config member metre offsets (#163) ────────────────────────────────────────

test('member metre offsets patch degE7 fields on COMMAND_INT with lib/formation\'s math', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    // Reposition on the INT carrier: x/y are degE7, z metres (up-positive).
    message: {
      name: 'COMMAND_INT',
      fields: { target_system: 0, target_component: 0, command: 192, frame: 6, x: 470000000, y: 80000000, z: 30 },
    },
    members: [{ sysid: 1, north: 10, up: 5 }, { sysid: 2 }],
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  assert.equal(result.success, true);
  const bySysid = Object.fromEntries(
    connection.sends.map((s) => [s.message.fields.target_system, s.message.fields])
  );
  // The one home of the metre→degree math is lib/formation's offsetLatLon —
  // and 10 m north at lat 47° is a hand-checked +898 degE7.
  const at = offsetLatLon(47, 8, 10, 0);
  assert.equal(bySysid[1].x, Math.round(at.lat * 1e7));
  assert.equal(bySysid[1].x, 470000898, '10 m north = +898 degE7 (flat earth)');
  assert.equal(bySysid[1].y, Math.round(at.lon * 1e7));
  assert.equal(bySysid[1].z, 35, 'global alt is up-positive: up adds');
  assert.equal(bySysid[2].x, 470000000, 'a bare row keeps the base position');
  assert.equal(bySysid[2].z, 30);
});

test('an east offset scales through cos(lat), not the latitude divisor', async () => {
  // The north-only case above leaves longitude untouched, so it never exercises
  // the cos(lat) division or the longitude rounding — a sign flip or a missing
  // cos(lat) on the east axis would pass it. At 47° a metre of easting is worth
  // ~1.47x the degrees a metre of northing is.
  const connection = connectionStub([peer(1)]);

  await executeFanout({ selection: { mode: 'all' },
    connection,
    message: {
      name: 'COMMAND_INT',
      fields: { target_system: 0, target_component: 0, command: 192, frame: 6, x: 470000000, y: 80000000, z: 30 },
    },
    members: [{ sysid: 1, east: 10 }],
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  const fields = connection.sends[0].message.fields;
  const at = offsetLatLon(47, 8, 0, 10);
  assert.equal(fields.y, Math.round(at.lon * 1e7));
  assert.ok(fields.y > 80000000, 'east moves longitude positive');
  assert.equal(fields.x, 470000000, 'an east-only offset leaves latitude alone');
  const dLon = fields.y - 80000000;
  assert.ok(dLon > 898 && dLon < 1400,
    `10 m east at 47° is ~1318 degE7 (898 / cos 47°), got ${dLon}`);
});

test('offsets patch no coordinate on a frame whose metre scale is not measured', async () => {
  // Local-frame INT x/y are metres ×1e4 (§14-measured), so the degE7 path
  // would turn a commanded 10 m into ~9 cm; a body frame re-aims "north"
  // along the vehicle's own heading. Neither frame matches the offset
  // surface, so no coordinate patch is produced — the message goes out as
  // built, and the raw patch surface is how a flow reaches those frames.
  const intConn = connectionStub([peer(1)]);
  const intResult = await executeFanout({ selection: { mode: 'all' },
    connection: intConn,
    message: {
      name: 'COMMAND_INT',
      fields: { target_system: 0, target_component: 0, command: 192, frame: 1, x: 50000, y: 0, z: 30 },
    },
    members: [{ sysid: 1, north: 10 }],
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });
  assert.equal(intResult.result, 'succeeded');
  assert.equal(intConn.sends[0].message.fields.x, 50000, 'x is untouched, never degE7-scaled');

  const localConn = connectionStub([peer(1)]);
  const localResult = await executeFanout({ selection: { mode: 'all' },
    connection: localConn,
    message: {
      name: 'SET_POSITION_TARGET_LOCAL_NED',
      // MAV_FRAME_BODY_OFFSET_NED (9): x is body-forward, not north.
      fields: { target_system: 0, target_component: 0, coordinate_frame: 9, x: 0, y: 0, z: -10 },
    },
    members: [{ sysid: 1, north: 5 }],
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });
  assert.equal(localResult.result, 'succeeded');
  assert.equal(localConn.sends[0].message.fields.x, 0, 'the body-axis x is left alone');
});

test('member metre offsets on SET_POSITION_TARGET_LOCAL_NED apply directly with up = -z', async () => {
  const connection = connectionStub([peer(1)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtSetpoint(),
    members: [{ sysid: 1, north: 3, east: 4, up: 5 }],
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(result.success, true);
  const fields = connection.sends[0].message.fields;
  assert.equal(fields.x, 3, 'north adds to NED x, no geo conversion');
  assert.equal(fields.y, 4, 'east adds to NED y');
  assert.equal(fields.z, -5, 'NED z is down-positive: up subtracts');
});

test('member offsets on a message with no position surface refuse, naming message and member', async () => {
  const connection = connectionStub([peer(1)]);

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: { name: 'SET_MODE', fields: { target_system: 1, base_mode: 1, custom_mode: 4 } },
    members: [{ sysid: 1, north: 10 }],
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /member 1/);
  assert.match(result.detail, /SET_MODE/);
  assert.equal(connection.sends.length, 0, 'nothing reaches the wire');
});

test('a malformed targets shape is refused before any send', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  // A non-array, a broadcast sysid, an out-of-range sysid, and an entry with
  // no sysid at all: each would silently select or patch the wrong vehicles.
  for (const bad of ['1,2', [0], [256], [{ param5: -35 }]]) {
    const result = await executeFanout({ selection: { mode: 'all' },
      connection,
      message: builtCommand(),
      targets: bad,
      mode: 'sequential',
      delivery: 'send',
    });

    assert.equal(result.result, 'refused', `${JSON.stringify(bad)} must refuse`);
    assert.match(result.detail, /targets/);
  }
  assert.equal(connection.sends.length, 0);
});

// ── Concurrency (§10) ─────────────────────────────────────────────────────────

test('concurrency overlaps confirm waits so a straggler does not serialize the fleet', async () => {
  const handlers = [];
  const connection = {
    peerTable: peerTableStub([peer(1), peer(2)]),
    sends: [],
    send(message, options) { this.sends.push({ message, options }); },
    resolveSourceIds: () => null,
    subscribe(filter, handler) {
      handlers.push(handler);
      return () => {};
    },
  };
  const deliver = (decoded) => handlers.slice().forEach((h) => h(decoded));

  const run = executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'confirm',
    intervalMs: 0,
    concurrency: 2,
    timeoutMs: 60000,
  });

  // Both members' commands are on the wire before either ack arrives — at
  // concurrency 1 the second send would still be waiting on member 1's ack.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(connection.sends.map((s) => s.message.fields.target_system), [1, 2]);

  deliver({ sysid: 2, compid: 1, fields: { command: 400, result: 0 } });
  deliver({ sysid: 1, compid: 1, fields: { command: 400, result: 0 } });
  const result = await run;

  assert.equal(result.success, true);
  assert.deepEqual(result.members.map((m) => m.sysid), [1, 2], 'records stay in member order');
});

test('at the default concurrency 1 the second member waits for the first ack', async () => {
  const handlers = [];
  const connection = {
    peerTable: peerTableStub([peer(1), peer(2)]),
    sends: [],
    send(message, options) { this.sends.push({ message, options }); },
    resolveSourceIds: () => null,
    subscribe(filter, handler) {
      handlers.push(handler);
      return () => {};
    },
  };
  const deliver = (decoded) => handlers.slice().forEach((h) => h(decoded));

  const run = executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'confirm',
    intervalMs: 0,
    timeoutMs: 60000,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connection.sends.length, 1, 'member 2 not launched while member 1 awaits its ack');

  deliver({ sysid: 1, compid: 1, fields: { command: 400, result: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  deliver({ sysid: 2, compid: 1, fields: { command: 400, result: 0 } });
  const result = await run;
  assert.equal(result.success, true);
});

// ── Stop-on-error (§10) ───────────────────────────────────────────────────────

test('stop-on-error halts after the first failure and reports the rest skipped', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)], { failSysids: new Set([1]) });

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
    stopOnError: true,
  });

  assert.equal(result.success, false);
  assert.equal(connection.sends.length, 0, 'members after the failure are never sent to');
  assert.equal(result.members.find((m) => m.sysid === 1).result, 'failed');
  assert.equal(result.members.find((m) => m.sysid === 2).result, 'skipped');
  assert.equal(result.members.find((m) => m.sysid === 3).result, 'skipped');
  assert.match(result.members.find((m) => m.sysid === 2).detail, /never sent/);
});

test('stop-on-error re-checks after the inter-member pause (concurrency > 1)', async () => {
  // At concurrency > 1 an earlier member is still in flight during the pause,
  // so the pre-wait verdict is stale by up to intervalMs. Without a re-check
  // after the wait, a fast failure landing inside that window still dispatched
  // the next member.
  const connection = connectionStub([peer(1), peer(2), peer(3)], { failSysids: new Set([1]) });

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
    concurrency: 3,
    intervalMs: 5,
    stopOnError: true,
    // Yield long enough for member 1's failure record to settle mid-pause.
    wait: () => new Promise((resolve) => setTimeout(resolve, 5)),
  });

  assert.equal(result.success, false);
  assert.equal(connection.sends.length, 0, 'members 2 and 3 are never dispatched');
  assert.equal(result.members.find((m) => m.sysid === 1).result, 'failed');
  assert.equal(result.members.find((m) => m.sysid === 2).result, 'skipped');
  assert.equal(result.members.find((m) => m.sysid === 3).result, 'skipped');
});

test('a targets patch cannot re-address the message away from the member autopilot', async () => {
  // sendOptions and the confirm waiter are both keyed on member.compid, so a
  // patched target_component would address the wire message at a component
  // neither agrees with — the autopilot ignores it and the ack wait times out.
  const connection = connectionStub([peer(1)]);

  await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand({ fields: { command: 192, param7: 30 } }),
    targets: [{ sysid: 1, target_system: 99, target_component: 42, param5: 47.4 }],
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  const fields = connection.sends[0].message.fields;
  assert.equal(fields.target_system, 1, 'sysid pinned to the member');
  assert.equal(fields.target_component, 1, 'compid pinned to the member autopilot');
  assert.equal(fields.param5, 47.4, 'non-addressing patches still apply');
  assert.equal(fields.param7, 30, 'shared fields survive');
});

test('pinning never invents target_component on a system-only message', async () => {
  const connection = connectionStub([peer(1)]);

  await executeFanout({ selection: { mode: 'all' },
    connection,
    message: { name: 'SET_MODE', fields: { target_system: 9, base_mode: 1, custom_mode: 4 } },
    targets: [{ sysid: 1, target_component: 42 }],
    mode: 'sequential',
    delivery: 'send',
  });

  const fields = connection.sends[0].message.fields;
  assert.equal(fields.target_system, 1);
  assert.equal('target_component' in fields, false, 'a declared-field-only message stays that shape');
});

test('without stop-on-error every member is still attempted (the §10 default)', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)], { failSysids: new Set([1]) });

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  assert.equal(result.success, false);
  assert.deepEqual(connection.sends.map((s) => s.message.fields.target_system), [2, 3]);
  assert.equal(result.members.filter((m) => m.result === 'skipped').length, 0);
});

// ── Confirmation ──────────────────────────────────────────────────────────────

test('broadcast confirm matches COMMAND_ACK on sysid AND component (§10)', async () => {
  const handlers = [];
  const connection = {
    peerTable: peerTableStub([peer(1)]),
    sends: [],
    send(message, options) {
      this.sends.push({ message, options });
    },
    resolveSourceIds: () => null,
    subscribe(filter, handler) {
      handlers.push(handler);
      return () => {};
    },
  };
  const deliver = (decoded) => handlers.forEach((h) => h(decoded));

  const promise = executeFanout({
    connection,
    message: builtCommand({ fields: { param1: 1 } }),
    mode: 'broadcast',
    delivery: 'confirm',
    selection: { mode: 'all' },
    timeoutMs: 1000,
  });

  // A gimbal (component 154) FAILED ack must be ignored — matching sysid alone
  // would wrongly settle the autopilot's command as failed.
  deliver({ sysid: 1, compid: 154, fields: { command: 400, result: 4 } });
  // The addressed autopilot (component 1) then ACCEPTS.
  deliver({ sysid: 1, compid: 1, fields: { command: 400, result: 0 } });

  const result = await promise;
  assert.equal(result.success, true, 'the autopilot ack, not the gimbal ack, decided the outcome');
  const member = result.members.find((m) => m.sysid === 1);
  assert.equal(member.confirmedBy, 'ack');
});

test('a fan-out member record carries the terminal ack\'s result_param2 (§9, Codex)', async () => {
  // Same §9 rule as Command and Payload: the member record is an ack-confirmed
  // status record, so a denial that came with a reason must not flatten to a
  // bare result on the way through the fan-out.
  const handlers = [];
  const connection = {
    peerTable: peerTableStub([peer(1)]),
    sends: [],
    send(message, options) {
      this.sends.push({ message, options });
    },
    resolveSourceIds: () => null,
    subscribe(filter, handler) {
      handlers.push(handler);
      return () => {};
    },
  };
  const deliver = (decoded) => handlers.forEach((h) => h(decoded));

  const promise = executeFanout({
    connection,
    message: builtCommand({ fields: { param1: 1 } }),
    mode: 'broadcast',
    delivery: 'confirm',
    selection: { mode: 'all' },
    timeoutMs: 1000,
  });

  deliver({ sysid: 1, compid: 1, fields: { command: 400, result: 2, result_param2: 11 } });

  const result = await promise;
  const member = result.members.find((m) => m.sysid === 1);
  assert.equal(member.resultCode, 2);
  assert.equal(member.resultParam2, 11, 'the denial reason survives the member record');
});

test('an ack explicitly addressed to another GCS never settles our wait (§9/§10)', async () => {
  const handlers = [];
  const connection = {
    peerTable: peerTableStub([peer(1)]),
    sends: [],
    send(message, options) { this.sends.push({ message, options }); },
    subscribe(filter, handler) {
      handlers.push(handler);
      return () => {};
    },
    // We are GCS 250/190 on a link shared with another station.
    resolveSourceIds() { return { sysid: 250, compid: 190 }; },
  };
  const deliver = (decoded) => handlers.slice().forEach((h) => h(decoded));

  const run = executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'confirm',
    intervalMs: 0,
    timeoutMs: 60000,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // The other GCS (255) gets a FAILED answer to *its* identical command…
  deliver({ sysid: 1, compid: 1, fields: { command: 400, result: 4, target_system: 255, target_component: 190 } });
  // …ours arrives addressed to us and is ACCEPTED. A MAVLink 1 ack (no target
  // fields) would also pass the gate.
  deliver({ sysid: 1, compid: 1, fields: { command: 400, result: 0, target_system: 250, target_component: 190 } });

  const result = await run;
  assert.equal(result.success, true, "the other station's FAILED ack did not settle our wait");
});

test('PARAM_SET echo confirm compares wire values — a clamped value does not confirm', async () => {
  const handlers = [];
  const makeConnection = () => ({
    peerTable: peerTableStub([peer(5)]),
    sends: [],
    send(message, options) { this.sends.push({ message, options }); },
    resolveSourceIds: () => null,
    subscribe(filter, handler) {
      handlers.push(handler);
      return () => {};
    },
  });
  const deliver = (decoded) => handlers.splice(0).forEach((h) => h(decoded));

  // The vehicle applies the set verbatim: identical wire float confirms.
  const okConnection = makeConnection();
  const okRun = executeFanout({ selection: { mode: 'all' },
    connection: okConnection,
    message: builtParamSet({ fields: { param_value: 47.9 } }),
    mode: 'sequential',
    delivery: 'confirm',
    timeoutMs: 60000,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  deliver({ sysid: 5, compid: 1, name: 'PARAM_VALUE', fields: { param_id: 'FOO', param_value: Math.fround(47.9), param_type: 9 } });
  const ok = await okRun;
  assert.equal(ok.success, true);
  assert.equal(ok.members[0].confirmedBy, 'echo');

  // The vehicle clamped it: the echo mismatches and the member is unconfirmed.
  const clampedConnection = makeConnection();
  const clampedRun = executeFanout({ selection: { mode: 'all' },
    connection: clampedConnection,
    message: builtParamSet({ fields: { param_value: 47.9 } }),
    mode: 'sequential',
    delivery: 'confirm',
    timeoutMs: 50,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  deliver({ sysid: 5, compid: 1, name: 'PARAM_VALUE', fields: { param_id: 'FOO', param_value: 40, param_type: 9 } });
  const clamped = await clampedRun;
  assert.equal(clamped.success, false);
  assert.equal(clamped.members[0].result, 'unconfirmed');
});

test('confirm-mode retry resends the member\'s patched message with the confirmation counter', async (t) => {
  installRetryTimerHarness(t);
  const subs = [];
  const connection = {
    peerTable: peerTableStub([peer(7)]),
    sends: [],
    send(message, sendOptions) { this.sends.push({ message, options: sendOptions }); },
    resolveSourceIds: () => null,
    subscribe(filter, handler) {
      subs.push(handler);
      return () => {};
    },
  };
  const deliver = (decoded) => subs.slice().forEach((h) => h(decoded));

  const run = executeFanout({ selection: { mode: 'all' },
    connection,
    message: builtCommand({ fields: { command: 192, param7: 30 } }),
    targets: [{ sysid: 7, param5: 47.7, param6: 8.7 }],
    mode: 'sequential',
    delivery: 'confirm',
    intervalMs: 0,
    maxRetries: 1,
  });

  await Promise.resolve();
  assert.equal(connection.sends.length, 1, 'first transmission is out');
  // TEMPORARILY_REJECTED backs off (harness fires the 1 s retry timer) and
  // resends the same member message with the counter bumped.
  deliver({ sysid: 7, compid: 1, fields: { command: 192, result: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.sends.length, 2, 'retry was resent');
  deliver({ sysid: 7, compid: 1, fields: { command: 192, result: 0 } });
  const result = await run;

  assert.equal(result.success, true);
  assert.deepEqual(
    connection.sends.map((s) => s.message.fields.confirmation),
    [0, 1],
    'the resend is a confirmation transmission'
  );
  for (const { message } of connection.sends) {
    assert.equal(message.fields.param5, 47.7, 'retry carries the member\'s own patch');
    assert.equal(message.fields.param6, 8.7);
    assert.equal(message.fields.param7, 30);
  }
});

// ── Cancellation (#54/#57, CodeRabbit #140) ───────────────────────────────────

test('cancelling a sequential run stops it between members (#54/#57)', async () => {
  // Node-RED's close does not abort a running promise chain. Without a cancel
  // the member loop keeps walking its list — arming real vehicles from a node
  // that no longer exists — for up to members × (timeout + interval).
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const controller = new AbortController();

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    signal: controller.signal,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 25,
    // Cancel during the first inter-member pause, which is what a redeploy
    // landing mid-fan-out looks like.
    wait: async () => { controller.abort(); },
  });

  assert.deepEqual(
    connection.sends.map((s) => s.message.fields.target_system),
    [1],
    'members after the cancellation never receive a command'
  );
  // A cancelled run is not a failed one: the node reports it quietly, so a
  // redeploy cannot trip a Catch node wired for "fan-out failed → failsafe".
  assert.equal(result.result, 'cancelled');
  assert.equal(result.success, false);
  assert.equal(result.continue, false);
  assert.match(result.detail, /cancelled after 1 of 3 members/);
});

test('an uncancelled run is untouched by the abort signal', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const controller = new AbortController();

  const result = await executeFanout({ selection: { mode: 'all' },
    connection,
    signal: controller.signal,
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  assert.equal(result.result, 'succeeded');
  assert.equal(result.success, true);
  assert.equal(connection.sends.length, 3, 'every member still gets its command');
});

test('cancel settles a param-echo wait instead of blocking on its timeout (CodeRabbit #140)', async () => {
  // confirmParamMember is a hand-rolled promise with its own timer, not an
  // AckWaiter, so the abort listener on the waiter never sees it.
  let unsubscribed = 0;
  const connection = {
    peerTable: peerTableStub([peer(1)]),
    sends: [],
    send(message, sendOptions) { this.sends.push({ message, options: sendOptions }); },
    // Never echoes: only the cancel can end this wait.
    resolveSourceIds: () => null,
    subscribe() { return () => { unsubscribed += 1; }; },
  };
  const controller = new AbortController();

  const started = Date.now();
  const run = executeFanout({ selection: { mode: 'all' },
    connection,
    signal: controller.signal,
    message: builtParamSet(),
    mode: 'sequential',
    delivery: 'confirm',
    timeoutMs: 60000,
    intervalMs: 0,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const result = await run;

  assert.ok(Date.now() - started < 5000, 'settled on cancel, not after the 60 s echo timeout');
  assert.equal(result.result, 'cancelled');
  assert.equal(unsubscribed, 1, 'the PARAM_VALUE subscription is released');
});

test('cancel settles a broadcast confirm instead of blocking on its timeout (CodeRabbit #140)', async () => {
  // Same shape for confirmBroadcast, which waits on every member's COMMAND_ACK.
  let unsubscribed = 0;
  const connection = {
    peerTable: peerTableStub([peer(1), peer(2)]),
    sends: [],
    send(message, sendOptions) { this.sends.push({ message, options: sendOptions }); },
    resolveSourceIds: () => null,
    subscribe() { return () => { unsubscribed += 1; }; },
  };
  const controller = new AbortController();

  const started = Date.now();
  const run = executeFanout({ selection: { mode: 'all' },
    connection,
    signal: controller.signal,
    message: builtCommand(),
    mode: 'broadcast',
    delivery: 'confirm',
    timeoutMs: 60000,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const result = await run;

  assert.ok(Date.now() - started < 5000, 'settled on cancel, not after the 60 s ack timeout');
  assert.equal(result.result, 'cancelled');
  assert.equal(unsubscribed, 1, 'the COMMAND_ACK subscription is released');
});

// Fires only the AckWaiter's 1 s retry back-off (on a microtask); every other
// timer — the ack timeout — never fires, same shape as the command node's
// retry harness.
function installRetryTimerHarness(t) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const active = new Set();

  globalThis.setTimeout = (fn, delayMs) => {
    const handle = {};
    active.add(handle);
    if (delayMs === 1000) {
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

function builtParamSet(overrides = {}) {
  return {
    name: 'PARAM_SET',
    fields: {
      target_system: 0,
      target_component: 0,
      param_id: 'FOO',
      param_value: 7,
      param_type: 9,
      ...(overrides.fields || {}),
    },
  };
}

function builtSetpoint(overrides = {}) {
  return {
    name: overrides.name || 'SET_POSITION_TARGET_LOCAL_NED',
    fields: {
      time_boot_ms: 0,
      target_system: 0,
      target_component: 0,
      coordinate_frame: 1,
      // Velocity-only: all three position bits (1+2+4) ignored.
      type_mask: 3527,
      x: 0, y: 0, z: 0, vx: 1, vy: 0, vz: 0, afx: 0, afy: 0, afz: 0,
      yaw: 0, yaw_rate: 0,
      ...(overrides.fields || {}),
    },
  };
}

function peer(sysid, fields = {}) {
  return {
    sysid,
    components: [
      {
        compid: 1,
        state: fields.state || 'active',
        type: fields.type === undefined ? 2 : fields.type,
        firmware: fields.firmware || 'ardupilot',
        armed: fields.armed === undefined ? false : fields.armed,
        autopilot: fields.autopilot === undefined ? 3 : fields.autopilot,
        flightMode: fields.flightMode === undefined ? 0 : fields.flightMode,
      },
    ],
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
  const peerTable = peerTableStub(rows);
  return {
    id: options.id,
    peerTable,
    sends: [],
    send(message, sendOptions) {
      if (options.failSysids && options.failSysids.has(message.fields.target_system)) {
        throw new Error(`send failed for ${message.fields.target_system}`);
      }
      this.sends.push({ message, options: sendOptions });
      if (options.afterSend) options.afterSend(message);
    },
    resolveSourceIds: () => null,
    subscribe() {
      return () => {};
    },
  };
}
