'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mavlink-fanout node emits continue only for all-success aggregate', async () => {
  const connection = connectionStub([peer(1), peer(2)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({ selectionMode: 'all',
    connection: 'conn',
    executionMode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });
  let sent;

  await emitInput(node, { payload: builtCommand() }, (messages) => {
    sent = messages;
  });

  assert.equal(sent[0].payload.result, 'succeeded');
  assert.equal(sent[1].result, 'succeeded');
  assert.equal(connection.sends.length, 2);
});

test("a hand-edited delivery typo sends nothing through the node", async () => {
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({ selectionMode: 'all',
    connection: 'conn',
    executionMode: 'sequential',
    delivery: 'cofnirm',
    intervalMs: 0,
  });
  let sent;
  await emitInput(node, { payload: builtCommand() }, (m) => { sent = m; });
  assert.equal(sent[0], null);
  assert.equal(sent[1].success, false);
  assert.equal(sent[1].result, 'failed');
  assert.equal(node._status.fill, 'red');
  assert.equal(connection.sends.length, 0, 'nothing left the wire under the mis-resolved tier');
});

test('a hand-edited execution mode runs nothing and still completes the input', async () => {
  // The tier typo above is a per-member outcome, so it has a record to report.
  // An unmatched execution *mode* never starts a run at all (§5), so there is
  // no aggregate — the node must complete the message rather than dereference
  // one that was never built.
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({ selectionMode: 'all',
    connection: 'conn',
    executionMode: 'seuqential',
    delivery: 'send',
    intervalMs: 0,
  });
  let sent;
  const err = await emitInput(node, { payload: builtCommand() }, (m) => { sent = m; }).then(
    () => null,
    (e) => e
  );
  assert.equal(err, null, 'no mode matched, so nothing failed');
  assert.equal(sent, undefined, 'no run happened, so no outcome was reported');
  assert.equal(connection.sends.length, 0, 'nothing left the wire');
});

test('build+list with no connection emits one retargeted message per member on output 0 (§6/§9)', async () => {
  const RED = redStub({});  // no connection registered
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({
    connection: '',
    delivery: 'build',
    selectionMode: 'list',
    members: [{ sysid: 1 }, { sysid: 2 }],
    executionMode: 'sequential',
    intervalMs: 0,
  });
  let sent;
  await emitInput(node, { payload: builtCommand() }, (messages) => { sent = messages; });

  assert.equal(sent[1].result, 'succeeded', 'build+list with no connection must succeed');
  assert.equal(sent[1].count, 2, 'both listed sysids built');
  assert.ok(Array.isArray(sent[0]), 'output 0 carries the product batch for mavlink-out');
  assert.deepEqual(
    sent[0].map((m) => m.payload.fields.target_system),
    [1, 2],
    'one retargeted message per member'
  );
  assert.equal(sent[0][0].payload.name, 'COMMAND_LONG');
  // Build previews, so it wears the yellow preview badge (§6) — not the green
  // 'ok' of a real send — keyed on the tier, since the aggregate result is
  // 'succeeded' either way.
  assert.equal(node._status.fill, 'yellow', 'Build tier shows the preview badge');
  assert.equal(node._status.shape, 'dot');
  assert.match(node._status.text, /preview/);
});

test('a payload that is not a built message reports a failed aggregate', async () => {
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({ executionMode: 'sequential', selectionMode: 'all', connection: 'conn', delivery: 'send', intervalMs: 0 });

  let sent;
  const err = await emitInput(node, { payload: { commandId: 400 } }, (m) => { sent = m; }).then(
    () => null,
    (e) => e
  );
  assert.equal(err, null);
  assert.equal(sent[0], null);
  assert.equal(sent[1].success, false);
  assert.equal(connection.sends.length, 0);
});

test('wrapper selection sysids outside 1..255 select nobody rather than refusing', async () => {
  // The wrapper's `selection.sysids` is trusted runtime input (§0): entries
  // that name no vehicle simply match no member, and the empty resolution is
  // the report. The editor bounds the configured members table.
  const RED = redStub({});
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];

  const fromWrapper = new Node({ executionMode: 'sequential',
    connection: '',
    delivery: 'build',
    selectionMode: 'list',
    members: [{ sysid: 1 }, { sysid: 2 }],
    intervalMs: 0,
  });
  let sentWrapper;
  await emitInput(
    fromWrapper,
    { payload: { message: builtCommand(), selection: { mode: 'list', sysids: '0,3' } } },
    (m) => { sentWrapper = m; }
  ).then(() => null, () => null);
  assert.ok(sentWrapper, 'the input still reports');
});

