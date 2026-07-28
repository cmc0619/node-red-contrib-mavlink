'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { Connection } = require('../../lib/connection');
const { BAND } = require('../../lib/connection/bands');
const { UdpTransport } = require('../../lib/connection/transport/udp');
const { TcpTransport } = require('../../lib/connection/transport/tcp');
const { mockDgram, fakeWire, fakeTimers, fakeClock } = require('./helpers');
const { markSocket, tosFromDscp } = require('../../lib/connection/dscp');

const GCS = {
  id: 'gcs',
  sysid: 255,
  compid: 190,
  heartbeat: { type: 6, autopilot: 8, systemStatus: 4 },
};

/** @returns {Promise<void>} */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param {object} input
 * @returns {{identityId: string, source: string}}
 */
function resolveIdentity(input) {
  return { identityId: input.overrideId || input.defaultIdentityId, source: 'test' };
}

class FakeTransport extends EventEmitter {
  /** @param {Array<string>} events */
  constructor(events) {
    super();
    this.mode = 'udp';
    this.events = events;
  }

  open() {
    return Promise.resolve();
  }

  /**
   * @param {number} dscp
   * @param {{address: string, port: number}|null} endpoint
   */
  setDscp(dscp, endpoint) {
    this.events.push(`mark:${dscp}:${endpoint ? endpoint.address : 'default'}`);
    return true;
  }

  /**
   * @param {Buffer} buffer
   * @param {{address: string, port: number}|null} endpoint
   * @param {(err?: Error) => void} callback
   */
  send(buffer, endpoint, callback) {
    const frame = JSON.parse(buffer.toString());
    this.events.push(`send:${frame.name}:${endpoint ? endpoint.address : 'default'}`);
    setTimeout(() => callback(), 0);
  }

  /** @param {() => void} callback */
  close(callback) {
    callback();
  }
}

test('tosFromDscp shifts the six-bit DSCP value into the TOS byte', () => {
  assert.equal(tosFromDscp(46), 184);
  assert.equal(tosFromDscp(40), 160);
  assert.equal(tosFromDscp(10), 40);
  assert.throws(() => tosFromDscp(-1), /DSCP/);
  assert.throws(() => tosFromDscp(64), /DSCP/);
  assert.throws(() => tosFromDscp(12.5), /DSCP/);
});

test('markSocket uses an injected marker and passes the computed TOS byte', () => {
  const socket = { id: 'socket' };
  const calls = [];

  const marked = markSocket(socket, 34, {
    family: 'ipv4',
    marker: (markedSocket, tos, options) => {
      calls.push({ socket: markedSocket, tos, family: options.family });
      return true;
    },
  });

  assert.equal(marked, true);
  assert.deepEqual(calls, [{ socket, tos: 136, family: 'ipv4' }]);
});

test('markSocket soft-fails and warns once when no marker is available', () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };

  assert.equal(markSocket({}, 46, { marker: false, logger }), false);
  assert.equal(markSocket({}, 40, { marker: false, logger }), false);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /DSCP marking unavailable/);
});

test('UDP transport setDscp marks the live socket without sending data', async () => {
  const dg = mockDgram();
  const calls = [];
  const transport = new UdpTransport(
    { bindPort: 14550, remoteAddress: '10.0.0.9', remotePort: 14555 },
    {
      dgram: dg.module,
      markDscp: (socket, dscp, options) => {
        calls.push({ socket, dscp, family: options.family });
        return true;
      },
    }
  );

  await transport.open();

  assert.equal(transport.setDscp(46), true);
  assert.deepEqual(calls, [{ socket: dg.sockets[0], dscp: 46, family: 'ipv4' }]);
  assert.equal(dg.sockets[0].sent.length, 0);
});

test('UDP transport setDscp uses ipv6 family for udp6 sockets', async () => {
  const dg = mockDgram();
  const calls = [];
  const transport = new UdpTransport(
    { bindAddress: '::', bindPort: 14550 },
    {
      dgram: dg.module,
      markDscp: (socket, dscp, options) => {
        calls.push({ type: socket.type, family: options.family, dscp });
        return true;
      },
    }
  );

  await transport.open();
  assert.equal(dg.sockets[0].type, 'udp6');
  assert.equal(transport.setDscp(46), true);
  assert.deepEqual(calls, [{ type: 'udp6', family: 'ipv6', dscp: 46 }]);
});

test('TCP transport setDscp marks the socket selected for the next send', async () => {
  const socket = new EventEmitter();
  socket.remoteAddress = '10.0.0.21';
  socket.remotePort = 49000;
  socket.remoteFamily = 'IPv4';
  socket.write = () => true;
  const calls = [];
  const transport = new TcpTransport(
    { bindPort: 5760 },
    {
      net: {
        createServer(_options, listener) {
          const server = new EventEmitter();
          server.listen = () => setTimeout(() => server.emit('listening'), 0);
          server.address = () => ({ address: '0.0.0.0', port: 5760 });
          server.close = (callback) => callback();
          server.on('connection', listener);
          return server;
        },
      },
      markDscp: (markedSocket, dscp, options) => {
        calls.push({ socket: markedSocket, dscp, family: options.family });
        return true;
      },
    }
  );

  await transport.open();
  transport._server.emit('connection', socket);

  assert.equal(transport.setDscp(10, { address: '10.0.0.21', port: 49000 }), true);
  assert.deepEqual(calls, [{ socket, dscp: 10, family: 'IPv4' }]);
});

test('Connection pump marks each dequeued band immediately before transport send', async () => {
  const events = [];
  const timers = fakeTimers();
  const clock = fakeClock(1000);
  const transport = new FakeTransport(events);
  const connection = new Connection(
    {
      transport: {
        mode: 'udp',
        bindPort: 14550,
        remoteAddress: '10.0.0.9',
        remotePort: 14555,
      },
      vehicle: { targetSysid: 1, targetCompid: 1, autopilot: 3 },
      identities: [GCS],
      defaultIdentityId: 'gcs',
      boundIdentityIds: ['gcs'],
      signing: {
        linkId: 0,
        signOutbound: false,
        requireSigned: false,
        acceptInvalid: false,
        hasKey: false,
      },
      heartbeat: { staleMs: 5000, expireMs: 15000 },
    },
    {
      now: clock.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      wire: fakeWire(),
      resolveIdentity,
      transportFactory: () => transport,
    }
  );

  await connection.start();
  connection.send({ name: 'PARAM_SET', fields: {} }, { band: BAND.BULK });
  await tick();

  assert.deepEqual(events, ['mark:10:default', 'send:PARAM_SET:default']);
  connection.close();
});
