'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const delivery = require('../../lib/delivery');
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

test('suppress does nothing and status records are refused', () => {
  assert.deepEqual(guardSwarmInput({ payload: false }), { action: 'suppress' });

  const status = delivery.makeStatusRecord({ result: 'failed' });
  const refusal = guardSwarmInput(status);

  assert.equal(refusal.action, 'refuse');
  assert.equal(refusal.record.result, 'refused');
  assert.equal(delivery.isStatusRecord(refusal.record), true);
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

function commandAction(overrides = {}) {
  return { type: 'command', commandId: 400, params: {}, ...overrides };
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
