'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Connection, STATE } = require('../../lib/connection');
const { BAND } = require('../../lib/connection/bands');
const { mockDgram, fakeWire, frameBuffer, fakeTimers, fakeClock } = require('./helpers');

const GCS = {
  id: 'gcs',
  sysid: 255,
  compid: 190,
  heartbeatIntervalMs: 1000,
  heartbeat: { type: 6, autopilot: 8, systemStatus: 4 },
};

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A stub identity resolver so the runtime tests do not couple to lib/identity.
 *
 * @param {object} input
 * @returns {{identityId: string, source: string}}
 */
function resolveIdentity(input) {
  const override = input.overrideId;
  if (override) {
    if (!input.boundIdentityIds.includes(override)) {
      throw new Error(`override '${override}' is not bound`);
    }
    return { identityId: override, source: 'override' };
  }
  return { identityId: input.defaultIdentityId, source: 'default' };
}

/**
 * @param {object} [configOverrides]
 * @param {object} [depOverrides]
 * @returns {{connection: Connection, dg: object, timers: object}}
 */
function build(configOverrides = {}, depOverrides = {}) {
  const dg = mockDgram();
  const timers = fakeTimers();
  const clock = fakeClock(1000);
  const config = {
    transport: {
      mode: 'udp',
      bindAddress: '0.0.0.0',
      bindPort: 14550,
      remoteAddress: '10.0.0.9',
      remotePort: 14555,
    },
    vehicle: { targetSystem: 1, targetComponent: 1, autopilot: 3 },
    identities: [GCS],
    defaultIdentityId: 'gcs',
    boundIdentityIds: ['gcs'],
    signing: { linkId: 0, signOutbound: false, requireSigned: false, acceptInvalid: false, hasKey: false },
    heartbeat: { intervalMs: 1000, staleMs: 5000, expireMs: 15000 },
    ...configOverrides,
  };
  const connection = new Connection(config, {
    now: clock.now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    dgram: dg.module,
    wire: fakeWire(),
    resolveIdentity,
    ...depOverrides,
  });
  return { connection, dg, timers };
}

test('a disabled connection constructs no runtime — no socket, no timers', async () => {
  const { connection, dg, timers } = build({ disabled: true });
  await connection.start();
  assert.equal(connection.getState(), STATE.DISABLED);
  assert.equal(dg.sockets.length, 0);
  assert.equal(timers.active(), 0);
});

test('invalid-packet count reads 0 before the wire exists', () => {
  // The State node's snapshot reads this on every input, including one that
  // lands on a Connection whose start() has not built a wire yet.
  const { connection } = build();
  assert.equal(connection.invalidPacketCount(), 0);
});

test('start binds the socket and reports connected', async () => {
  const { connection, dg } = build();
  await connection.start();
  assert.equal(connection.getState(), STATE.CONNECTED);
  assert.equal(dg.sockets.length, 1);
  assert.deepEqual(dg.sockets[0].boundTo, { port: 14550, address: '0.0.0.0' });
  connection.close();
});

test('an inbound datagram enriches the peer table and delivers a copy to subscribers', async () => {
  const { connection, dg } = build();
  await connection.start();

  const received = [];
  connection.subscribe({ message: 'HEARTBEAT' }, (msg) => received.push(msg));

  dg.sockets[0].receive(
    frameBuffer({
      name: 'HEARTBEAT',
      sysid: 1,
      compid: 1,
      fields: { type: 2, autopilot: 3, base_mode: 128, custom_mode: 5, system_status: 4 },
    }),
    { address: '10.0.0.5', port: 14550 }
  );

  assert.equal(received.length, 1);
  assert.equal(received[0].name, 'HEARTBEAT');
  const component = connection.peerTable.getComponent(1, 1);
  assert.equal(component.armed, true);
  assert.equal(component.type, 2);
  assert.deepEqual(connection.peerTable.endpointFor(1, 1), { address: '10.0.0.5', port: 14550 });
  connection.close();
});

test('outbound sends drain one at a time in band order, using the socket callback as the release', async () => {
  const { connection, dg } = build();
  await connection.start();

  connection.send({ name: 'BULK_ONE', fields: {} }, { band: BAND.BULK });
  connection.send({ name: 'CONTROL_ONE', fields: {} }, { band: BAND.CONTROL });
  connection.send({ name: 'EMERGENCY_STOP', fields: {} }, { band: BAND.EMERGENCY });

  await delay(30);

  const names = dg.sockets[0].sent.map((s) => JSON.parse(s.buffer.toString()).name);
  // First dequeue happens before the others are enqueued (synchronous send()),
  // so BULK_ONE is already in flight; the remaining two then drain by band.
  assert.equal(names.length, 3);
  assert.equal(names[0], 'BULK_ONE');
  assert.deepEqual(names.slice(1), ['EMERGENCY_STOP', 'CONTROL_ONE']);
  connection.close();
});

test('a heartbeat tick enqueues on the Liveness band and is transmitted', async () => {
  const { connection, dg } = build();
  await connection.start();
  connection.heartbeats.tick();
  await delay(20);
  const sent = dg.sockets[0].sent
    .find((s) => JSON.parse(s.buffer.toString()).name === 'HEARTBEAT');
  assert.ok(sent);
  const heartbeat = JSON.parse(sent.buffer.toString());
  assert.equal(heartbeat.sysid, 255);
  assert.equal(heartbeat.compid, 190);
  // No peer heard yet: the broadcast ladder bottoms out at the configured
  // remote — the pre-peer path a directed fallback also rides (14.63).
  assert.equal(sent.port, 14555, 'the configured remotePort');
  connection.close();
});

test('peer-table sweep idle-evicts decoders only on UDP (not TCP)', async () => {
  const sweeps = [];
  function wireWithEvict() {
    const w = fakeWire();
    w.evictIdleDecoders = (...args) => {
      sweeps.push(args);
      return 0;
    };
    return w;
  }

  const udpIntervals = [];
  const { connection: udp } = build(
    { transport: { mode: 'udp', bindAddress: '0.0.0.0', bindPort: 14550 } },
    {
      wire: wireWithEvict(),
      setInterval: (fn, ms) => {
        udpIntervals.push({ fn, ms });
        return { unref() {} };
      },
      clearInterval() {},
    }
  );
  await udp.start();
  const sweep = udpIntervals.find((t) => t.ms === 5000);
  assert.ok(sweep, 'stale/sweep interval should be registered');
  sweep.fn();
  assert.equal(sweeps.length, 1, 'UDP sweep must call evictIdleDecoders');
  assert.equal(sweeps[0][1], 15000, 'idle decoder TTL matches peer-table expire default');
  udp.close();

  sweeps.length = 0;
  const tcpIntervals = [];
  const { connection: tcp } = build(
    {
      transport: {
        mode: 'tcp',
        bindAddress: '0.0.0.0',
        bindPort: 5760,
      },
    },
    {
      wire: wireWithEvict(),
      // TCP open needs a transport factory — inject a no-op transport.
      transportFactory: () => {
        const { EventEmitter } = require('node:events');
        const t = new EventEmitter();
        t.open = async () => {};
        t.close = (cb) => cb && cb();
        t.send = (_b, _e, cb) => cb && cb();
        return t;
      },
      setInterval: (fn, ms) => {
        tcpIntervals.push({ fn, ms });
        return { unref() {} };
      },
      clearInterval() {},
    }
  );
  await tcp.start();
  const tcpSweep = tcpIntervals.find((t) => t.ms === 5000);
  assert.ok(tcpSweep, 'TCP still runs peer-table sweep');
  tcpSweep.fn();
  assert.equal(sweeps.length, 0, 'TCP sweep must not age-evict stream decoders');
  tcp.close();
});

