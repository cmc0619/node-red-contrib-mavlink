'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeFanout,
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

test('sequential execution paces targeted sends between members', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const waits = [];

  const result = await executeFanout({
    connection,
    action: commandAction(),
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 25,
    wait: async (ms) => waits.push(ms),
  });

  assert.equal(result.success, true);
  assert.deepEqual(waits, [25, 25]);
  assert.deepEqual(connection.sends.map((s) => s.message.fields.target_system), [1, 2, 3]);
});

test('broadcast sends one autopilot-pinned packet with target_system zero', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({
    connection,
    action: commandAction(),
    mode: 'broadcast',
    delivery: 'send',
  });

  assert.equal(result.success, true);
  assert.equal(connection.sends.length, 1);
  assert.equal(connection.sends[0].message.fields.target_system, 0);
  assert.equal(connection.sends[0].message.fields.target_component, 1);
});

test('aggregation continues only when every selected member succeeds', async () => {
  const allOk = await executeFanout({
    connection: connectionStub([peer(1), peer(2)]),
    action: commandAction(),
    mode: 'sequential',
    delivery: 'send',
  });

  const partial = await executeFanout({
    connection: connectionStub([peer(1), peer(2)], { failSysids: new Set([2]) }),
    action: commandAction(),
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(allOk.success, true);
  assert.equal(allOk.continue, true);
  assert.equal(partial.success, false);
  assert.equal(partial.continue, false);
  assert.equal(partial.members.find((m) => m.sysid === 2).result, 'failed');
});

test('dry run expands members and builds messages without sending', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({
    connection,
    action: commandAction(),
    mode: 'sequential',
    delivery: 'send',
    dryRun: true,
  });

  assert.equal(result.result, 'dry_run');
  assert.equal(result.success, true);
  assert.equal(connection.sends.length, 0);
  assert.deepEqual(result.members.map((m) => m.message.fields.target_system), [1, 2]);
});

test('mission actions and param request-list are refused', async () => {
  const connection = connectionStub([peer(1)]);

  const mission = await executeFanout({
    connection,
    action: { type: 'mission', action: 'upload' },
    delivery: 'send',
  });
  const paramList = await executeFanout({
    connection,
    action: { type: 'param', action: 'request-list' },
    delivery: 'send',
  });

  assert.equal(mission.result, 'refused');
  assert.match(mission.detail, /Mission/);
  assert.equal(paramList.result, 'refused');
  assert.match(paramList.detail, /request-list/);
});

test('param set is sequential-only and rejects broadcast config', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({
    connection,
    action: {
      type: 'param',
      action: 'set',
      paramId: 'FOO',
      value: 7,
      paramType: 'MAV_PARAM_TYPE_REAL32',
    },
    mode: 'broadcast',
    delivery: 'send',
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /sequential/);
  assert.equal(connection.sends.length, 0);
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
    action: commandAction(),
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

test('broadcast aggregate warns about mixed firmware for uniform commands', async () => {
  const connection = connectionStub([
    peer(1, { firmware: 'ardupilot', flightMode: 4 }),
    peer(2, { firmware: 'px4', flightMode: 4 }),
  ]);

  const result = await executeFanout({
    connection,
    action: commandAction({ params: { 1: 1 } }),
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
    action: commandAction(),
    mode: 'broadcast',
    delivery: 'send',
    selection: { mode: 'list', sysids: '1' },
  });
  const filter = await executeFanout({
    connection,
    action: commandAction(),
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
    action: commandAction(),
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
    action: commandAction(),
    mode: 'broadcast',
    delivery: 'send',
    selection: { mode: 'all' },
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /stale|expired/);
  assert.equal(connection.sends.length, 0);
});

test('command without preset or numeric commandId is refused', async () => {
  const connection = connectionStub([peer(1)]);
  const result = await executeFanout({
    connection,
    action: { type: 'command', carrier: 'long', params: { 1: 1 } },
    mode: 'sequential',
    delivery: 'send',
  });
  assert.equal(result.result, 'refused');
  assert.match(result.detail, /commandId|preset/);
});

test('global move with blank lat/lon is refused (must not become 0,0)', async () => {
  const connection = connectionStub([peer(1)]);
  const result = await executeFanout({
    connection,
    action: {
      type: 'move',
      mode: 'global-position',
      position: { lat: '', lon: '', alt: 10 },
    },
    mode: 'sequential',
    delivery: 'send',
  });
  assert.equal(result.result, 'refused');
  assert.match(result.detail, /lat|lon|0,0/);
});

test('a safety preset (Flight Termination) is refused without confirmation and runs with it (§10)', async () => {
  const action = { type: 'command', carrier: 'long', preset: 'flight_termination', params: { 1: 1 } };

  const refused = await executeFanout({
    connection: connectionStub([peer(1)]),
    action,
    mode: 'sequential',
    delivery: 'send',
  });
  assert.equal(refused.result, 'refused');
  assert.match(refused.detail, /confirm/i);

  const confirmedConnection = connectionStub([peer(1)]);
  const confirmed = await executeFanout({
    connection: confirmedConnection,
    action,
    mode: 'sequential',
    delivery: 'send',
    confirmed: true,
  });
  assert.equal(confirmed.success, true);
  assert.equal(confirmedConnection.sends[0].message.fields.command, 185);
});

test('a raw DO_FLIGHTTERMINATION command id is gated the same as the preset (§10)', async () => {
  const refused = await executeFanout({
    connection: connectionStub([peer(1)]),
    action: { type: 'command', carrier: 'long', commandId: 185, params: { 1: 1 } },
    mode: 'broadcast',
    delivery: 'send',
  });
  assert.equal(refused.result, 'refused');
  assert.match(refused.detail, /confirm/i);
});

test('a preset resolves its own command id, ignoring a leftover default (§9/§10)', async () => {
  const connection = connectionStub([peer(1)]);

  const result = await executeFanout({
    connection,
    // Editor left commandId at its 400 default while a preset was selected.
    action: { type: 'command', carrier: 'long', preset: 'takeoff', commandId: 400, params: {} },
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(result.success, true);
  assert.equal(connection.sends[0].message.fields.command, 22, 'MAV_CMD_NAV_TAKEOFF, not the 400 default');
});

test('advanced command params preserve NaN instead of coercing it to 0 (§9)', async () => {
  const connection = connectionStub([peer(1)]);

  const result = await executeFanout({
    connection,
    action: { type: 'command', carrier: 'long', commandId: 115, params: { 1: 90, 4: NaN } },
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(result.success, true);
  const fields = connection.sends[0].message.fields;
  assert.equal(fields.param1, 90);
  assert.ok(Number.isNaN(fields.param4), 'a NaN "keep current" param survives to the wire');
});

test('command action with carrier int builds COMMAND_INT with degE7 coords and frame (§9)', async () => {
  const connection = connectionStub([peer(1)]);

  const result = await executeFanout({
    connection,
    // DO_REPOSITION with whole-degree lat/lon — canonical degrees, scaled by
    // the shared INT builder, not passed through.
    action: { type: 'command', carrier: 'int', frame: 3, commandId: 192, params: { 5: -35, 6: 149, 7: 50 } },
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(result.success, true);
  const message = connection.sends[0].message;
  assert.equal(message.name, 'COMMAND_INT');
  assert.equal(message.fields.frame, 3);
  assert.equal(message.fields.x, -350000000);
  assert.equal(message.fields.y, 1490000000);
  assert.equal(message.fields.z, 50);
  assert.equal('confirmation' in message.fields, false, 'COMMAND_INT has no confirmation byte');
});

test('command action without a carrier is refused — no default wire form (§9)', async () => {
  const connection = connectionStub([peer(1)]);

  const result = await executeFanout({
    connection,
    action: { type: 'command', commandId: 400, params: {} },
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(result.success, false);
  assert.match(result.detail || result.result, /carrier/);
  assert.equal(connection.sends.length, 0, 'nothing is sent without a carrier choice');
});

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
    action: commandAction({ params: { 1: 1 } }),
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

function commandAction(overrides = {}) {
  return { type: 'command', carrier: 'long', commandId: 400, params: {}, ...overrides };
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

// ── Ask-the-XML kinds and the NaN refusal through the fan-out path (§9) ────────

const { loadBundled } = require('../../lib/metadata');

test('fanout INT command asks the XML: gimbal flags stay raw on the wire', async () => {
  const connection = connectionStub([peer(1)]);

  // The bundle arrives as an explicit option — the fanout node resolves it
  // from the Vehicle Profile (the connection snapshot carries none, Codex #61).
  const result = await executeFanout({
    connection,
    vehicleBundle: loadBundled('common'),
    action: { type: 'command', carrier: 'int', commandId: 1000, params: { 1: -15, 2: 90, 5: 8 } },
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(result.success, true);
  const message = connection.sends[0].message;
  assert.equal(message.name, 'COMMAND_INT');
  assert.equal(message.fields.x, 8, 'gimbal manager flags must not be ×1e7-scaled');
});

test('fanout INT command with NaN lat/lon fails loud — nothing sent', async () => {
  const connection = connectionStub([peer(1)]);

  // NaN means "leave unchanged" on the LONG carrier; on INT it must refuse,
  // not silently become 0,0 (§9/§10 "blank coordinates must not become 0,0").
  await assert.rejects(
    executeFanout({
      connection,
      vehicleBundle: loadBundled('common'),
      action: { type: 'command', carrier: 'int', commandId: 192, params: { 5: NaN, 6: 149, 7: 50 } },
      mode: 'sequential',
      delivery: 'send',
    }),
    /must be finite/
  );
  assert.equal(connection.sends.length, 0, 'the null-island command must never be sent');
});

test('message-kind payload actions need no carrier; command-backed ones still do (§9)', async () => {
  // Gimbal manager aiming is a plain message — the carrier is meaningless and
  // must not be demanded (Codex #61).
  const managerAim = await executeFanout({
    connection: connectionStub([peer(1)]),
    action: { type: 'payload', topic: 'gimbal', verb: 'aim', path: 'manager', values: { pitch: -10, yaw: 45 } },
    mode: 'sequential',
    delivery: 'send',
  });
  assert.equal(managerAim.success, true);

  // A command-backed verb without a carrier is still refused with nothing sent.
  const conn2 = connectionStub([peer(1)]);
  const photo = await executeFanout({
    connection: conn2,
    action: { type: 'payload', topic: 'camera', verb: 'photo', path: 'legacy', values: {} },
    mode: 'sequential',
    delivery: 'send',
  });
  assert.equal(photo.result, 'refused');
  assert.match(photo.detail, /carrier/);
  assert.equal(conn2.sends.length, 0);
});

test('cancelling a sequential run stops it between members (#54/#57)', async () => {
  // Node-RED's close does not abort a running promise chain. Without a cancel
  // the member loop keeps walking its list — arming real vehicles from a node
  // that no longer exists — for up to members × (timeout + interval).
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const controller = new AbortController();

  const result = await executeFanout({
    connection,
    signal: controller.signal,
    action: commandAction(),
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
    action: commandAction(),
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
  // AckWaiter, so the abort listener on the waiter never sees it. Without its own
  // blocks until the echo arrives or the timeout fires.
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
    action: { type: 'param', action: 'set', paramId: 'FOO', value: 7, paramType: 'MAV_PARAM_TYPE_REAL32' },
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
    action: commandAction(),
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

test('fan-out refuses a preset with blank coordinates rather than sending the fleet to 0,0 (#141)', async () => {
  // Fan-out builds preset params itself, so the command node's guard never runs
  // here. Without its own check a fleet-wide Go To with an empty latitude sent
  // every vehicle to the Gulf of Guinea.
  const connection = connectionStub([peer(1), peer(2)]);

  const refused = await executeFanout({
    connection,
    action: { type: 'command', carrier: 'long', preset: 'reposition', params: { 6: 8.5 } },
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(refused.result, 'refused');
  assert.match(refused.detail, /requires latitude and longitude/);
  assert.equal(connection.sends.length, 0, 'nothing reaches the wire');

  // With coordinates it goes out to every member as usual.
  const ok = await executeFanout({
    connection,
    action: { type: 'command', carrier: 'long', preset: 'reposition', params: { 5: 47.4, 6: 8.5 } },
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });
  assert.equal(ok.success, true);
  assert.equal(connection.sends.length, 2);
});

test('fan-out refuses a whitespace coordinate, not just an absent one (#141)', async () => {
  // Fan-out passes action.params straight to the guard — it never goes through
  // mergeParams — so the whitespace rule has to live in isPresentCoordinate
  // too. Number('  ') is 0, which would have reached the whole fleet.
  const connection = connectionStub([peer(1), peer(2)]);

  for (const blank of ['', ' ', '\t']) {
    const refused = await executeFanout({
      connection,
      action: { type: 'command', carrier: 'long', preset: 'reposition', params: { 5: blank, 6: 8.5 } },
      mode: 'sequential',
      delivery: 'send',
    });
    assert.equal(refused.result, 'refused', `${JSON.stringify(blank)} must refuse`);
    assert.match(refused.detail, /requires latitude and longitude/);
  }
  assert.equal(connection.sends.length, 0, 'nothing reaches the fleet');
});

// ── Per-member param overrides (memberParams) ─────────────────────────────────

test('memberParams gives each member its own canonical lat/lon on the INT carrier', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({
    connection,
    // Canonical decimal degrees per member, scaled to degE7 by the shared INT
    // builder — the merge happens before the carrier, not at the wire fields.
    action: {
      type: 'command',
      carrier: 'int',
      frame: 3,
      commandId: 192,
      params: { 7: 50 },
      memberParams: { 1: { 5: -35.1, 6: 149.1 }, 2: { 5: -35.2, 6: 149.2 } },
    },
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  assert.equal(result.success, true);
  const bySysid = Object.fromEntries(
    connection.sends.map((s) => [s.message.fields.target_system, s.message.fields])
  );
  assert.equal(bySysid[1].x, -351000000);
  assert.equal(bySysid[1].y, 1491000000);
  assert.equal(bySysid[2].x, -352000000);
  assert.equal(bySysid[2].y, 1492000000);
  assert.equal(bySysid[1].z, 50, 'shared params still apply under an override');
  assert.equal(bySysid[2].z, 50);
});

test('memberParams merges over action.params on the LONG carrier; members without an entry fall back', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({
    connection,
    action: {
      type: 'command',
      carrier: 'long',
      preset: 'reposition',
      params: { 5: 47.4, 6: 8.5, 7: 30 },
      // JSON payloads arrive with string keys — the lookup must not care.
      memberParams: { '2': { '5': 47.5, '6': 8.6 } },
    },
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  assert.equal(result.success, true);
  const bySysid = Object.fromEntries(
    connection.sends.map((s) => [s.message.fields.target_system, s.message.fields])
  );
  assert.equal(bySysid[1].param5, 47.4, 'member without an entry uses action.params unchanged');
  assert.equal(bySysid[1].param6, 8.5);
  assert.equal(bySysid[2].param5, 47.5);
  assert.equal(bySysid[2].param6, 8.6);
  assert.equal(bySysid[2].param7, 30, 'unoverridden index falls through to action.params');
});

test('broadcast refuses memberParams — one packet carries one param set (§10)', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  const result = await executeFanout({
    connection,
    action: commandAction({ memberParams: { 1: { 5: -35 } } }),
    mode: 'broadcast',
    delivery: 'send',
    selection: { mode: 'all' },
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /one param set|uniform/);
  assert.equal(connection.sends.length, 0, 'nothing reaches the wire');
});

test('memberParams on a non-command action is refused', async () => {
  const connection = connectionStub([peer(1)]);

  const result = await executeFanout({
    connection,
    action: {
      type: 'move',
      mode: 'global-position',
      position: { lat: -35, lon: 149, alt: 10 },
      memberParams: { 1: { 5: -35 } },
    },
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /memberParams is only defined for Command actions/);
});

test('a malformed memberParams shape is refused before any send', async () => {
  const connection = connectionStub([peer(1), peer(2)]);

  // An array, a scalar, and a non-object member entry: each would make every
  // {} lookup return undefined, silently sending the shared params to every
  // vehicle instead of the per-member ones the caller meant to differentiate.
  for (const bad of [[], 'per-member', { 1: [5, -35] }]) {
    const result = await executeFanout({
      connection,
      action: commandAction({ memberParams: bad }),
      mode: 'sequential',
      delivery: 'send',
      selection: { mode: 'all' },
    });

    assert.equal(result.result, 'refused', `${JSON.stringify(bad)} must refuse`);
    assert.match(result.detail, /memberParams must be an object keyed by sysid/);
  }
  assert.equal(connection.sends.length, 0, 'nothing reaches the wire');
  assert.equal(connection.sends.length, 0);
});

test('a member whose merged params still lack lat/lon refuses the whole run before any send', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)]);

  const result = await executeFanout({
    connection,
    // Members 2 and 3 have no override and no shared lat/lon — sending would
    // scatter member 1 to its slot and the rest to 0,0.
    action: {
      type: 'command',
      carrier: 'long',
      preset: 'reposition',
      params: { 7: 30 },
      memberParams: { 1: { 5: 47.4, 6: 8.5 } },
    },
    mode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  assert.equal(result.result, 'refused');
  assert.match(result.detail, /requires latitude and longitude/);
  assert.match(result.detail, /2, 3/, 'the aggregate names the offending sysids');
  assert.equal(connection.sends.length, 0, 'a partial null-island run never starts');
});

test('confirm-mode retry resends the member\'s own params, not the shared set', async (t) => {
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
    action: {
      type: 'command',
      carrier: 'long',
      commandId: 192,
      params: { 5: 47.4, 6: 8.5, 7: 30 },
      memberParams: { 7: { 5: 47.7, 6: 8.7 } },
    },
    mode: 'sequential',
    delivery: 'confirm',
    intervalMs: 0,
    maxRetries: 1,
  });

  await Promise.resolve();
  assert.equal(connection.sends.length, 1, 'first transmission is out');
  // TEMPORARILY_REJECTED backs off (harness fires the 1 s retry timer) and
  // resends through the same buildWrappedMessage path.
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
    assert.equal(message.fields.param5, 47.7, 'retry carries the member\'s own latitude');
    assert.equal(message.fields.param6, 8.7);
    assert.equal(message.fields.param7, 30);
  }
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

test('fan-out move refuses a whitespace coordinate too (#141 duplicate-helper bug)', async () => {
  // isPresentCoordinate existed twice — fan-out kept its own copy, so fixing
  // the whitespace hole in the command module left the move global-position
  // guard still sending 0,0. There is one copy now.
  const connection = connectionStub([peer(1), peer(2)]);

  for (const blank of ['', ' ', '\t']) {
    const refused = await executeFanout({
      connection,
      action: { type: 'move', mode: 'global-position', position: { lat: blank, lon: 8.5, alt: 30 } },
      mode: 'sequential',
      delivery: 'send',
    });
    assert.equal(refused.result, 'refused', `${JSON.stringify(blank)} must refuse`);
    assert.match(refused.detail, /requires lat and lon/);
  }
  assert.equal(connection.sends.length, 0);
});
