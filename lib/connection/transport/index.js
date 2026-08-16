'use strict';

/**
 * Transport factory (DESIGN.md §7, §12). UDP, TCP, and serial share one driver
 * contract: write one frame, wait for the transport to accept it (callback /
 * drain), then dequeue again. Serial lazy-loads optional `serialport`; selecting
 * it when absent fails with a clear error. UDP/TCP installs must load without
 * that package (§3).
 */

const { UdpTransport, UDP_NO_DESTINATION } = require('./udp');
const { TcpTransport, TCP_NO_DESTINATION, TCP_PEER_GONE } = require('./tcp');
const { SerialTransport, SERIAL_NO_DESTINATION } = require('./serial');

/** Soft send failures the Connection driver drops without warning spam. */
const TRANSPORT_QUIET_SEND_CODES = new Set([
  UDP_NO_DESTINATION,
  TCP_NO_DESTINATION,
  SERIAL_NO_DESTINATION,
]);

/**
 * OS-level send errors that are routinely momentary — an ICMP unreachable
 * while a vehicle reboots, a full socket buffer, an interface flap. These are
 * worth a warning but must NOT demote the peer's endpoint: the address is
 * still the best known one, and dropping it turns a one-packet blip into a
 * permanently lost peer (issue #91). Genuinely dead links are handled by the
 * peer table's own expiry sweep when the peer stops being heard.
 */
const TRANSPORT_TRANSIENT_SEND_CODES = new Set([
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ECONNREFUSED', // UDP: ICMP port-unreachable from a peer that is restarting
  'EAGAIN',
  'ENOBUFS',
]);

/**
 * @typedef {object} TransportConfig
 * @property {'udp'|'tcp'|'serial'} mode
 */

/**
 * @param {TransportConfig} config
 * @param {object} [deps]  injected modules (`dgram`, `net`, `SerialPort`) for tests
 * @returns {import('node:events').EventEmitter & {open: Function, send: Function, close: Function, mode: string}}
 */
function createTransport(config, deps = {}) {
  switch (config.mode) {
    case 'udp':
      return new UdpTransport(config, deps);
    case 'tcp':
      return new TcpTransport(config, deps);
    case 'serial':
      return new SerialTransport(config, deps);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

module.exports = {
  createTransport,
  UdpTransport,
  TcpTransport,
  SerialTransport,
  UDP_NO_DESTINATION,
  TCP_NO_DESTINATION,
  TCP_PEER_GONE,
  SERIAL_NO_DESTINATION,
  TRANSPORT_QUIET_SEND_CODES,
  TRANSPORT_TRANSIENT_SEND_CODES,
};