test('heartbeat scheduler interval is driven by the bound identity snapshot', async () => {
  const intervals = [];
  const identity = { ...GCS, heartbeatIntervalMs: 250 };
  const { connection } = build(
    {
      identities: [identity],
      heartbeat: { staleMs: 5000, expireMs: 15000 },
    },
    {
      setInterval: (_fn, ms) => {
        intervals.push(ms);
        return { unref() {} };
      },
      clearInterval() {},
    }
  );

  await connection.start();

  assert.ok(intervals.includes(250), `expected heartbeat timer at 250ms, saw ${intervals}`);
  connection.close();
});

test('listen-only UDP drops outbound quietly when no remote and no peer endpoint', async () => {
  const warns = [];
  const { connection, dg } = build(
    {
      transport: {
        mode: 'udp',
        bindAddress: '0.0.0.0',
        bindPort: 14550,
        // no remoteAddress / remotePort — valid listen-only bind
      },
    },
    { logger: { warn: (m) => warns.push(m), info() {}, error() {} } }
  );

  await connection.start();
  connection.send({ name: 'COMMAND_LONG', fields: {} }, { band: BAND.CONTROL });
  connection.heartbeats.tick();
  await delay(30);

  assert.equal(dg.sockets[0].sent.length, 0, 'nothing to send without a destination');
  assert.equal(
    warns.filter((m) => /outbound send failed|no destination/i.test(m)).length,
    0,
    'no-destination must not spam the Node-RED log'
  );
  assert.equal(connection.getState(), STATE.CONNECTED);
  connection.close();
});

test('partial UDP remote config drops quietly (the editor pairs host and port)', async () => {
  // The editor's pairing rule means a half-configured remote never deploys;
  // one that arrives anyway (hand-edited flow JSON) is no destination at all
  // and behaves as listen-only — quiet, like the no-remote case above.
  const warns = [];
  const { connection, dg } = build(
    {
      transport: {
        mode: 'udp',
        bindAddress: '0.0.0.0',
        bindPort: 14550,
        remoteAddress: '10.0.0.9',
        // remotePort omitted on purpose
      },
    },
    { logger: { warn: (m) => warns.push(m), info() {}, error() {} } }
  );

  await connection.start();
  connection.send({ name: 'COMMAND_LONG', fields: {} }, { band: BAND.CONTROL });
  await delay(30);

  assert.equal(dg.sockets[0].sent.length, 0);
  assert.equal(
    warns.filter((m) => /outbound send failed|destination/i.test(m)).length,
    0,
    'a half destination must not spam the Node-RED log'
  );
  connection.close();
});

test('UDP transport does not enable SO_BROADCAST from config', async () => {
  const dg = mockDgram();
  let setBroadcastCalls = 0;
  const originalCreateSocket = dg.module.createSocket;
  dg.module.createSocket = (...args) => {
    const socket = originalCreateSocket(...args);
    socket.setBroadcast = () => {
      setBroadcastCalls += 1;
    };
    return socket;
  };
  const { connection } = build(
    { transport: { mode: 'udp', bindAddress: '0.0.0.0', bindPort: 14550, broadcast: true } },
    { dgram: dg.module }
  );

  await connection.start();

  assert.equal(setBroadcastCalls, 0);
  connection.close();
});

test('require-signed drops an unsigned inbound frame and emits rejected', async () => {
  const { connection, dg } = build({
    signing: { linkId: 0, requireSigned: true, signOutbound: false, acceptInvalid: false, hasKey: false },
  });
  await connection.start();

  const received = [];
  const rejected = [];
  connection.subscribe(null, (m) => received.push(m));
  connection.on('rejected', (e) => rejected.push(e.reason));

  dg.sockets[0].receive(
    frameBuffer({ name: 'ATTITUDE', sysid: 1, compid: 1, fields: {} }),
    { address: '10.0.0.5', port: 14550 }
  );

  assert.equal(received.length, 0);
  assert.deepEqual(rejected, ['unsigned-rejected-require-signed']);
  connection.close();
});

test('sign-outbound with no key fails the connection closed on start', async () => {
  const { connection } = build({
    signing: { linkId: 0, signOutbound: true, requireSigned: false, acceptInvalid: false, hasKey: false },
  });
  await assert.rejects(() => connection.start(), /no signing passphrase/);
  assert.equal(connection.getState(), STATE.ERROR);
});

test('close tears down timers and the socket and always calls done exactly once', async () => {
  const { connection, dg, timers } = build();
  await connection.start();
  assert.equal(timers.active(), 2); // heartbeat + peer-table sweep

  let doneCalls = 0;
  await new Promise((resolve) => {
    connection.close(() => {
      doneCalls += 1;
      resolve();
    });
  });

  assert.equal(doneCalls, 1);
  assert.equal(timers.cleared(), 2);
  assert.equal(dg.sockets[0].closed, true);
  assert.equal(connection.getState(), STATE.CLOSED);
});

test('close before start still calls done (constructor-threw teardown path)', () => {
  const { connection } = build();
  let called = false;
  connection.close(() => {
    called = true;
  });
  assert.equal(called, true);
});

test('send() throws synchronously for an unserializable message — no phantom success', async () => {
  const wire = fakeWire();
  const realSerialize = wire.serialize;
  wire.serialize = (message, ctx) => {
    // Mirrors wire.js's real failure: a message name absent from the bound
    // dialect. The sender must hear about it — its node routes the throw to
    // status/done — and the queue must keep flowing for everyone else.
    if (message.name === 'BOGUS_MESSAGE') {
      throw new Error("no wire class for message 'BOGUS_MESSAGE'");
    }
    return realSerialize(message, ctx);
  };
  const { connection, dg } = build({}, { wire });
  await connection.start();

  assert.throws(
    () => connection.send({ name: 'BOGUS_MESSAGE', fields: {} }, { band: BAND.CONTROL }),
    /BOGUS_MESSAGE/,
    'the caller gets the failure synchronously, on its own error path'
  );
  connection.send({ name: 'GOOD_MESSAGE', fields: {} }, { band: BAND.CONTROL });
  await delay(30);

  const names = dg.sockets[0].sent.map((s) => JSON.parse(s.buffer.toString()).name);
  assert.deepEqual(names, ['GOOD_MESSAGE'], 'the rejected message never occupies the queue');

  connection.heartbeats.tick();
  await delay(30);
  const afterNames = dg.sockets[0].sent.map((s) => JSON.parse(s.buffer.toString()).name);
  assert.ok(afterNames.includes('HEARTBEAT'), 'heartbeats still transmit after a rejected send');
  connection.close();
});

