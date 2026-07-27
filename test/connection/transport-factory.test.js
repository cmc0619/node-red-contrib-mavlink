'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTransport,
  UdpTransport,
  TcpTransport,
  SerialTransport,
  TRANSPORT_QUIET_SEND_CODES,
  UDP_NO_DESTINATION,
  TCP_NO_DESTINATION,
  TCP_PEER_GONE,
  SERIAL_NO_DESTINATION,
} = require('../../lib/connection/transport');

test('createTransport returns the matching transport class', () => {
  assert.ok(createTransport({ mode: 'udp', bindPort: 14550 }) instanceof UdpTransport);
  assert.ok(
    createTransport({ mode: 'tcp', remoteAddress: '127.0.0.1', remotePort: 5760 }) instanceof
      TcpTransport
  );
  assert.ok(
    createTransport({ mode: 'serial', path: '/dev/null', baudRate: 57600 }) instanceof
      SerialTransport
  );
});

test('createTransport rejects an unknown mode', () => {
  assert.throws(
    () => createTransport({ mode: 'carrier-pigeon' }),
    /unknown transport mode/
  );
});

test('quiet send codes cover every transport soft-fail', () => {
  assert.ok(TRANSPORT_QUIET_SEND_CODES.has(UDP_NO_DESTINATION));
  assert.ok(TRANSPORT_QUIET_SEND_CODES.has(TCP_NO_DESTINATION));
  assert.ok(TRANSPORT_QUIET_SEND_CODES.has(SERIAL_NO_DESTINATION));
  assert.equal(TRANSPORT_QUIET_SEND_CODES.has(TCP_PEER_GONE), false);
});
