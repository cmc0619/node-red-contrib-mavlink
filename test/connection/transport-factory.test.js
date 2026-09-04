'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTransport, TRANSPORT_QUIET_SEND_CODES } = require('../../lib/connection/transport');
const { UdpTransport, UDP_NO_DESTINATION } = require('../../lib/connection/transport/udp');
const { TcpTransport, TCP_NO_DESTINATION, TCP_PEER_GONE } = require('../../lib/connection/transport/tcp');
const { SerialTransport, SERIAL_NO_DESTINATION } = require('../../lib/connection/transport/serial');

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
  // A mode no case answers to selects no transport (§5) — the caller craters
  // on the undefined, at construction, not mid-flight.
  assert.equal(createTransport({ mode: 'upd' }), undefined);
});

test('quiet send codes cover every transport soft-fail', () => {
  assert.ok(TRANSPORT_QUIET_SEND_CODES.has(UDP_NO_DESTINATION));
  assert.ok(TRANSPORT_QUIET_SEND_CODES.has(TCP_NO_DESTINATION));
  assert.ok(TRANSPORT_QUIET_SEND_CODES.has(SERIAL_NO_DESTINATION));
  assert.equal(TRANSPORT_QUIET_SEND_CODES.has(TCP_PEER_GONE), false);
});