test('_pump backstop: a drain-time serialize throw drops that envelope and keeps draining', async () => {
  // send()-time validation catches every deterministic failure, so reach the
  // backstop by failing only the SECOND serialize of the same message (the
  // drain-time one, which carries the real seq and signing context). The
  // guard's job is narrower now but §2-critical: whatever still escapes must
  // not wedge _draining or kill the runtime from a transport callback.
  const wire = fakeWire();
  const realSerialize = wire.serialize;
  let calls = 0;
  wire.serialize = (message, ctx) => {
    if (message.name === 'FLAKY_MESSAGE') {
      calls += 1;
      if (calls > 1) throw new Error('drain-time failure for FLAKY_MESSAGE');
    }
    return realSerialize(message, ctx);
  };
  const errors = [];
  const { connection, dg } = build(
    {},
    { wire, logger: { info() {}, warn() {}, error: (m) => errors.push(m) } }
  );
  await connection.start();

  connection.send({ name: 'FLAKY_MESSAGE', fields: {} }, { band: BAND.CONTROL });
  connection.send({ name: 'GOOD_MESSAGE', fields: {} }, { band: BAND.CONTROL });
  await delay(30);

  const names = dg.sockets[0].sent.map((s) => JSON.parse(s.buffer.toString()).name);
  assert.deepEqual(names, ['GOOD_MESSAGE'], 'the bad envelope is dropped, the good one still transmits');
  assert.ok(errors.some((m) => /FLAKY_MESSAGE/.test(m)), 'the drain-time failure is surfaced via the logger');

  connection.heartbeats.tick();
  await delay(30);
  const afterNames = dg.sockets[0].sent.map((s) => JSON.parse(s.buffer.toString()).name);
  assert.ok(afterNames.includes('HEARTBEAT'), 'heartbeats still transmit after a dropped envelope');
  connection.close();
});

test('close() during an in-flight start() must not resume into CONNECTED with live timers', async () => {
  const { connection, dg, timers } = build();

  const starting = connection.start();
  // close() races the still-pending transport.open() (mockDgram's socket.bind
  // resolves 'listening' via a queued setTimeout, so this runs first).
  connection.close();
  await starting;
  await delay(30);

  assert.notEqual(connection.getState(), STATE.CONNECTED, 'must not resume into CONNECTED after close()');
  assert.equal(timers.active(), 0, 'no heartbeat/sweep timer left running after the race');
  assert.equal(dg.sockets[0].closed, true, 'the just-opened transport must still be closed');
});

test('an open() rejected by a racing close() resolves start() quietly, not as an error', async () => {
  // TCP-style race: the transport settles its pending open() with a rejection
  // when close() interrupts it. start() must swallow that — surfacing it would
  // paint a spurious deploy-time ERROR via the node's start().catch().
  let rejectOpen;
  const transportFactory = () => ({
    mode: 'tcp',
    on() {},
    open: () => new Promise((resolve, reject) => { rejectOpen = reject; }),
    close: (cb) => {
      const err = new Error('TCP transport closed during open');
      err.code = 'TCP_CLOSED_DURING_OPEN';
      rejectOpen(err);
      cb();
    },
    send() {},
  });
  const { connection } = build({}, { transportFactory });

  const starting = connection.start();
  connection.close();
  await starting; // must not reject
  assert.equal(connection.getState(), STATE.CLOSED, 'the race must settle in CLOSED, not CONNECTING');
});

test('an identity override outside the bound set is rejected, never falling back', async () => {
  const { connection } = build();
  await connection.start();
  assert.throws(() => connection.send({ name: 'PING', fields: {} }, { identityId: 'ghost' }), /not bound/);
  connection.close();
});

// ── issue #91 / #93: endpoint durability and terminal-state hygiene ──────────

/** Teach the peer table an endpoint for sysid 7 / compid 1 via a heartbeat. */
function introducePeer(dg) {
  dg.sockets[0].receive(
    frameBuffer({
      name: 'HEARTBEAT',
      sysid: 7,
      compid: 1,
      fields: { type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 4 },
    }),
    { address: '10.0.0.7', port: 14551 }
  );
}

test('a transient send error warns but keeps the peer endpoint (#91)', async () => {
  const warns = [];
  const { connection, dg } = build(
    {},
    { logger: { warn: (m) => warns.push(m), info() {}, error() {} } }
  );
  await connection.start();
  introducePeer(dg);

  dg.sockets[0].send = (_buffer, _port, _address, callback) => {
    const err = new Error('send EHOSTUNREACH 10.0.0.7:14551');
    err.code = 'EHOSTUNREACH';
    setTimeout(() => callback(err), 0);
  };
  connection.send(
    { name: 'COMMAND_LONG', fields: {} },
    { band: BAND.CONTROL, target: { sysid: 7, compid: 1 } }
  );
  await delay(30);

  assert.ok(
    warns.some((m) => /outbound send failed/.test(m)),
    'the failure itself is still surfaced'
  );
  assert.deepEqual(
    connection.peerTable.endpointFor(7, 1),
    { address: '10.0.0.7', port: 14551 },
    'an ICMP blip must not delete the best-known address'
  );
  connection.close();
});

test('a non-transient send error still demotes the endpoint (failover intact)', async () => {
  const { connection, dg } = build(
    {},
    { logger: { warn() {}, info() {}, error() {} } }
  );
  await connection.start();
  introducePeer(dg);

  dg.sockets[0].send = (_buffer, _port, _address, callback) => {
    const err = new Error('send EMSGSIZE');
    err.code = 'EMSGSIZE';
    setTimeout(() => callback(err), 0);
  };
  connection.send(
    { name: 'COMMAND_LONG', fields: {} },
    { band: BAND.CONTROL, target: { sysid: 7, compid: 1 } }
  );
  await delay(30);

  assert.equal(
    connection.peerTable.endpointFor(7, 1),
    null,
    'non-transient failures keep the existing failover behaviour'
  );
  connection.close();
});

test('targeted send with no known endpoint warns once, not per packet (#91)', async () => {
  const warns = [];
  const { connection, dg } = build(
    {},
    { logger: { warn: (m) => warns.push(m), info() {}, error() {} } }
  );
  await connection.start();

  const opts = { band: BAND.CONTROL, target: { sysid: 9, compid: 9 } };
  connection.send({ name: 'COMMAND_LONG', fields: {} }, opts);
  await delay(20);
  connection.send({ name: 'COMMAND_LONG', fields: {} }, opts);
  await delay(20);

  assert.equal(
    warns.filter((m) => /no known endpoint for target 9\/9/.test(m)).length,
    1,
    'the fallback is loud exactly once per unresolved target'
  );
  assert.equal(dg.sockets[0].sent.length, 2, 'the frames still go out via the configured remote');
  connection.close();
});

