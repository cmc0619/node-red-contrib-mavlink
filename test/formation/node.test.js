'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { formationTargets } = require('../../lib/formation');

const ANCHOR = { lat: 47.4, lon: 8.5, alt: 30 };

/** Formation always builds COMMAND_INT: lat/lon ride degE7 x/y, alt is metre z. */
const e7 = (deg) => Math.round(deg * 1e7);

test('line formation fans DO_REPOSITION out with each member\'s own lat/lon in degE7 x/y and metre z', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const Node = RED.nodes.types['mavlink-formation'];
  const node = new Node({
    connection: 'conn',
    shape: 'line',
    spacing: 10,
    sysids: '1,2,3',
    anchorMode: 'fixed',
    lat: ANCHOR.lat,
    lon: ANCHOR.lon,
    alt: ANCHOR.alt,
    headingDeg: 0,
    pitchDeg: 0,    delivery: 'send',
    intervalMs: 0,
  });
  let sent;

  await emitInput(node, { payload: {} }, (messages) => { sent = messages; });

  assert.equal(sent[1].result, 'succeeded');
  assert.equal(sent[1].count, 3, 'all three members commanded');
  assert.equal(sent[0].payload.result, 'succeeded', 'continue output carries the aggregate');
  assert.equal(connection.sends.length, 3);

  const expected = new Map(
    formationTargets({ shape: 'line', spacing: 10, anchor: ANCHOR, headingDeg: 0, sysids: [1, 2, 3] })
      .map((t) => [t.sysid, t])
  );
  for (const { message } of connection.sends) {
    const fields = message.fields;
    assert.equal(fields.command, 192, 'Go To / Reposition preset (MAV_CMD_DO_REPOSITION)');
    const want = expected.get(fields.target_system);
    assert.equal(fields.x, e7(want.lat), `sysid ${fields.target_system} lat rides degE7 x`);
    assert.equal(fields.y, e7(want.lon), `sysid ${fields.target_system} lon rides degE7 y`);
    assert.equal(fields.z, want.alt, `sysid ${fields.target_system} alt rides metre z`);
    assert.equal(fields.param1, -1, 'speed defaults to -1 (use default), never 0');
    assert.ok(Number.isNaN(fields.param4), 'yaw is NaN (hold current heading), never 0 (north)');
  }

  // Slot 0 (lowest sysid) sits exactly on the anchor; heading 0 puts the line
  // abreast east-west of it at the shared altitude.
  const bySysid = Object.fromEntries(connection.sends.map((s) => [s.message.fields.target_system, s.message.fields]));
  assert.equal(bySysid[1].x, e7(ANCHOR.lat));
  assert.equal(bySysid[1].y, e7(ANCHOR.lon));
  assert.equal(bySysid[1].z, ANCHOR.alt);
  assert.ok(bySysid[2].y > e7(ANCHOR.lon), 'slot 1 is east of the anchor');
  assert.ok(bySysid[3].y < e7(ANCHOR.lon), 'slot 2 is west of the anchor');
  assert.equal(bySysid[2].x, e7(ANCHOR.lat), 'line at heading 0 stays on the anchor latitude');
  assert.equal(bySysid[2].z, ANCHOR.alt, 'every target inherits the anchor altitude');
});

test('leader anchor reads position, relative altitude and heading from the peer table', async () => {
  const leader = peer(7, { position: { lat: 47.4, lon: 8.5, alt: 430, relativeAlt: 30, heading: 90 } });
  const connection = connectionStub([peer(1), peer(2), leader]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'line',
    spacing: 10,
    sysids: '1,2',
    anchorMode: 'leader',
    leader: 7,
    pitchDeg: 0,    delivery: 'send',
    intervalMs: 0,
  });
  let sent;

  await emitInput(node, { payload: {} }, (messages) => { sent = messages; });

  assert.equal(sent[1].result, 'succeeded');
  const bySysid = Object.fromEntries(connection.sends.map((s) => [s.message.fields.target_system, s.message.fields]));
  assert.equal(bySysid[1].x, e7(47.4), 'slot 0 sits on the leader position');
  assert.equal(bySysid[1].y, e7(8.5));
  assert.equal(bySysid[1].z, 30, 'altitude is the leader relativeAlt (GLOBAL_RELATIVE_ALT), not AMSL alt');
  // Leader heading 90 rotates the line: "right of the leader" now points south.
  assert.ok(bySysid[2].x < e7(47.4), 'slot 1 is south of the leader at heading 90');
  assert.equal(bySysid[2].y, e7(8.5), 'slot 1 stays on the leader longitude at heading 90');
});

