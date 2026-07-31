'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeSwarm,
  guardSwarmInput,
  selectSwarmMembers,
} = require('../../lib/swarm');

test('selection resolves all, explicit list, and filters while excluding stale peers', () => {
  const peerTable = peerTableStub([
    peer(1, { type: 2, firmware: 'ardupilot', armed: true }),
    peer(2, { type: 3, firmware: 'px4', armed: false }),
    peer(3, { type: 2, firmware: 'ardupilot', armed: true, state: 'stale' }),
    { sysid: 4, components: [{ compid: 154, state: 'active', type: 26 }] },
  ]);

  assert.deepEqual(selectSwarmMembers(peerTable, { mode: 'all' }).map((m) => m.sysid), [1, 2]);
  assert.deepEqual(selectSwarmMembers(peerTable, { mode: 'list', sysids: '2, 3' }).map((m) => m.sysid), [2]);
  assert.deepEqual(
    selectSwarmMembers(peerTable, {
      mode: 'filter',
      filter: { type: 2, firmware: 'ardupilot', armed: true },
    }).map((m) => m.sysid),
    [1]
  );
});

test('sequential execution paces targeted sends between members', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const waits = [];

  const result = await executeSwarm({
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

  const result = await executeSwarm({
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
  const allOk = await executeSwarm({
    connection: connectionStub([peer(1), peer(2)]),
    action: commandAction(),
    mode: 'sequential',
    delivery: 'send',
  });

  const partial = await executeSwarm({
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

  const result = await executeSwarm({
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

  const mission = await executeSwarm({
    connection,
    action: { type: 'mission', action: 'upload' },
    delivery: 'send',
  });
  const paramList = await executeSwarm({
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

  const result = await executeSwarm({
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

  const result = await executeSwarm({
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
  assert.deepEqual(guardSwarmInput({ payload: false }), { action: 'suppress' });
});

test('broadcast aggregate warns about mixed firmware for uniform commands', async () => {
  const connection = connectionStub([
    peer(1, { firmware: 'ardupilot', flightMode: 4 }),
    peer(2, { firmware: 'px4', flightMode: 4 }),
  ]);

  const result = await executeSwarm({
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

  const list = await executeSwarm({
    connection,
    action: commandAction(),
    mode: 'broadcast',
    delivery: 'send',
    selection: { mode: 'list', sysids: '1' },
  });
  const filter = await executeSwarm({
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

  const result = await executeSwarm({
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

  const result = await executeSwarm({
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
  const result = await executeSwarm({
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
  const result = await executeSwarm({
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

  const refused = await executeSwarm({
    connection: connectionStub([peer(1)]),
    action,
    mode: 'sequential',
    delivery: 'send',
  });
  assert.equal(refused.result, 'refused');
  assert.match(refused.detail, /confirm/i);

  const confirmedConnection = connectionStub([peer(1)]);
  const confirmed = await executeSwarm({
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
  const refused = await executeSwarm({
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

  const result = await executeSwarm({
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

  const result = await executeSwarm({
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

  const result = await executeSwarm({
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

  const result = await executeSwarm({
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

  const promise = executeSwarm({
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

// ── Ask-the-XML kinds and the NaN refusal through the swarm path (§9) ────────

const { loadBundled } = require('../../lib/metadata');

test('swarm INT command asks the XML: gimbal flags stay raw on the wire', async () => {
  const connection = connectionStub([peer(1)]);
  connection.vehicle = { bundle: loadBundled('common') };

  const result = await executeSwarm({
    connection,
    action: { type: 'command', carrier: 'int', commandId: 1000, params: { 1: -15, 2: 90, 5: 8 } },
    mode: 'sequential',
    delivery: 'send',
  });

  assert.equal(result.success, true);
  const message = connection.sends[0].message;
  assert.equal(message.name, 'COMMAND_INT');
  assert.equal(message.fields.x, 8, 'gimbal manager flags must not be ×1e7-scaled');
});

test('swarm INT command with NaN lat/lon fails loud — nothing sent', async () => {
  const connection = connectionStub([peer(1)]);
  connection.vehicle = { bundle: loadBundled('common') };

  // NaN means "leave unchanged" on the LONG carrier; on INT it must refuse,
  // not silently become 0,0 (§9/§10 "blank coordinates must not become 0,0").
  await assert.rejects(
    executeSwarm({
      connection,
      action: { type: 'command', carrier: 'int', commandId: 192, params: { 5: NaN, 6: 149, 7: 50 } },
      mode: 'sequential',
      delivery: 'send',
    }),
    /must be finite/
  );
  assert.equal(connection.sends.length, 0, 'the null-island command must never be sent');
});