test('a transport error stops heartbeats but keeps the peer sweep alive (#93)', async () => {
  const { connection, dg, timers } = build(
    {},
    { logger: { warn() {}, info() {}, error() {} } }
  );
  await connection.start();
  // Learned while the link was up — the outage must not forget it, and the
  // sweep must still expire it. (Learned before the error because reconnect
  // detaches the dead transport; nothing arrives through it afterwards.)
  introducePeer(dg);
  const running = timers.active();
  assert.ok(running >= 2, 'heartbeat and sweep timers run while connected');

  dg.sockets[0].emit('error', new Error('boom'));

  assert.equal(connection.getState(), STATE.RECONNECTING);
  assert.equal(
    timers.active(),
    running - 1,
    'only the heartbeat scheduler stops — the sweep must keep driving '
      + 'stale/expired transitions, which mavlink-state consumes while the link is down'
  );
  // The "vehicle lost" signal still fires on a dead link: sweeping past
  // expireMs must still transition and emit for a known peer.
  const events = [];
  connection.peerTable.on('expired', (e) => events.push(e));
  connection.peerTable.sweep(Date.now() + 60000);
  assert.equal(events.length, 1, 'expiry still emits while the transport is down');
  connection.close();
});

test('the fallback warning re-arms when the endpoint is learned, not only on send (#91)', async () => {
  // warn → endpoint learned (no send in between) → endpoint lost → the next
  // fallback must warn again. The re-arm rides peer-table endpoint-added, so
  // a resolve/expire cycle with no intervening targeted send cannot leave the
  // warning permanently disarmed.
  const warns = [];
  const { connection, dg } = build(
    {},
    { logger: { warn: (m) => warns.push(m), info() {}, error() {} } }
  );
  await connection.start();

  const opts = { band: BAND.CONTROL, target: { sysid: 7, compid: 1 } };
  connection.send({ name: 'COMMAND_LONG', fields: {} }, opts);
  await delay(20); // warns: endpoint unknown

  introducePeer(dg); // endpoint learned — clears the warned flag via the event
  connection.peerTable.markPrimaryFailed(7, 1); // sole endpoint drops again

  connection.send({ name: 'COMMAND_LONG', fields: {} }, opts);
  await delay(20);

  assert.equal(
    warns.filter((m) => /no known endpoint for target 7\/1/.test(m)).length,
    2,
    'losing the endpoint after learning it must re-enable the warning'
  );
  connection.close();
});

test('broadcast target (sysid 0) never triggers the missing-endpoint warning (#91)', async () => {
  const warns = [];
  const { connection } = build(
    {},
    { logger: { warn: (m) => warns.push(m), info() {}, error() {} } }
  );
  await connection.start();
  connection.send(
    { name: 'COMMAND_LONG', fields: {} },
    { band: BAND.CONTROL, target: { sysid: 0, compid: 1 } }
  );
  await delay(20);
  assert.equal(
    warns.filter((m) => /no known endpoint/.test(m)).length,
    0,
    'before any peer is heard, the configured remote is the only path'
  );
  connection.close();
});

/**
 * `target_system = 0` reaches everyone by itself only on a shared medium. The
 * SITL lab's ArduPilot `udpclient` topology is a star — every vehicle dials in
 * and owns a return path — so one datagram to the configured remote reached
 * nobody: measured zero COMMAND_ACKs with all five vehicles left disarmed,
 * while directed arms to the same peers worked.
 */
function hearFrom(socket, peers) {
  for (const [sysid, port, compid = 1] of peers) {
    socket.receive(
      frameBuffer({
        name: 'HEARTBEAT',
        sysid,
        compid,
        fields: { type: 2, autopilot: 3, base_mode: 0, custom_mode: 0, system_status: 3 },
      }),
      { address: '10.0.0.5', port }
    );
  }
}

function commandDatagrams(socket) {
  return socket.sent.filter((entry) => {
    try {
      return JSON.parse(entry.buffer.toString()).name === 'COMMAND_LONG';
    } catch {
      return false;
    }
  });
}

function broadcastArm(connection) {
  connection.send(
    { name: 'COMMAND_LONG', fields: { target_system: 0, command: 400 } },
    { band: BAND.CONTROL, target: { sysid: 0, compid: 1 } }
  );
}

test('a broadcast is written once per learned peer endpoint', async () => {
  const { connection, dg } = build();
  await connection.start();
  const socket = dg.sockets[0];
  hearFrom(socket, [[1, 40001], [2, 40002], [3, 40003]]);

  broadcastArm(connection);
  await delay(40);

  const sends = commandDatagrams(socket);
  assert.equal(sends.length, 3, 'one datagram per vehicle, not one to the configured remote');
  assert.deepEqual(sends.map((s) => s.port).sort((a, b) => a - b), [40001, 40002, 40003]);
  // One frame, many envelopes: every copy still says target_system 0, so a
  // vehicle that also sees a neighbour's copy treats it as addressed to it.
  for (const send of sends) {
    assert.equal(JSON.parse(send.buffer.toString()).fields.target_system, 0);
  }
  connection.close();
});

test('a broadcast crosses the wire once per endpoint, not once per component', async () => {
  // A gimbal and an autopilot on one airframe answer from the same UDP return
  // path. The broadcast addresses compid 1, and the endpoint is deduped
  // regardless, so the vehicle gets one datagram.
  const { connection, dg } = build();
  await connection.start();
  const socket = dg.sockets[0];
  hearFrom(socket, [[7, 40007, 1], [7, 40007, 154], [8, 40008, 1]]);

  broadcastArm(connection);
  await delay(40);

  const sends = commandDatagrams(socket);
  assert.deepEqual(sends.map((s) => s.port).sort((a, b) => a - b), [40007, 40008]);
  connection.close();
});

test('a broadcast with no peers still rides the configured remote', async () => {
  // The pre-peer path has to survive: a fan-out issued before any heartbeat
  // arrives must not silently write to nowhere.
  const { connection, dg } = build();
  await connection.start();
  const socket = dg.sockets[0];

  broadcastArm(connection);
  await delay(40);

  const sends = commandDatagrams(socket);
  assert.equal(sends.length, 1, 'exactly one send, to the transport default');
  assert.equal(sends[0].port, 14555, 'the configured remotePort');
  connection.close();
});

test('the queue keeps draining after a broadcast fans out', async () => {
  // Every destination reports before the item is done. Miscounting would leave
  // _draining stuck true and wedge the queue — heartbeats included.
  const { connection, dg } = build();
  await connection.start();
  const socket = dg.sockets[0];
  hearFrom(socket, [[1, 40001], [2, 40002]]);

  broadcastArm(connection);
  broadcastArm(connection);
  await delay(60);

  assert.equal(commandDatagrams(socket).length, 4, 'both broadcasts fanned out');
  connection.close();
});