test('leader with no reported position fails loudly — nothing is sent', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(7)]); // leader has position: null
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'line',
    spacing: 10,
    sysids: '1,2',
    anchorMode: 'leader',
    leader: 7,
    pitchDeg: 0,    delivery: 'send',
    intervalMs: 0,
  });
  let sent;
  const err = await emitInput(node, { payload: {} }, (m) => { sent = m; }).then(() => null, (e) => e);

  assert.ok(err, 'missing leader position fails the input');
  assert.equal(connection.sends.length, 0, 'nothing was sent');
  assert.equal(sent[0], null, 'no continue output on failure');
  assert.equal(sent[1].result, 'failed');
});

/**
 * Build a leader-anchored node. Members 1/2/3 never report a position, so the
 * only leader candidates in these cases are the peers given one explicitly.
 *
 * @param {object[]} rows  peer-table snapshot rows
 * @param {number} leader  configured leader sysid
 * @param {boolean} [promoteLeader]
 * @returns {{node: object, connection: object}}
 */
function leaderNode(rows, leader, promoteLeader) {
  const connection = connectionStub(rows);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const Node = RED.nodes.types['mavlink-formation'];
  return {
    connection,
    node: new Node({
      connection: 'conn',
      shape: 'line',
      spacing: 10,
      sysids: '1,2,3',
      anchorMode: 'leader',
      leader,
      promoteLeader,
      headingDeg: 0,
      pitchDeg: 0,
      delivery: 'send',
      intervalMs: 0,
    }),
  };
}

/** Where slot 0 (the lowest member sysid) was commanded — i.e. the anchor. */
function slotZero(connection) {
  return connection.sends
    .map((s) => s.message.fields)
    .find((fields) => fields.target_system === 1);
}

const AT = (lat, lon) => ({ lat, lon, alt: 400, relativeAlt: 25, heading: 0 });

test('a leader-anchored run reports which sysid the pattern hung off', async () => {
  const { node, connection } = leaderNode(
    [peer(1), peer(2), peer(3), peer(7, { position: AT(47.4, 8.5) })], 7
  );
  let sent;
  await emitInput(node, { payload: {} }, (messages) => { sent = messages; });

  // Reported on an ordinary run, not only a promoted one: a flow reads one
  // field rather than inferring a substitution from a missing one.
  assert.equal(sent[1].leader, 7, 'status record names the anchoring vehicle');
  assert.equal(sent[0].payload.leader, 7, 'continue output carries it too');
  assert.equal(slotZero(connection).x, e7(47.4), 'the pattern hung off sysid 7');
});

test('a fixed anchor reports no leader — there is none', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const Node = RED.nodes.types['mavlink-formation'];
  const node = new Node({
    connection: 'conn',
    shape: 'line',
    spacing: 10,
    sysids: '1,2,3',
    anchorMode: 'fixed',
    lat: ANCHOR.lat,
    lon: ANCHOR.lon,
    alt: ANCHOR.alt,
    headingDeg: 0,
    pitchDeg: 0,
    delivery: 'send',
    intervalMs: 0,
  });
  let sent;
  await emitInput(node, { payload: {} }, (messages) => { sent = messages; });

  assert.ok(!('leader' in sent[1]), 'no leader field on a fixed anchor');
});

test('without Promote a stale leader still anchors the pattern', async () => {
  // The historical behaviour, and the reason Promote exists as a choice: the
  // config names one vehicle, so its last fix is what the flow asked for.
  const { node, connection } = leaderNode([
    peer(1), peer(2), peer(3),
    peer(7, { state: 'stale', position: AT(47.4, 8.5) }),
    peer(9, { position: AT(10, 10) }),
  ], 7);
  let sent;
  await emitInput(node, { payload: {} }, (messages) => { sent = messages; });

  assert.equal(sent[1].leader, 7, 'the stale configured leader still anchors');
  assert.equal(slotZero(connection).x, e7(47.4), 'anchored on its last fix');
});

test('Promote hands a stale leader off to the next live sysid above it', async () => {
  const { node, connection } = leaderNode([
    peer(1), peer(2), peer(3),
    peer(7, { state: 'stale', position: AT(47.4, 8.5) }),
    peer(9, { position: AT(10, 10) }),
    peer(11, { position: AT(20, 20) }),
  ], 7, true);
  let sent;
  await emitInput(node, { payload: {} }, (messages) => { sent = messages; });

  assert.equal(sent[1].leader, 9, 'the lowest live sysid above 7, not the highest');
  assert.equal(slotZero(connection).x, e7(10), 'the pattern moved to sysid 9');
});

