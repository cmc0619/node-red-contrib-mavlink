'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeFanout,
  classifyMessage,
  guardFanoutInput,
  selectFanoutMembers,
} = require('../../lib/fanout');

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

test('a payload that is not a built message is refused with a pointer at Build tiers', async () => {
  const connection = connectionStub([peer(1)]);
  for (const bad of [null, 42, 'arm', {}, { name: 'COMMAND_LONG' }, { fields: {} }]) {
    const result = await executeFanout({ connection, message: bad, delivery: 'send' });
    assert.equal(result.result, 'refused', `${JSON.stringify(bad)} must refuse`);
    assert.match(result.detail, /Build-tier|mavlink-build/);
  }
  assert.equal(connection.sends.length, 0);
});

test('mission messages and PARAM_REQUEST_LIST are refused — not single-message actions (§10)', async () => {
  const connection = connectionStub([peer(1)]);

  const mission = await executeFanout({
    connection,
    message: { name: 'MISSION_COUNT', fields: { target_system: 1, target_component: 1, count: 4 } },
    delivery: 'send',
  });
  const paramList = await executeFanout({
    connection,
    message: { name: 'PARAM_REQUEST_LIST', fields: { target_system: 1, target_component: 1 } },
    delivery: 'send',
  });

  assert.equal(mission.result, 'refused');
  assert.match(mission.detail, /Mission/);
  assert.equal(paramList.result, 'refused');
  assert.match(paramList.detail, /bulk transfer/);
});

test('a message with no target_system field cannot be retargeted and is refused', async () => {
  const connection = connectionStub([peer(1)]);
  const result = await executeFanout({
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

  const result = await executeFanout({
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

  const result = await executeFanout({
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

  const result = await executeFanout({
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
  await executeFanout({ connection, message: builtSetpoint(), delivery: 'send' });
  await executeFanout({ connection, message: builtCommand(), delivery: 'send' });
  const [setpoint, command] = connection.sends;
  assert.notEqual(setpoint.options.band, command.options.band);
});

test('aggregation continues only when every selected member succeeds', async () => {
  const allOk = await executeFanout({
    connection: connectionStub([peer(1), peer(2)]),
    message: builtCommand(),
    mode: 'sequential',
    delivery: 'send',
  });

  const partial = await executeFanout({
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

  const result = await executeFanout({
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

  const result = await executeFanout({
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
  assert.deepEqual(guardFanoutInput({ payload: false }), { action: 'suppress' });
});

// ── Broadcast guards (§10) ────────────────────────────────────────────────────

test('broadcast aggregate warns about mixed firmware for uniform commands', async () => {
  const connection = connectionStub([
    peer(1, { firmware: 'ardupilot', flightMode: 4 }),
    peer(2, { firmware: 'px4', flightMode: 4 }),
  ]);

  const result = await executeFanout({
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

  const result = await executeFanout({
    connection,
    message: builtParamSet(),
    mode: 'broadcast',
    delivery: 'send',
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /sequential/);
  assert.equal(connection.sends.length, 0);
});

// ── Safety gate (§10) ─────────────────────────────────────────────────────────

test('DO_FLIGHTTERMINATION is refused without confirmation and runs with it (§10)', async () => {
  const message = builtCommand({ fields: { command: 185, param1: 1 } });

  const refused = await executeFanout({
    connection: connectionStub([peer(1)]),
    message,
    mode: 'sequential',
    delivery: 'send',
  });
  assert.equal(refused.result, 'refused');
  assert.match(refused.detail, /confirm/i);

  const confirmedConnection = connectionStub([peer(1)]);
  const confirmed = await executeFanout({
    connection: confirmedConnection,
    message,
    mode: 'sequential',
    delivery: 'send',
    confirmed: true,
  });
  assert.equal(confirmed.success, true);
  assert.equal(confirmedConnection.sends[0].message.fields.command, 185);
});

test('the safety gate covers COMMAND_INT and broadcast too (§10)', async () => {
  const refused = await executeFanout({
    connection: connectionStub([peer(1)]),
    message: builtCommand({ name: 'COMMAND_INT', fields: { command: 185, param1: 1 } }),
    mode: 'broadcast',
    delivery: 'send',
  });
  assert.equal(refused.result, 'refused');
  assert.match(refused.detail, /confirm/i);
});

// ── Per-target overrides (targets) ────────────────────────────────────────────

test('targets selects the listed sysids and patches wire fields per member', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)]);

  const result = await executeFanout({
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

  const result = await executeFanout({
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

  await executeFanout({
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

  const result = await executeFanout({
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

test('a malformed targets shape is refused before any send', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  // A non-array, a broadcast sysid, an out-of-range sysid, and an entry with
  // no sysid at all: each would silently select or patch the wrong vehicles.
  for (const bad of ['1,2', [0], [256], [{ param5: -35 }]]) {
    const result = await executeFanout({
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

// ── Confirmation ──────────────────────────────────────────────────────────────

test('broadcast confirm matches COMMAND_ACK on sysid AND component (§10)', async () => {
  const handlers = [];
  const connection = {
    peerTable: peerTableStub([peer(1)]),
    sends: [],
    send(message, options) {
      this.sends.push({ message, options });
    },
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

test('PARAM_SET echo confirm compares wire values — a clamped value does not confirm', async () => {
  const handlers = [];
  const makeConnection = () => ({
    peerTable: peerTableStub([peer(5)]),
    sends: [],
    send(message, options) { this.sends.push({ message, options }); },
    subscribe(filter, handler) {
      handlers.push(handler);
      return () => {};
    },
  });
  const deliver = (decoded) => handlers.splice(0).forEach((h) => h(decoded));

  // The vehicle applies the set verbatim: identical wire float confirms.
  const okConnection = makeConnection();
  const okRun = executeFanout({
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
  const clampedRun = executeFanout({
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
    subscribe(filter, handler) {
      subs.push(handler);
      return () => {};
    },
  };
  const deliver = (decoded) => subs.slice().forEach((h) => h(decoded));

  const run = executeFanout({
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

  const result = await executeFanout({
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

  const result = await executeFanout({
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
    subscribe() { return () => { unsubscribed += 1; }; },
  };
  const controller = new AbortController();

  const started = Date.now();
  const run = executeFanout({
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
    subscribe() { return () => { unsubscribed += 1; }; },
  };
  const controller = new AbortController();

  const started = Date.now();
  const run = executeFanout({
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

function builtSetpoint() {
  return {
    name: 'SET_POSITION_TARGET_LOCAL_NED',
    fields: {
      time_boot_ms: 0,
      target_system: 0,
      target_component: 0,
      coordinate_frame: 1,
      type_mask: 3527,
      x: 0, y: 0, z: 0, vx: 1, vy: 0, vz: 0, afx: 0, afy: 0, afz: 0,
      yaw: 0, yaw_rate: 0,
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
    peerTable,
    sends: [],
    send(message, sendOptions) {
      if (options.failSysids && options.failSysids.has(message.fields.target_system)) {
        throw new Error(`send failed for ${message.fields.target_system}`);
      }
      this.sends.push({ message, options: sendOptions });
      if (options.afterSend) options.afterSend(message);
    },
    subscribe() {
      return () => {};
    },
  };
}