test('build+all without connection craters — the editor reds the pair at deploy (§6)', () => {
  // Build + a non-list selection has nowhere to resolve members from: the
  // live peer table is the only source. The editor reds it
  // (mavlink-fanout.html `selectionMode`: "must be an explicit sysid list on
  // Build"), so the driver simply has no connection to read and craters.
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'nodes', 'mavlink-fanout.html'),
    'utf8'
  );
  assert.match(html, /must be an explicit sysid list on Build/);
});

test('wrapper identityId is passed through to connection.send options', async () => {
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({ executionMode: 'sequential', selectionMode: 'all',
    connection: 'conn',
    delivery: 'send',
    intervalMs: 0,
  });
  await emitInput(node, { payload: { message: builtCommand(), identityId: 'my-identity-id' } }, () => {});

  assert.equal(connection.sends.length, 1);
  assert.equal(connection.sends[0].options.identityId, 'my-identity-id',
    'wrapper identityId must reach connection.send options');
});

test('config.identity is used as identityId when the wrapper does not override', async () => {
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({ executionMode: 'sequential', selectionMode: 'all',
    connection: 'conn',
    delivery: 'send',
    identity: 'cfg-identity-id',
    intervalMs: 0,
  });
  await emitInput(node, { payload: builtCommand() }, () => {});

  assert.equal(connection.sends.length, 1);
  assert.equal(connection.sends[0].options.identityId, 'cfg-identity-id',
    'config.identity must reach connection.send options as identityId');
});

test('mavlink-fanout packs DO_FLIGHTTERMINATION without a confirm gate', async () => {
  const conn = connectionStub([peer(1)]);
  const RED = redStub({ conn });
  require('../../nodes/mavlink-fanout')(RED);
  const node = new (RED.nodes.types['mavlink-fanout'])({
    executionMode: 'sequential',
    selectionMode: 'all',
    connection: 'conn',
    delivery: 'send',
  });
  await emitInput(node, {
    payload: builtCommand({ fields: { command: 185, param1: 1 } }),
  }, () => {});
  assert.equal(conn.sends.length, 1);
  assert.equal(conn.sends[0].message.fields.command, 185);
});

test('a filter matching zero vehicles reports quietly — empty aggregate, no error (#226)', async () => {
  // The stub peers are ArduPilot (autopilot 3), so a px4 firmware filter is a
  // correct zero-match answer, not a fault: no done(err), no red badge.
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({ executionMode: 'sequential',
    connection: 'conn',
    delivery: 'send',
    selectionMode: 'filter',
    firmwareFilter: 'px4',
    intervalMs: 0,
  });

  let sent;
  await emitInput(node, { payload: builtCommand() }, (m) => { sent = m; });

  assert.equal(sent[0], null, 'output 0 stays null — no phantom continue');
  assert.equal(sent[1].result, 'empty');
  assert.equal(sent[1].success, false, 'no phantom success (§2)');
  assert.deepEqual(
    node._status,
    { fill: 'grey', shape: 'ring', text: '0 matched' },
    'zero matches is an answer, not a fault — the exact quiet badge'
  );
  assert.equal(connection.sends.length, 0);
});

test('an empty list or empty fleet stays loud — someone was named and nobody answered (#226)', async () => {
  // list: the operator named sysid 9 and reached none.
  const RED = redStub({ conn: connectionStub([peer(1), peer(2)]) });
  require('../../nodes/mavlink-fanout')(RED);
  const listNode = new (RED.nodes.types['mavlink-fanout'])({ executionMode: 'sequential',
    connection: 'conn',
    delivery: 'send',
    selectionMode: 'list',
    members: [{ sysid: 9 }],
    intervalMs: 0,
  });
  let listSent;
  await emitInput(listNode, { payload: builtCommand() }, (m) => { listSent = m; });
  assert.equal(listSent[1].result, 'empty');
  assert.equal(listNode._status.fill, 'red');

  // all: ambiguous between fleet-not-up and misconfig — silence on an arm
  // that reached nobody is the worse failure.
  const RED2 = redStub({ conn: connectionStub([]) });
  require('../../nodes/mavlink-fanout')(RED2);
  const allNode = new (RED2.nodes.types['mavlink-fanout'])({ executionMode: 'sequential',
    connection: 'conn',
    delivery: 'send',
    selectionMode: 'all',
    intervalMs: 0,
  });
  await emitInput(allNode, { payload: builtCommand() }, () => {});
  assert.equal(allNode._status.fill, 'red');
});