test('a heartbeat tick is written once per learned peer primary — one frame, N datagrams', async () => {
  // A HEARTBEAT has no target fields and is addressed to everyone, so it rides
  // the same 14.63 ladder as a target_system 0 command: on a dialed-in star,
  // one datagram to the configured remote reaches only that remote, and every
  // other vehicle trips its GCS-loss failsafe.
  const wire = fakeWire();
  const realSerialize = wire.serialize;
  let serializes = 0;
  wire.serialize = (message, ctx) => {
    serializes += 1;
    return realSerialize(message, ctx);
  };
  const { connection, dg } = build({}, { wire });
  await connection.start();
  const socket = dg.sockets[0];
  hearFrom(socket, [[1, 40001], [2, 40002], [3, 40003]]);

  connection.heartbeats.tick();
  await delay(40);

  const sends = socket.sent.filter(
    (s) => JSON.parse(s.buffer.toString()).name === 'HEARTBEAT'
  );
  assert.equal(sends.length, 3, 'one datagram per learned peer, not one to the configured remote');
  assert.deepEqual(sends.map((s) => s.port).sort((a, b) => a - b), [40001, 40002, 40003]);
  assert.equal(serializes, 1, 'one frame serialized — N datagrams carry one sequence number');
  connection.close();
});

test('a learned system with no autopilot component still hears the heartbeat', async () => {
  // The broadcast target's compid 0 is MAV_COMP_ID_ALL: a HEARTBEAT names no
  // component, so a companion computer or second GCS — a learned system with
  // no component 1 — is a peer like any other. A component-1-only lookup
  // starves it, and the nonempty learned list suppresses the configured-remote
  // fallback that would otherwise have reached it. Sysid 7's two components
  // share one endpoint and still get a single datagram.
  const { connection, dg } = build();
  await connection.start();
  const socket = dg.sockets[0];
  hearFrom(socket, [[1, 40001], [7, 40007, 1], [7, 40007, 154], [30, 40030, 191]]);

  connection.heartbeats.tick();
  await delay(40);

  const ports = socket.sent
    .filter((s) => JSON.parse(s.buffer.toString()).name === 'HEARTBEAT')
    .map((s) => s.port)
    .sort((a, b) => a - b);
  assert.deepEqual(ports, [40001, 40007, 40030]);
  connection.close();
});

/**
 * Swarm delivery (DESIGN.md §14 "A swarm address is delivery, not addressing").
 *
 * A configured multicast group or broadcast address means the network itself
 * does the fan-out, so one write is both correct and the entire reason to
 * configure one. It outranks the per-peer fan-out; it never touches directed
 * traffic.
 */
function swarmBuild(broadcast) {
  return build({
    transport: {
      mode: 'udp',
      bindAddress: '0.0.0.0',
      bindPort: 14550,
      remoteAddress: '10.0.0.9',
      remotePort: 14555,
      ...broadcast,
    },
  });
}

test('a configured swarm address collapses the fan-out to one write', async () => {
  const { connection, dg } = swarmBuild({ broadcastAddress: '239.255.145.50' });
  await connection.start();
  const socket = dg.sockets[0];
  hearFrom(socket, [[1, 40001], [2, 40002], [3, 40003]]);

  broadcastArm(connection);
  await delay(40);

  const sends = commandDatagrams(socket);
  assert.equal(sends.length, 1, 'three peers, one datagram — the group does the fan-out');
  assert.equal(sends[0].address, '239.255.145.50');
  assert.equal(sends[0].port, 14550, 'the group speaks on the port we joined');
});

test('a swarm address never captures directed traffic', async () => {
  const { connection, dg } = swarmBuild({ broadcastAddress: '255.255.255.255' });
  await connection.start();
  const socket = dg.sockets[0];
  hearFrom(socket, [[1, 40001], [2, 40002]]);

  connection.send(
    { name: 'COMMAND_LONG', fields: { target_system: 2, command: 400 } },
    { band: BAND.CONTROL, target: { sysid: 2, compid: 1 } }
  );
  await delay(40);

  const sends = commandDatagrams(socket);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].port, 40002, 'addressed to sysid 2 means sysid 2, not the whole swarm');
  assert.notEqual(sends[0].address, '255.255.255.255');
});

test('a swarm address works before any peer is heard', async () => {
  // The fan-out has nothing to fan to yet; the group does not care.
  const { connection, dg } = swarmBuild({ broadcastAddress: '239.255.145.50' });
  await connection.start();
  const socket = dg.sockets[0];

  broadcastArm(connection);
  await delay(40);

  const sends = commandDatagrams(socket);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].address, '239.255.145.50', 'not the configured remote');
});

test('a frame stamped with a bound identity is our own echo — dropped before the peer table', async () => {
  // Multicast loopback returns our own transmissions: with loopback at the OS
  // default, every frame we write to the group comes straight back. A
  // component does not treat its own frames as peer traffic.
  const { connection, dg } = build();
  await connection.start();
  const received = [];
  connection.subscribe(null, (m) => received.push(m));

  dg.sockets[0].receive(
    frameBuffer({ name: 'COMMAND_LONG', sysid: 255, compid: 190, fields: { command: 400 } }),
    { address: '239.255.145.50', port: 14550 }
  );

  assert.equal(received.length, 0, 'our own echo never reaches a subscriber');
  assert.equal(connection.peerTable.getComponent(255, 190), undefined, 'and never becomes a peer');
  connection.close();
});

test('a companion sharing our sysid under another compid is a real peer, not an echo', async () => {
  // The filter is the exact (sysid, compid) pair — same-system components are
  // ordinary MAVLink neighbours and must keep flowing.
  const { connection, dg } = build();
  await connection.start();
  const received = [];
  connection.subscribe(null, (m) => received.push(m));

  dg.sockets[0].receive(
    frameBuffer({ name: 'HEARTBEAT', sysid: 255, compid: 191, fields: { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 } }),
    { address: '10.0.0.5', port: 14550 }
  );

  assert.equal(received.length, 1, 'same sysid, different compid still dispatches');
  assert.ok(connection.peerTable.getComponent(255, 191), 'and enters the peer table');
  connection.close();
});

// ── issue #244: per-write timeout on the outbound pump ───────────────────────

const { WRITE_TIMEOUT_MS } = require('../../lib/connection/runtime');

/**
 * A transport whose writes are accepted but never complete — the callbacks are
 * captured for the test to (mis)fire — plus captured one-shot timers so the
 * write timeout is driven explicitly instead of waiting wall-clock seconds.
 *
 * @returns {{connection: Connection, sent: Buffer[], writeCallbacks: Function[],
 *   timeouts: object[], errors: string[], timers: object}}
 */