test('Promote passes over a live peer that has never reported a position', async () => {
  // Live is both halves: still heartbeating AND carrying a position. A peer
  // with neither cannot anchor anything.
  const { node, connection } = leaderNode([
    peer(1), peer(2), peer(3),
    peer(7, { state: 'stale', position: AT(47.4, 8.5) }),
    peer(9), // active, position null
    peer(11, { position: AT(20, 20) }),
  ], 7, true);
  let sent;
  await emitInput(node, { payload: {} }, (messages) => { sent = messages; });

  assert.equal(sent[1].leader, 11, 'sysid 9 has no position to anchor on');
  assert.equal(slotZero(connection).x, e7(20));
});

test('Promote wraps to the lowest live sysid when the leader is the highest', async () => {
  const { node, connection } = leaderNode([
    peer(1), peer(3),
    peer(2, { position: AT(10, 10) }),
    peer(5, { position: AT(20, 20) }),
    peer(7, { state: 'stale', position: AT(47.4, 8.5) }),
  ], 7, true);
  let sent;
  await emitInput(node, { payload: {} }, (messages) => { sent = messages; });

  assert.equal(sent[1].leader, 2, 'wrapped past the top to the lowest live sysid');
  assert.equal(slotZero(connection).x, e7(10));
});

test('Promote with nobody live to promote leaves the configured leader in place', async () => {
  // Best effort, not a refusal: promotion substitutes when it can, and
  // otherwise the run behaves exactly as an unpromoted one.
  const { node, connection } = leaderNode([
    peer(1), peer(2), peer(3),
    peer(7, { state: 'stale', position: AT(47.4, 8.5) }),
  ], 7, true);
  let sent;
  await emitInput(node, { payload: {} }, (messages) => { sent = messages; });

  assert.equal(sent[1].leader, 7);
  assert.equal(slotZero(connection).x, e7(47.4), 'still its last fix');
});

test('Promote does not rescue an input when nothing in the fleet has a position', async () => {
  const { node, connection } = leaderNode([peer(1), peer(2), peer(3), peer(7)], 7, true);
  let sent;
  const err = await emitInput(node, { payload: {} }, (m) => { sent = m; })
    .then(() => null, (e) => e);

  assert.ok(err, 'no candidate anywhere fails the input, promotion or not');
  assert.equal(connection.sends.length, 0, 'nothing is sent');
  assert.equal(sent[1].result, 'failed');
});

test('a promoted leader is not remembered — the configured one takes it back', async () => {
  // Nothing here holds a currentLeader, so recovery needs no reset path: the
  // next message re-decides from the peer table as it then stands.
  const rows = [
    peer(1), peer(2), peer(3),
    peer(7, { state: 'stale', position: AT(47.4, 8.5) }),
    peer(9, { position: AT(10, 10) }),
  ];
  const { node, connection } = leaderNode(rows, 7, true);

  let first;
  await emitInput(node, { payload: {} }, (messages) => { first = messages; });
  assert.equal(first[1].leader, 9, 'promoted while the leader was stale');

  rows[3].components[0].state = 'active';
  connection.sends.length = 0;
  let second;
  await emitInput(node, { payload: {} }, (messages) => { second = messages; });

  assert.equal(second[1].leader, 7, 'the configured leader leads again once it reports');
  assert.equal(slotZero(connection).x, e7(47.4));
});

test('unknown leader heading stays unknown — north is not invented', async () => {
  const leader = peer(7, { position: { lat: 47.4, lon: 8.5, alt: 430, relativeAlt: 30, heading: null } });
  const connection = connectionStub([peer(1), peer(2), leader]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'line',
    spacing: 10,
    sysids: '1,2',
    anchorMode: 'leader',
    leader: 7,
    pitchDeg: 0,    delivery: 'send',
    intervalMs: 0,
  });

  await emitInput(node, { payload: {} }, () => {});

  assert.equal(connection.sends.length, 2);
  assert.ok(connection.sends.every((s) => Number.isNaN(s.message.fields.x)),
    'NaN heading produces NaN geometry, not a silent north-facing line');
});