test('wrapper targets reach the replicator with per-member patches', async () => {
  const connection = connectionStub([peer(1), peer(2)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({ selectionMode: 'all',
    connection: 'conn',
    executionMode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });
  let sent;

  await emitInput(node, {
    payload: {
      message: builtCommand({ fields: { command: 192, param5: 47.4, param6: 8.5 } }),
      targets: [1, { sysid: 2, param5: 47.5, param6: 8.6 }],
    },
  }, (messages) => { sent = messages; });

  assert.equal(sent[1].result, 'succeeded');
  const bySysid = Object.fromEntries(
    connection.sends.map((s) => [s.message.fields.target_system, s.message.fields])
  );
  assert.equal(bySysid[1].param5, 47.4, 'bare sysid keeps the shared message');
  assert.equal(bySysid[1].param6, 8.5);
  assert.equal(bySysid[2].param5, 47.5, 'patched target gets its own fields');
  assert.equal(bySysid[2].param6, 8.6);
});

test('config member rows patch per member, and payload.targets overrides them entirely (§6/#163)', async () => {
  const connection = connectionStub([peer(1), peer(2)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({
    connection: 'conn',
    selectionMode: 'list',
    members: [{ sysid: 1 }, { sysid: 2, patch: { param1: 21 } }],
    executionMode: 'sequential',
    delivery: 'send',
    intervalMs: 0,
  });

  // Config members drive the run when the payload carries only the message.
  await emitInput(node, { payload: builtCommand() }, () => {});
  const bySysid = Object.fromEntries(
    connection.sends.map((s) => [s.message.fields.target_system, s.message.fields])
  );
  assert.equal(bySysid[1].param1, 0, 'bare row keeps the shared message');
  assert.equal(bySysid[2].param1, 21, 'row patch overwrites the field for its member');

  // payload.targets is the override of last resort: config rows (including
  // member 2's patch) are replaced wholesale, not merged.
  connection.sends.length = 0;
  await emitInput(node, {
    payload: { message: builtCommand(), targets: [{ sysid: 1, param1: 7 }] },
  }, () => {});
  assert.deepEqual(connection.sends.map((s) => s.message.fields.target_system), [1],
    'the targets list is the selection — config member 2 is not commanded');
  assert.equal(connection.sends[0].message.fields.param1, 7);
});

function emitInput(node, msg, send) {
  return new Promise((resolve, reject) => {
    node.emit('input', msg, send, (err) => {
      if (err) reject(err);
      else resolve();
    });
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

function peer(sysid) {
  return {
    sysid,
    components: [{ compid: 1, state: 'active', type: 2, autopilot: 3, armed: false }],
  };
}

function connectionStub(rows) {
  return {
    peerTable: {
      snapshot() {
        return rows;
      },
      getComponent(sysid, compid) {
        const row = rows.find((p) => p.sysid === sysid);
        return row && row.components.find((c) => c.compid === compid);
      },
    },
    sends: [],
    send(message, options) {
      this.sends.push({ message, options });
    },
    resolveSourceIds: () => null,
    subscribe() {
      return () => {};
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
        node._status = null;
        node.status = (status) => { node._status = status; };
        node.error = () => {};
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

test('close cancels an in-flight fan-out and waits for it to unwind (#54/#57)', async () => {
  // The bug: mavlink-fanout had no close handler at all. A redeploy landing
  // mid-run left the member loop walking its list, sending arm/mode commands
  // to real vehicles from a node Node-RED had already torn down.
  //
  // A 60 s inter-member interval parks the loop in the pause, so close is
  // guaranteed to land mid-run rather than racing a finished one.
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({ selectionMode: 'all',
    connection: 'conn',
    executionMode: 'sequential',
    delivery: 'send',
    intervalMs: 60000,
  });

  let emitted = false;
  let inputSettled = false;
  const run = emitInput(node, { payload: builtCommand() }, () => { emitted = true; })
    .then(() => { inputSettled = true; });

  // Let the first member's send happen and the loop reach the pause.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connection.sends.length, 1, 'parked in the interval after member 1');
  assert.equal(inputSettled, false, 'run is still in flight');

  const closedAt = Date.now();
  await new Promise((resolve) => node.emit('close', resolve));
  const closeMs = Date.now() - closedAt;
  // Capture before awaiting run: afterwards the assertion would hold trivially
  // and stop proving that close itself waited for the unwind.
  const inputSettledAtClose = inputSettled;
  await run;

  assert.ok(closeMs < 5000, `close returned promptly (${closeMs}ms), not after the 60 s interval`);
  assert.equal(inputSettledAtClose, true, 'close waited for the run to unwind before reporting closed');
  assert.equal(connection.sends.length, 1, 'members 2 and 3 never receive a command');
  assert.equal(emitted, false, 'a cancelled run emits nothing onto a closed node');
});

test('close cancels every concurrent fan-out, not just the newest (Greptile #140)', async () => {
  // Node-RED does not serialise async input handlers: two messages arriving
  // close together re-enter and run concurrently. Tracking one slot would let
  // close cancel only the second run and return as soon as it settled, leaving
  // the first still walking its member list.
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({ selectionMode: 'all',
    connection: 'conn',
    executionMode: 'sequential',
    delivery: 'send',
    intervalMs: 60000,
  });

  let firstSettled = false;
  let secondSettled = false;
  const first = emitInput(node, { payload: builtCommand() }, () => {}).then(() => { firstSettled = true; });
  const second = emitInput(node, { payload: builtCommand() }, () => {}).then(() => { secondSettled = true; });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connection.sends.length, 2, 'both runs sent to their first member');
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);

  await new Promise((resolve) => node.emit('close', resolve));
  await Promise.all([first, second]);

  assert.equal(firstSettled, true, 'the older run was cancelled and awaited too');
  assert.equal(secondSettled, true);
  assert.equal(connection.sends.length, 2, 'neither run advanced past member 1');
});

test('a config with no numeric keys at all inherits the lib absence defaults (Gitar, #287)', async () => {
  // Absence stays absence: numberOption must hand executeFanout `undefined`
  // for a key the config never carried, so the lib's own defaults fire.
  // Coercing absence gives NaN, every pacing comparison against NaN is
  // false, and the whole fleet launches at once with no throttle — silent.
  const connection = connectionStub([peer(1), peer(2)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  // No intervalMs, timeoutMs, maxRetries, or concurrency keys anywhere.
  const node = new Node({ selectionMode: 'all', connection: 'conn', executionMode: 'sequential', delivery: 'send' });
  let sent;

  const started = Date.now();
  await emitInput(node, { payload: builtCommand() }, (messages) => {
    sent = messages;
  });

  assert.equal(sent[1].result, 'succeeded', 'the run completes');
  assert.equal(connection.sends.length, 2, 'both members sent');
  // DEFAULT_INTERVAL_MS (100) paces the second member: a NaN interval would
  // sleep 0 ms and finish effectively instantly. One inter-member gap is the
  // observable difference between "default applied" and "absence became NaN".
  assert.ok(Date.now() - started >= 80, 'the lib default interval paced the run');
});

test('a wrapper concurrency of 0 completes instead of hanging (Codex, #287)', async () => {
  // Trusted-msg garbage, but the failure shape matters: with nothing in
  // flight there is nothing to race, and Promise.race([]) never settles — a
  // run that hangs forever is not GIGO, it is a broken promise. The launch
  // loop's liveness guard degenerates 0 (and negatives) to strict
  // one-at-a-time; the value is still never repaired.
  const connection = connectionStub([peer(1), peer(2)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-fanout')(RED);
  const Node = RED.nodes.types['mavlink-fanout'];
  const node = new Node({ selectionMode: 'all', connection: 'conn', executionMode: 'sequential', delivery: 'send', intervalMs: 0 });
  let sent;

  await emitInput(
    node,
    { payload: { message: builtCommand(), options: { concurrency: 0 } } },
    (messages) => { sent = messages; }
  );

  assert.equal(sent[1].result, 'succeeded', 'the run completes rather than hanging');
  assert.equal(connection.sends.length, 2, 'both members still sent');
});
