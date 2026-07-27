'use strict';

/**
 * Transport factory (DESIGN.md §7). UDP is the first-class transport; TCP and
 * serial follow the same driver-side scheduling pattern (write one, wait for
 * the transport to accept, dequeue again) and are stubbed here with a clear
 * "not yet" until implemented, rather than failing with a native stack trace.
 *
 * Serial is lazy-loaded on the optional `serialport` dependency: selecting it
 * when the package is absent must give a clear error, and UDP/TCP installs must
 * load without it (§3).
 */

const { UdpTransport, UDP_NO_DESTINATION } = require('./udp');

/**
 * @typedef {object} TransportConfig
 * @property {'udp'|'tcp'|'serial'} mode
 */

/**
 * @param {TransportConfig} config
 * @param {object} [deps]  injected modules (e.g. `dgram`) for testing
 * @returns {import('node:events').EventEmitter & {open: Function, send: Function, close: Function, mode: string}}
 * @throws {Error} for a transport that is not yet implemented or an unknown mode
 */
function createTransport(config, deps = {}) {
  switch (config.mode) {
    case 'udp':
      return new UdpTransport(config, deps);
    case 'tcp':
      throw new Error('TCP transport is not yet implemented; use UDP for now.');
    case 'serial':
      throw new Error(
        "Serial transport is not yet implemented; it will require the optional 'serialport' dependency."
      );
    default:
      throw new Error(`unknown transport mode '${config.mode}'`);
  }
}

module.exports = { createTransport, UdpTransport, UDP_NO_DESTINATION };