function hangingWriteBuild() {
  const { EventEmitter } = require('node:events');
  const sent = [];
  const writeCallbacks = [];
  const timeouts = [];
  const errors = [];
  const timers = fakeTimers();
  const transportFactory = () => {
    const t = new EventEmitter();
    t.mode = 'udp';
    t.open = async () => {};
    t.close = (cb) => cb && cb();
    t.send = (buffer, _endpoint, cb) => {
      sent.push(buffer);
      writeCallbacks.push(cb);
    };
    return t;
  };
  const { connection } = build(
    {},
    {
      transportFactory,
      logger: { info() {}, warn() {}, error: (m) => errors.push(m) },
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: (fn, ms) => {
        const handle = { fn, ms, cleared: false, unref() {} };
        timeouts.push(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        if (handle) handle.cleared = true;
      },
    }
  );
  return { connection, sent, writeCallbacks, timeouts, errors, timers };
}

test('a stuck transport write faults the link within the documented bound (#244)', async () => {
  const { connection, timeouts, errors } = hangingWriteBuild();
  await connection.start();
  const transportErrors = [];
  connection.on('transport-error', (err) => transportErrors.push(err));

  connection.send({ name: 'COMMAND_LONG', fields: {} }, { band: BAND.CONTROL });

  const timer = timeouts.find((t) => t.ms === WRITE_TIMEOUT_MS);
  assert.ok(timer, 'every in-flight write is covered by one timer at the module bound');
  assert.equal(WRITE_TIMEOUT_MS, 5000, 'the bound stays order-of-seconds');

  timer.fn(); // the write never completed — the bound expires

  assert.equal(
    connection.getState(),
    STATE.RECONNECTING,
    'the wedge faults the link into the recovery loop'
  );
  assert.equal(transportErrors.length, 1);
  assert.equal(transportErrors[0].code, 'WRITE_TIMEOUT');
  assert.ok(
    errors.some((m) => /timed out after 5000ms/.test(m)),
    'the log names the timeout and rides the existing transport-error path'
  );
  assert.ok(
    timeouts.some((t) => t.ms !== WRITE_TIMEOUT_MS && !t.cleared),
    'a redial timer is armed for the wedged link'
  );
  connection.close();
});

test('a late completion callback after expiry is inert (#244)', async () => {
  const { connection, sent, writeCallbacks, timeouts, errors } = hangingWriteBuild();
  await connection.start();

  connection.send({ name: 'COMMAND_LONG', fields: {} }, { band: BAND.CONTROL });
  connection.send({ name: 'PARAM_SET', fields: {} }, { band: BAND.CONTROL });
  assert.equal(sent.length, 1, 'the second item queues behind the stuck write');

  timeouts.find((t) => t.ms === WRITE_TIMEOUT_MS).fn();
  const errorCount = errors.length;

  // The transport finally answers, long after the link was declared dead.
  writeCallbacks[0]();

  assert.equal(sent.length, 1, 'a late completion must not restart the pump into a faulted link');
  assert.equal(connection.getState(), STATE.RECONNECTING, 'the fault is not un-declared');
  assert.equal(errors.length, errorCount, 'no second fault, no double bookkeeping');
  connection.close();
});

test('a completing write disarms its timer and the pump keeps draining (#244)', async () => {
  const { connection, sent, writeCallbacks, timeouts } = hangingWriteBuild();
  await connection.start();

  connection.send({ name: 'COMMAND_LONG', fields: {} }, { band: BAND.CONTROL });
  const timer = timeouts.find((t) => t.ms === WRITE_TIMEOUT_MS);
  writeCallbacks[0](); // healthy completion inside the bound

  assert.equal(timer.cleared, true, 'the healthy path leaves no armed timer behind');
  assert.equal(connection.getState(), STATE.CONNECTED);

  connection.send({ name: 'PARAM_SET', fields: {} }, { band: BAND.CONTROL });
  assert.equal(sent.length, 2, 'the release still dequeues the next item');
  connection.close();
});

test('heartbeats fail with the wedged link — the fault stops the scheduler (#244)', async () => {
  // Deliberate: heartbeats ride the same queue as everything else, so a wedged
  // link stops them via the same fault → heartbeats.stop() path a socket error
  // takes (#93); going quiet is the signal every other participant reads, and
  // they resume only when the redial loop actually restores the link.
  const { connection, timeouts, timers } = hangingWriteBuild();
  await connection.start();
  const running = timers.active();
  assert.ok(running >= 2, 'heartbeat and sweep timers run while connected');

  connection.send({ name: 'COMMAND_LONG', fields: {} }, { band: BAND.CONTROL });
  timeouts.find((t) => t.ms === WRITE_TIMEOUT_MS).fn();

  assert.equal(
    timers.active(),
    running - 1,
    'only the heartbeat scheduler stops — the sweep keeps driving stale/expired'
  );
  connection.close();
});

test('close() disarms a pending write timer (#244)', async () => {
  const { connection, timeouts } = hangingWriteBuild();
  await connection.start();

  connection.send({ name: 'COMMAND_LONG', fields: {} }, { band: BAND.CONTROL });
  const timer = timeouts.find((t) => t.ms === WRITE_TIMEOUT_MS);
  connection.close();

  assert.equal(timer.cleared, true, 'teardown must not leave a timer that flips CLOSED to ERROR');
  assert.equal(connection.getState(), STATE.CLOSED);
});

// ── link recovery: a dropped link redials itself with jittered backoff ───────

const { EventEmitter } = require('node:events');
const { RECONNECT_BASE_MS, RECONNECT_CAP_MS } = require('../../lib/connection/runtime');

/**
 * A deterministic reconnect harness: stub transports from an injected factory
 * (newest last in `transports`), captured timeouts fired by hand, and
 * `random: () => 0` so every backoff delay sits at its ceiling/2 floor.
 *
 * @param {object} [options]
 * @param {number} [options.openFailures]  how many opens (after the first,
 *   which always succeeds) reject before one succeeds
 * @param {boolean} [options.failFirstOpen]  the deploy-time open itself fails,
 *   emitting a transport error first the way a real bind failure does
 * @param {boolean} [options.holdRedialOpen]  redial opens hang until the test
 *   releases them via `releaseHeldOpen()` — for close-vs-open races
 * @returns {object}
 */
function reconnectBuild({ openFailures = 0, failFirstOpen = false, holdRedialOpen = false } = {}) {
  const transports = [];
  const timeouts = [];
  const warns = [];
  const infos = [];
  const heldOpens = [];
  let opens = 0;
  const transportFactory = () => {
    const transport = new EventEmitter();
    transport.mode = 'udp';
    transport.sent = [];
    transport.closed = false;
    transport.open = () => {
      opens += 1;
      if (opens === 1 && failFirstOpen) {
        // A real bind failure (EADDRINUSE, missing device) emits the transport
        // error event and rejects the open — mimic both.
        const err = new Error('EADDRINUSE');
        transport.emit('error', err);
        return Promise.reject(err);
      }
      // The first open is the deploy-time one; the next `openFailures` redials
      // find the link still down.
      if (opens > 1 && opens <= 1 + openFailures) {
        return Promise.reject(new Error('still down'));
      }
      if (opens > 1 && holdRedialOpen) {
        return new Promise((resolve) => heldOpens.push(resolve));
      }
      return Promise.resolve();
    };
    transport.send = (buffer, endpoint, callback) => {
      transport.sent.push(buffer);
      callback();
    };
    transport.close = (callback) => {
      transport.closed = true;
      if (callback) callback();
    };
    transports.push(transport);
    return transport;
  };
  const timers = fakeTimers();
  let cleared = 0;
  const wire = fakeWire();
  wire.clearDecoders = () => { cleared += 1; };
  const connection = new Connection(
    {
      transport: { mode: 'udp', bindAddress: '0.0.0.0', bindPort: 14550 },
      vehicle: { targetSystem: 1, targetComponent: 1, autopilot: 3 },
      identities: [GCS],
      defaultIdentityId: 'gcs',
      boundIdentityIds: ['gcs'],
      signing: { linkId: 0, signOutbound: false, requireSigned: false, acceptInvalid: false, hasKey: false },
      heartbeat: { intervalMs: 1000, staleMs: 5000, expireMs: 15000 },
    },
    {
      transportFactory,
      wire,
      resolveIdentity,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: (fn, ms) => {
        const handle = { fn, ms, cleared: false, unref() {} };
        timeouts.push(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        if (handle) handle.cleared = true;
      },
      random: () => 0,
      logger: { warn: (m) => warns.push(m), info: (m) => infos.push(m), error() {} },
    }
  );
  return {
    connection,
    transports,
    timeouts,
    timers,
    warns,
    infos,
    decodersCleared: () => cleared,
    redials: () => timeouts.filter((t) => t.ms !== WRITE_TIMEOUT_MS),
    releaseHeldOpen: () => heldOpens.shift()(),
  };
}

test('a dropped link redials itself and resumes the full runtime', async () => {
  const { connection, transports, timers, decodersCleared, redials } = reconnectBuild();
  await connection.start();
  const running = timers.active();

  transports[0].emit('error', new Error('link down'));

  assert.equal(connection.getState(), STATE.RECONNECTING);
  assert.equal(transports[0].closed, true, 'the dead transport is released, not leaked');
  assert.equal(decodersCleared(), 1, 'stream decoders reset — a reconnected peer must not inherit a dead stream’s partial frame');
  const [redial] = redials();
  assert.equal(redial.ms, RECONNECT_BASE_MS / 2, 'random()=0 pins the first delay at its ceiling/2 floor');

  // Accepted during the outage: enqueued, and its ack waiter would have
  // reported timed-out long before the link returns.
  connection.send({ name: 'COMMAND_LONG', fields: {} }, { band: BAND.CONTROL });
  assert.equal(transports.length, 1, 'nothing dialed before the timer fires');

  redial.fn();
  await delay(0); // let the open() promise settle

  assert.equal(connection.getState(), STATE.CONNECTED);
  assert.equal(transports.length, 2, 'recovery dialed a fresh transport from the same bound config');
  assert.equal(timers.active(), running, 'heartbeats restart with the link');
  // Owner ruling (2026-08-18): recovery resumes live traffic, never stale
  // intent. The queue's ageing only ever *promotes* items — nothing expires —
  // so without this clear an arm/goto accepted during an hour-long outage
  // would drive the vehicle on return, after its sender was already told it
  // failed.
  assert.equal(transports[1].sent.length, 0, 'nothing queued against the dead link replays');
  connection.send({ name: 'COMMAND_LONG', fields: {} }, { band: BAND.CONTROL });
  assert.equal(transports[1].sent.length, 1, 'live traffic flows the moment the link is back');
  connection.close();
});

test('failed redials back off exponentially to the cap, and success resets the schedule', async () => {
  const { connection, transports, warns, redials } = reconnectBuild({ openFailures: 6 });
  await connection.start();

  transports[0].emit('error', new Error('link down'));
  // Six failed opens then one success: fire each redial as it is armed.
  for (let i = 0; i < 7; i++) {
    const pending = redials().filter((t) => !t.fired);
    assert.equal(pending.length, 1, 'exactly one redial in flight at a time');
    pending[0].fired = true;
    pending[0].fn();
    await delay(0);
  }

  assert.equal(connection.getState(), STATE.CONNECTED);
  assert.deepEqual(
    redials().map((t) => t.ms),
    [500, 1000, 2000, 4000, 8000, 15000, 15000],
    'ceilings double from RECONNECT_BASE_MS and clamp at RECONNECT_CAP_MS (half-jitter floor with random()=0)'
  );
  assert.equal(RECONNECT_CAP_MS, 30_000, 'the cap stays order-of-tens-of-seconds');

  // A later drop starts the schedule over: the counter reset on success.
  transports[transports.length - 1].emit('error', new Error('down again'));
  const again = redials()[redials().length - 1];
  assert.equal(again.ms, RECONNECT_BASE_MS / 2, 'backoff resets after a successful recovery');
  assert.ok(
    warns.some((m) => /reconnecting in 500ms \(attempt 1\)/.test(m)),
    'the log names the delay and the attempt'
  );
  connection.close();
});

test('a late error from the detached dead transport is silenced, not fatal', async () => {
  // Codex (#334): removeAllListeners() would strip the corpse's only 'error'
  // listener while its socket is still closing — and all three wrappers keep
  // forwarding underlying errors, so the next one would throw from an
  // unheard EventEmitter 'error' and take Node-RED with it (§2).
  const { connection, transports, redials } = reconnectBuild();
  await connection.start();
  transports[0].emit('error', new Error('link down'));
  assert.equal(redials().length, 1);

  // The corpse coughs again mid-close. Without the sink this line throws.
  transports[0].emit('error', new Error('late ECONNRESET'));

  assert.equal(redials().length, 1, 'the late error neither crashes nor double-schedules');
  assert.equal(connection.getState(), STATE.RECONNECTING);
  connection.close();
});

test('close during the backoff wait cancels the redial — redeploy wins over recovery', async () => {
  const { connection, transports, redials } = reconnectBuild();
  await connection.start();
  transports[0].emit('error', new Error('link down'));
  const [redial] = redials();

  let done = false;
  connection.close(() => { done = true; });

  assert.equal(done, true);
  assert.equal(redial.cleared, true, 'the pending redial is disarmed');
  assert.equal(connection.getState(), STATE.CLOSED);
  assert.equal(transports.length, 1, 'nothing dials after teardown');
});

test('close during an in-flight redial open still wins — the late success cannot resurrect the link', async () => {
  // The backoff-wait race is pinned above; this is the other window the
  // implementation codes for (Sourcery): close() lands while a redial's
  // open() is already in flight, and the open then *succeeds* — after the
  // operator tore the connection down.
  const { connection, transports, redials, releaseHeldOpen, timers } = reconnectBuild({
    holdRedialOpen: true,
  });
  await connection.start();
  transports[0].emit('error', new Error('link down'));

  redials()[0].fn(); // _attemptReconnect starts; its open() now hangs
  assert.equal(transports.length, 2, 'the redial dialed a fresh transport');

  let done = false;
  connection.close(() => { done = true; });
  assert.equal(done, true);

  releaseHeldOpen(); // the open finally succeeds — after close won
  await delay(0);

  assert.equal(connection.getState(), STATE.CLOSED, 'the late open cannot leave CLOSED');
  assert.equal(transports[1].closed, true, 'the freshly-opened transport is closed, not leaked');
  assert.equal(redials().length, 1, 'no further redial is armed after teardown');
  assert.equal(timers.active(), 0, 'heartbeats and sweep stay down');
  assert.equal(transports[1].sent.length, 0, 'nothing pumps on the resurrected socket');
});

test('an error while a redial open() settles does not let the stale continuation declare recovery', async () => {
  // CodeRabbit (#334): open() can resolve and the transport error in the same
  // tick, before the awaited continuation runs. _onTransportError then nulls
  // this._transport and arms the next redial — so the continuation must
  // recognise it has been superseded. Without the identity check it would
  // reset the backoff, declare CONNECTED, and restart heartbeats whose first
  // tick pumps into a null transport: a TypeError inside a timer callback,
  // the §2 process-kill.
  const { connection, transports, redials, releaseHeldOpen, timers } = reconnectBuild({
    holdRedialOpen: true,
  });
  await connection.start();
  const heartbeatsDown = () => timers.active();
  transports[0].emit('error', new Error('link down'));
  const downTimers = heartbeatsDown();

  redials()[0].fn(); // attempt starts; its open() hangs
  const inFlight = transports[1];
  inFlight.emit('error', new Error('died while opening')); // lands mid-open

  assert.equal(redials().length, 2, 'the mid-open error armed the next redial');
  assert.equal(redials()[1].ms, RECONNECT_BASE_MS, 'backoff kept growing — ceiling doubled to 2s, half-jitter floor 1s');

  releaseHeldOpen(); // the doomed open() then resolves anyway
  await delay(0);

  assert.equal(connection.getState(), STATE.RECONNECTING, 'the stale continuation cannot declare CONNECTED');
  assert.equal(inFlight.closed, true, 'the superseded transport is closed, not leaked');
  assert.equal(redials()[1].cleared, false, 'the replacement redial remains armed — recovery has an owner');
  assert.equal(timers.active(), downTimers, 'heartbeats stay down — recovery belongs to the armed redial');
  connection.close();
});

test('a transport that never opened does not enter the redial loop — deploy failures stay loud', async () => {
  const { connection, redials } = reconnectBuild({ failFirstOpen: true });

  await assert.rejects(() => connection.start(), /EADDRINUSE/);
  assert.equal(connection.getState(), STATE.ERROR, 'pre-establishment errors stay terminal (§2)');
  assert.equal(redials().length, 0, 'no redial is ever armed for a config that never worked');
});

// ── health leases: flow-asserted health with an expiring countdown ───────────

/**
 * Lease harness: a transport whose writes complete synchronously (so emitted
 * heartbeats are countable in `sent`), captured one-shot timers fired by hand,
 * and a controllable clock so heartbeat ticks clear the per-identity rate gate.
 * `leases()` excludes write timers by their module bound — lease TTLs in these
 * tests deliberately avoid WRITE_TIMEOUT_MS.
 *
 * @returns {{connection: Connection, clock: object, leases: Function,
 *   heartbeatsSent: Function}}
 */
function healthBuild() {
  const sent = [];
  const timeouts = [];
  const clock = fakeClock(1000);
  const timers = fakeTimers();
  const transportFactory = () => {
    const t = new EventEmitter();
    t.mode = 'udp';
    t.open = async () => {};
    t.close = (cb) => cb && cb();
    t.send = (buffer, _endpoint, cb) => {
      sent.push(buffer);
      cb();
    };
    return t;
  };
  const { connection } = build(
    {},
    {
      transportFactory,
      now: clock.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: (fn, ms) => {
        const handle = { fn, ms, cleared: false, unref() {} };
        timeouts.push(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        if (handle) handle.cleared = true;
      },
    }
  );
  return {
    connection,
    clock,
    leases: () => timeouts.filter((t) => t.ms !== WRITE_TIMEOUT_MS),
    heartbeatsSent: () =>
      sent.filter((b) => JSON.parse(b.toString()).name === 'HEARTBEAT').length,
  };
}

test('health lease lifecycle: ok arms, renewal replaces, expiry faults and emits, fatal cancels, a later ok resumes', async () => {
  const { connection, clock, leases, heartbeatsSent } = healthBuild();
  await connection.start();
  const expired = [];
  connection.on('health-expired', (e) => expired.push(e.identityId));

  connection.assertHealth('gcs', true, 4000);
  assert.equal(leases().length, 1, 'ok arms one countdown');
  assert.equal(leases()[0].ms, 4000);

  connection.assertHealth('gcs', true, 4000);
  const [first, second] = leases();
  assert.equal(first.cleared, true, 'renewal disarms the replaced countdown');
  assert.equal(second.cleared, false);
  assert.deepEqual(expired, [], 'a renewed lease never expires');

  connection.heartbeats.tick();
  assert.equal(heartbeatsSent(), 1, 'a leased identity heartbeats');

  second.fn(); // the flow went quiet — the countdown fires
  assert.deepEqual(expired, ['gcs'], 'the lapse emits health-expired');
  clock.advance(1000);
  connection.heartbeats.tick();
  assert.equal(heartbeatsSent(), 1, 'a lapsed lease suppresses the heartbeat');

  connection.assertHealth('gcs', true, 3000);
  const renewed = leases().find((t) => t.ms === 3000);
  assert.equal(renewed.cleared, false, 'a later ok opens a fresh countdown');
  clock.advance(1000);
  connection.heartbeats.tick();
  assert.equal(heartbeatsSent(), 2, 'the later ok clears the fault and the heartbeat resumes');

  connection.assertHealth('gcs', false, 0);
  assert.equal(renewed.cleared, true, 'fatal drops the pending countdown');
  clock.advance(1000);
  connection.heartbeats.tick();
  assert.equal(heartbeatsSent(), 2, 'fatal suppresses the heartbeat immediately');
  assert.deepEqual(expired, ['gcs'], 'explicit assertions never emit — only the timer path does');

  connection.close();
});

test('close() disarms pending health leases — no fault, no emit after teardown', async () => {
  const { connection, leases } = healthBuild();
  await connection.start();
  const expired = [];
  connection.on('health-expired', (e) => expired.push(e));

  connection.assertHealth('gcs', true, 4000);
  const [lease] = leases();
  connection.close();

  assert.equal(lease.cleared, true, 'teardown disarms the countdown');
  assert.deepEqual(expired, [], 'nothing expires after close');
  // A silent return here would let the asserting node report `healthy` for a
  // lease that was never armed — the refusal is what keeps that report honest.
  assert.throws(
    () => connection.assertHealth('gcs', true, 4000),
    /closed connection/,
    'an assertion racing teardown refuses loud instead of arming nothing'
  );
  assert.equal(leases().length, 1, 'and no timer was armed on the closed link');
});

test('assertHealth on an unbound identity is loud — no healthy no-op', async () => {
  const { connection } = healthBuild();
  await connection.start();
  assert.throws(
    () => connection.assertHealth('loose', true, 4000),
    /not bound/,
    'a lease on an id this Connection does not heartbeat would report healthy over a no-op'
  );
  connection.close();
});
