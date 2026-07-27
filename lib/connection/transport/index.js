'use strict';

/**
 * Transport factory (DESIGN.md §7, §12). UDP, TCP, and serial share one driver
 * contract: write one frame, wait for the transport to accept it (callback /
 * drain), then dequeue again. Serial lazy-loads optional `serialport`; selecting
 * it when absent fails with a clear error. UDP/TCP installs must load without
 * that package (§3).
 */

const { UdpTransport, UDP_NO_DESTINATION, UDP_INCOMPLETE_DESTINATION } = require('./udp');
const { TcpTransport, TCP_NO_DESTINATION, TCP_PEER_GONE } = require('./tcp');
const { SerialTransport, SERIAL_NO_DESTINATION } = require('./serial');

/** Soft send failures the Connection driver drops without warning spam. */
const TRANSPORT_QUIET_SEND_CODES = new Set([
  UDP_NO_DESTINATION,
  TCP_NO_DESTINATION,
  SERIAL_NO_DESTINATION,
]);

/**
 * @typedef {object} TransportConfig
 * @property {'udp'|'tcp'|'serial'} mode
 */

/**
 * @param {TransportConfig} config
 * @param {object} [deps]  injected modules (`dgram`, `net`, `SerialPort`) for tests
 * @returns {import('node:events').EventEmitter & {open: Function, send: Function, close: Function, mode: string}}
 * @throws {Error} for an unknown mode
 */
function createTransport(config, deps = {}) {
  switch (config.mode) {
    case 'udp':
      return new UdpTransport(config, deps);
    case 'tcp':
      return new TcpTransport(config, deps);
    case 'serial':
      return new SerialTransport(config, deps);
    default:
      throw new Error(`unknown transport mode '${config.mode}'`);
  }
}

module.exports = {
  createTransport,
  UdpTransport,
  TcpTransport,
  SerialTransport,
  UDP_NO_DESTINATION,
  UDP_INCOMPLETE_DESTINATION,
  TCP_NO_DESTINATION,
  TCP_PEER_GONE,
  SERIAL_NO_DESTINATION,
  TRANSPORT_QUIET_SEND_CODES,
};