test('a blank fixed anchor altitude rides as the coercion — the editor is the guard', async () => {
  // `alt` is `required` under the fixed anchor mode (mavlink-formation.html),
  // so a blank one is hand-edit drift. The driver coerces and sends: the
  // altitude field is a float, and NaN is legal MAVLink for "not used".
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'line',
    spacing: 10,
    sysids: '1',
    anchorMode: 'fixed',
    lat: 47.4,
    lon: 8.5,
    alt: '',
    pitchDeg: 0,
    delivery: 'send',
    intervalMs: 0,
  });
  await emitInput(node, { payload: {} }, () => {});

  assert.equal(connection.sends.length, 1, 'the setpoint still reached the wire');
  assert.equal(connection.sends[0].message.fields.z, 0, 'a blank altitude is Number(\'\')');
});

test('an out-of-range config sysid selects no vehicle rather than refusing', () => {
  // The editor bounds every entry in the Sysids box (mavlink-formation.html
  // `sysids`, 1..255), so a token past it is hand-edit drift. It coerces and
  // names no vehicle, which is what the empty-selection report is for.
  const { parseSysidList } = require('../../lib/fanout');
  assert.deepEqual(parseSysidList('1,300'), [1, 300], 'both tokens coerce');
});

test('msg.payload.anchor and headingDeg override the configured leader anchor', async () => {
  const leader = peer(7, { position: { lat: 10, lon: 10, alt: 100, relativeAlt: 50, heading: 180 } });
  const connection = connectionStub([peer(1), peer(2), leader]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'line',
    spacing: 10,
    sysids: '1,2',
    anchorMode: 'leader',
    leader: 7,
    pitchDeg: 0,    delivery: 'send',
    intervalMs: 0,
  });

  await emitInput(node, {
    payload: { anchor: { lat: 47.0, lon: 8.0, alt: 25 }, headingDeg: 0 },
  }, () => {});

  const bySysid = Object.fromEntries(connection.sends.map((s) => [s.message.fields.target_system, s.message.fields]));
  assert.equal(bySysid[1].x, e7(47.0), 'payload anchor wins over the leader');
  assert.equal(bySysid[1].y, e7(8.0));
  assert.equal(bySysid[1].z, 25);
  assert.ok(bySysid[2].y > e7(8.0), 'payload heading 0 (not leader 180) orients the line east');
});

test('msg.payload.headingDeg is trusted input: Number() coercion, never a refusal', async () => {
  // The driver never refuses trusted payload input. A numeric string behaves
  // exactly as the number it coerces to; garbage coerces to NaN and flows
  // through — the flow author's to fix, not the driver's to refuse.
  const connection = connectionStub([peer(1), peer(2)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'column',
    spacing: 10,
    sysids: '1,2',
    anchorMode: 'fixed',
    lat: 47.397742,
    lon: 8.545594,
    alt: 30,
    pitchDeg: 0,    delivery: 'send',
    intervalMs: 0,
    timeoutMs: 10000,
  });
  let sent;

  await emitInput(node, { payload: { headingDeg: '90' } }, (m) => { sent = m; });

  assert.equal(sent[1].result, 'succeeded');
  const bySysid = Object.fromEntries(connection.sends.map((s) => [s.message.fields.target_system, s.message.fields]));
  // Column facing east (heading 90): the trailing slot is 10 m west — the
  // same hand-computed longitude delta as the lib tests.
  assert.equal(bySysid[2].y, e7(8.545594 - 1.32709215145987e-4), 'slot 1 lon');
  assert.equal(bySysid[2].x, e7(47.397742), 'slot 1 lat');

  // 'north' coerces to NaN: the run still executes, and the NaN geometry
  // rides the patches as-is (Fan-out is a raw surface).
  connection.sends.length = 0;
  await emitInput(node, { payload: { headingDeg: 'north' } }, (m) => { sent = m; });
  assert.equal(sent[1].result, 'succeeded');
  assert.equal(connection.sends.length, 2);
  assert.ok(connection.sends.every((s) => Number.isNaN(s.message.fields.x)));
});

