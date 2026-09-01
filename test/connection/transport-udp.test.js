'use strict';

/**
 * UDP swarm delivery (DESIGN.md §14 "A swarm address is delivery, not
 * addressing").
 *
 * One config field carries both mechanisms, because the address already says
 * which one it is: 224.0.0.0/4 is a multicast group and has to be *joined*,
 * anything else is a broadcast address and needs `SO_BROADCAST`. These tests
 * pin that reading — a mode field that could disagree with the address is
 * exactly what this design avoids.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { UdpTransport } = require('../../lib/connection/transport/udp');
const { mockDgram } = require('./helpers');

/**
 * @param {object} [extra]  merged over the base UDP config
 * @returns {{transport: UdpTransport, sockets: object[]}}
 */
function build(extra = {}) {
  const { module, sockets } = mockDgram();
  const transport = new UdpTransport(
    { bindAddress: '0.0.0.0', bindPort: 14550, ...extra },
    { dgram: module }
  );
  return { transport, sockets };
}

test('a multicast group is joined, not broadcast-flagged', async () => {
  const { transport, sockets } = build({ broadcastAddress: '239.255.145.50' });
  await transport.open();
  const socket = sockets[0];

  assert.deepEqual(socket.memberships, ['239.255.145.50'], 'the group must be joined to receive it');
  assert.equal(socket.broadcastFlag, null, 'SO_BROADCAST is meaningless for multicast');
  // Loopback stays at the OS default (on): ArduPilot's `mcast:` exists so
  // several tools on one host share a link, and the runtime filters our own
  // echoed frames by bound identity instead.
  assert.equal(socket.multicastLoopback, null, 'the transport must not touch multicast loopback');
});

test('a broadcast address sets SO_BROADCAST and joins nothing', async () => {
  const { transport, sockets } = build({ broadcastAddress: '255.255.255.255' });
  await transport.open();
  const socket = sockets[0];

  assert.equal(socket.broadcastFlag, true, 'without SO_BROADCAST the OS refuses the send (EACCES)');
  assert.deepEqual(socket.memberships, [], 'there is no group to join');
});

test('an ordinary UDP connection touches neither option', async () => {
  const { transport, sockets } = build();
  await transport.open();
  const socket = sockets[0];

  assert.equal(socket.broadcastFlag, null);
  assert.deepEqual(socket.memberships, []);
  assert.equal(transport.broadcastDestination(), null, 'no swarm address means fan-out stays in charge');
});

test('the swarm port defaults to the bind port', async () => {
  // Multicast members join one group *and* port, so the port we bound is the
  // port the group speaks on — the default is the answer, not a guess.
  const { transport } = build({ broadcastAddress: '239.255.145.50' });
  await transport.open();

  assert.deepEqual(transport.broadcastDestination(), {
    address: '239.255.145.50',
    port: 14550,
  });
});

test('an explicit swarm port overrides the bind port', async () => {
  // Real hardware listening on a port that is not the one we bound.
  const { transport } = build({ broadcastAddress: '255.255.255.255', broadcastPort: 14560 });
  await transport.open();

  assert.deepEqual(transport.broadcastDestination(), {
    address: '255.255.255.255',
    port: 14560,
  });
});

test('a group that cannot be joined fails the deploy loudly', async () => {
  const { module, sockets } = mockDgram();
  const transport = new UdpTransport(
    { bindAddress: '0.0.0.0', bindPort: 14550, broadcastAddress: '239.255.145.50' },
    { dgram: module }
  );
  // Node throws ENODEV here when the interface has no route to the group.
  const originalCreate = module.createSocket;
  module.createSocket = (opts) => {
    const socket = originalCreate(opts);
    socket.addMembership = () => { throw new Error('addMembership ENODEV'); };
    return socket;
  };

  await assert.rejects(
    () => transport.open(),
    /ENODEV/,
    'silently degrading to unicast would look like swarm delivery that reaches one'
  );
  assert.equal(sockets.length, 1);
  // The bind already succeeded, and Connection.start() rethrows without closing
  // the transport — a leaked socket would hold the port and make the *next*
  // deploy fail with EADDRINUSE, reporting the wrong cause entirely.
  assert.equal(sockets[0].closed, true, 'the port is released on the way out');
});

test('multicast is decided by the address, across both families', async () => {
  // Measured at the socket: a multicast group is joined, anything else is
  // broadcast-flagged, and no address at all touches neither.
  const opened = async (broadcastAddress) => {
    const { transport, sockets } = build({ broadcastAddress });
    await transport.open();
    return sockets[0];
  };
  for (const address of ['224.0.0.1', '239.255.145.50', '232.1.2.3', 'ff02::1']) {
    const socket = await opened(address);
    assert.deepEqual(socket.memberships, [address], `${address} is joined as a multicast group`);
    assert.equal(socket.broadcastFlag, null, `${address} is not broadcast-flagged`);
  }
  for (const address of ['255.255.255.255', '192.168.1.255', '10.0.0.7', '223.0.0.1', '240.0.0.1', 'fe80::1']) {
    const socket = await opened(address);
    assert.deepEqual(socket.memberships, [], `${address} joins no group`);
    assert.equal(socket.broadcastFlag, true, `${address} is broadcast-flagged`);
  }
  for (const address of [undefined, '']) {
    const socket = await opened(address);
    assert.deepEqual(socket.memberships, []);
    assert.equal(socket.broadcastFlag, null, 'no broadcast address configures neither');
  }
});
