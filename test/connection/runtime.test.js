'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Connection, STATE } = require('../../lib/connection');
const { BAND } = require('../../lib/connection/bands');
const { mockDgram, fakeWire, frameBuffer, fakeTimers, fakeClock } = require('./helpers');

const GCS = { id: 'gcs', sysid: 255, compid: 190, heartbeat: { type: 6, autopilot: 8, systemStatus: 4 } };

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
    vehicle: { targetSysid: 1, targetCompid: 1, autopilot: 3 },
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
  const heartbeat = dg.sockets[0].sent
    .map((s) => JSON.parse(s.buffer.toString()))
    .find((f) => f.name === 'HEARTBEAT');
  assert.ok(heartbeat);
  assert.equal(heartbeat.sysid, 255);
  assert.equal(heartbeat.compid, 190);
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

test('partial UDP remote config still warns (incomplete destination is a misconfig)', async () => {
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
  assert.ok(
    warns.some((m) => /incomplete destination/i.test(m)),
    'half-configured remote must still warn'
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

test('an identity override outside the bound set is rejected, never falling back', async () => {
  const { connection } = build();
  await connection.start();
  assert.throws(() => connection.send({ name: 'PING', fields: {} }, { identityId: 'ghost' }), /not bound/);
  connection.close();
});
