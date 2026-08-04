'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { formationTargets } = require('../../lib/formation');

const ANCHOR = { lat: 47.4, lon: 8.5, alt: 30 };

test('line formation fans DO_REPOSITION out with each member\'s own lat/lon/alt in params 5/6/7', async () => {
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
    carrier: 'long',
    delivery: 'send',
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
    assert.equal(fields.param5, want.lat, `sysid ${fields.target_system} lat rides param 5`);
    assert.equal(fields.param6, want.lon, `sysid ${fields.target_system} lon rides param 6`);
    assert.equal(fields.param7, want.alt, `sysid ${fields.target_system} alt rides param 7`);
    assert.equal(fields.param1, -1, 'speed defaults to -1 (use default), never 0');
    assert.ok(Number.isNaN(fields.param4), 'yaw is NaN (hold current heading), never 0 (north)');
  }

  // Slot 0 (lowest sysid) sits exactly on the anchor; heading 0 puts the line
  // abreast east-west of it at the shared altitude.
  const bySysid = Object.fromEntries(connection.sends.map((s) => [s.message.fields.target_system, s.message.fields]));
  assert.equal(bySysid[1].param5, ANCHOR.lat);
  assert.equal(bySysid[1].param6, ANCHOR.lon);
  assert.equal(bySysid[1].param7, ANCHOR.alt);
  assert.ok(bySysid[2].param6 > ANCHOR.lon, 'slot 1 is east of the anchor');
  assert.ok(bySysid[3].param6 < ANCHOR.lon, 'slot 2 is west of the anchor');
  assert.equal(bySysid[2].param5, ANCHOR.lat, 'line at heading 0 stays on the anchor latitude');
  assert.equal(bySysid[2].param7, ANCHOR.alt, 'every target inherits the anchor altitude');
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
    carrier: 'long',
    delivery: 'send',
    intervalMs: 0,
  });
  let sent;

  await emitInput(node, { payload: {} }, (messages) => { sent = messages; });

  assert.equal(sent[1].result, 'succeeded');
  const bySysid = Object.fromEntries(connection.sends.map((s) => [s.message.fields.target_system, s.message.fields]));
  assert.equal(bySysid[1].param5, 47.4, 'slot 0 sits on the leader position');
  assert.equal(bySysid[1].param6, 8.5);
  assert.equal(bySysid[1].param7, 30, 'altitude is the leader relativeAlt (GLOBAL_RELATIVE_ALT), not AMSL alt');
  // Leader heading 90 rotates the line: "right of the leader" now points south.
  assert.ok(bySysid[2].param5 < 47.4, 'slot 1 is south of the leader at heading 90');
  assert.ok(Math.abs(bySysid[2].param6 - 8.5) < 1e-9, 'slot 1 stays on the leader longitude at heading 90');
});

test('leader with no reported position is refused, not defaulted', async () => {
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
    carrier: 'long',
    delivery: 'send',
    intervalMs: 0,
  });
  let sent;
  const err = await emitInput(node, { payload: {} }, (m) => { sent = m; }).then(() => null, (e) => e);

  assert.ok(err, 'missing leader position fails the input');
  assert.match(err.message, /no reported position/);
  assert.match(err.message, /7/, 'error names the leader sysid');
  assert.equal(connection.sends.length, 0, 'nothing was sent');
  assert.equal(sent[0], null, 'no continue output on refusal');
  assert.equal(sent[1].result, 'failed');
  assert.match(sent[1].detail, /no reported position/);
});

test('leader without a finite relative altitude is refused (altitude must not default)', async () => {
  const leader = peer(7, { position: { lat: 47.4, lon: 8.5, alt: 430, relativeAlt: null, heading: 0 } });
  const connection = connectionStub([peer(1), leader]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'line',
    spacing: 10,
    sysids: '1',
    anchorMode: 'leader',
    leader: 7,
    carrier: 'long',
    delivery: 'send',
    intervalMs: 0,
  });
  const err = await emitInput(node, { payload: {} }, () => {}).then(() => null, (e) => e);

  assert.ok(err, 'missing relative altitude fails the input');
  assert.match(err.message, /relative altitude/);
  assert.equal(connection.sends.length, 0);
});

test('unknown leader heading defaults the pattern to north (0), documented safe default', async () => {
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
    carrier: 'long',
    delivery: 'send',
    intervalMs: 0,
  });

  await emitInput(node, { payload: {} }, () => {});

  const bySysid = Object.fromEntries(connection.sends.map((s) => [s.message.fields.target_system, s.message.fields]));
  assert.equal(bySysid[2].param5, 47.4, 'heading 0: the line stays on the anchor latitude');
  assert.ok(bySysid[2].param6 > 8.5, 'heading 0: slot 1 is due east');
});

test('geometry refusal propagates: fixed anchor with a blank altitude fails the input', async () => {
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
    carrier: 'long',
    delivery: 'send',
    intervalMs: 0,
  });
  let sent;
  const err = await emitInput(node, { payload: {} }, (m) => { sent = m; }).then(() => null, (e) => e);

  assert.ok(err, 'blank anchor altitude fails the input');
  assert.match(err.message, /altitude/);
  assert.equal(connection.sends.length, 0);
  assert.equal(sent[1].result, 'failed');
});

test('bad config sysid tokens fail loudly as node errors', async () => {
  const connection = connectionStub([peer(1)]);
  const RED = redStub({ conn: connection });
  require('../../nodes/mavlink-formation')(RED);
  const node = new (RED.nodes.types['mavlink-formation'])({
    connection: 'conn',
    shape: 'line',
    spacing: 10,
    sysids: '1,300',
    anchorMode: 'fixed',
    lat: 47.4,
    lon: 8.5,
    alt: 30,
    carrier: 'long',
    delivery: 'send',
    intervalMs: 0,
  });
  let sent;
  const err = await emitInput(node, { payload: {} }, (m) => { sent = m; }).then(() => null, (e) => e);

  assert.ok(err, 'out-of-range sysid fails the input');
  assert.match(err.message, /1\.\.255/, 'error names the valid range');
  assert.match(err.message, /300/, 'error names the bad token');
  assert.equal(sent[1].result, 'failed');
  assert.equal(connection.sends.length, 0);
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
    carrier: 'long',
    delivery: 'send',
    intervalMs: 0,
  });

  await emitInput(node, {
    payload: { anchor: { lat: 47.0, lon: 8.0, alt: 25 }, headingDeg: 0 },
  }, () => {});

  const bySysid = Object.fromEntries(connection.sends.map((s) => [s.message.fields.target_system, s.message.fields]));
  assert.equal(bySysid[1].param5, 47.0, 'payload anchor wins over the leader');
  assert.equal(bySysid[1].param6, 8.0);
  assert.equal(bySysid[1].param7, 25);
  assert.ok(bySysid[2].param6 > 8.0, 'payload heading 0 (not leader 180) orients the line east');
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
    carrier: 'long',
    delivery: 'send',
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