test('formation builds COMMAND_INT with per-member degE7 coords (§9)', async () => {
  const connection = connectionStub([peer(1), peer(2)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'line',
    spacing: 10,
    sysids: '1,2',
    anchorMode: 'fixed',
    lat: ANCHOR.lat,
    lon: ANCHOR.lon,
    alt: ANCHOR.alt,
    headingDeg: 0,
    pitchDeg: 0,    delivery: 'send',
    intervalMs: 0,
  });
  let sent;

  await emitInput(node, { payload: {} }, (m) => { sent = m; });

  assert.equal(sent[1].result, 'succeeded');
  const expected = new Map(
    formationTargets({ shape: 'line', spacing: 10, anchor: ANCHOR, headingDeg: 0, sysids: [1, 2] })
      .map((t) => [t.sysid, t])
  );
  for (const { message } of connection.sends) {
    const fields = message.fields;
    const want = expected.get(fields.target_system);
    assert.equal(message.name, 'COMMAND_INT');
    assert.equal(fields.command, 192);
    assert.equal(fields.frame, 3, 'targets ride MAV_FRAME_GLOBAL_RELATIVE_ALT');
    assert.equal(fields.x, Math.round(want.lat * 1e7), `sysid ${fields.target_system} lat is degE7 in x`);
    assert.equal(fields.y, Math.round(want.lon * 1e7), `sysid ${fields.target_system} lon is degE7 in y`);
    assert.equal(fields.z, want.alt, 'altitude stays float metres in z');
  }
});

test('close aborts an in-flight formation run and waits for it to unwind', async () => {
  // Same close discipline as mavlink-fanout: a 60 s inter-member interval
  // parks the member loop in the pause, so close is guaranteed to land
  // mid-run rather than racing a finished one.
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'line',
    spacing: 10,
    sysids: '1,2,3',
    anchorMode: 'fixed',
    lat: ANCHOR.lat,
    lon: ANCHOR.lon,
    alt: ANCHOR.alt,
    headingDeg: 0,
    pitchDeg: 0,    delivery: 'send',
    intervalMs: 60000,
  });

  let emitted = false;
  let inputSettled = false;
  const run = emitInput(node, { payload: {} }, () => { emitted = true; })
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
  assert.equal(connection.sends.length, 1, 'members 2 and 3 never receive a reposition');
  assert.equal(emitted, false, 'a cancelled run emits nothing onto a closed node');
});

test('msg.payload.sysids overrides the configured member list', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'column',
    spacing: 5,
    sysids: '1,2,3',
    anchorMode: 'fixed',
    lat: 47.4,
    lon: 8.5,
    alt: 30,
    pitchDeg: 0,    delivery: 'send',
    intervalMs: 0,
  });
  let sent;

  await emitInput(node, { payload: { sysids: '2,3' } }, (m) => { sent = m; });

  assert.equal(sent[1].result, 'succeeded');
  assert.equal(sent[1].count, 2, 'only the payload sysids are commanded');
  assert.deepEqual(
    connection.sends.map((s) => s.message.fields.target_system).sort(),
    [2, 3]
  );
});

test('sphere with pitchDeg override fans distinct altitudes via DO_REPOSITION', async () => {
  const connection = connectionStub([peer(1), peer(2), peer(3), peer(4), peer(5)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'sphere',
    spacing: 12,
    sysids: '1,2,3,4,5',
    anchorMode: 'fixed',
    lat: ANCHOR.lat,
    lon: ANCHOR.lon,
    alt: ANCHOR.alt,
    headingDeg: 0,
    pitchDeg: 0,    delivery: 'send',
    intervalMs: 0,
  });
  let sent;

  await emitInput(node, { payload: { pitchDeg: 45 } }, (m) => { sent = m; });

  assert.equal(sent[1].result, 'succeeded');
  assert.equal(sent[1].count, 5);
  const expected = new Map(
    formationTargets({
      shape: 'sphere',
      spacing: 12,
      anchor: ANCHOR,
      headingDeg: 0,
      pitchDeg: 45,
      sysids: [1, 2, 3, 4, 5],
    }).map((t) => [t.sysid, t])
  );
  const alts = [];
  for (const { message } of connection.sends) {
    const want = expected.get(message.fields.target_system);
    assert.equal(message.fields.x, e7(want.lat));
    assert.equal(message.fields.y, e7(want.lon));
    assert.equal(message.fields.z, want.alt);
    alts.push(message.fields.z);
  }
  assert.ok(new Set(alts).size > 1, 'sphere pitch leaves vehicles at more than one altitude');
});

function emitInput(node, msg, send) {
  return new Promise((resolve, reject) => {
    node.emit('input', msg, send, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function peer(sysid, extra = {}) {
  return {
    sysid,
    components: [{
      compid: 1,
      state: 'active',
      type: 2,
      autopilot: 3,
      armed: false,
      position: null,
      ...extra,
    }],
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
  };
}
