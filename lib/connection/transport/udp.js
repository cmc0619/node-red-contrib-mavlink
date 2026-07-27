'use strict';

/**
 * UDP transport (DESIGN.md §7 "Scheduling is the driver's"). The transport is a
 * thin, event-emitting wrapper over Node's `dgram` socket. It deliberately
 * holds no queue and no priority logic: depth lives in the driver's band queue,
 * and the socket buffer is kept shallow so the band scheme is not defeated at
 * the kernel boundary.
 *
 * The send path takes a completion callback and treats that as the release —
 * the driver writes one message, waits for the callback, then dequeues the
 * next. `dgram` is injectable so tests drive the transport with a mock socket
 * instead of opening a real port.
 *
 * The `error` handler is attached at socket creation and kept through teardown:
 * an `error` event on a socket with no listener is one of the few things that
 * kills the whole Node-RED runtime (§2), so it is never left unhandled.
 *
 * Events: `listening`, `message` ({ buffer, address, port }), `error`, `close`.
 */

const { EventEmitter } = require('node:events');

/**
 * @typedef {object} UdpConfig
 * @property {string} [bindAddress]  local bind address (default 0.0.0.0)
 * @property {number} bindPort  local bind port
 * @property {string} [remoteAddress]  default send target address
 * @property {number} [remotePort]  default send target port
 * @property {boolean} [broadcast]  enable SO_BROADCAST
 * @property {number} [sendBufferSize]  keep this small to hold depth in the queue
 */

class UdpTransport extends EventEmitter {
  /**
   * @param {UdpConfig} config
   * @param {object} [deps]
   * @param {object} [deps.dgram]  injected `dgram` module (default `node:dgram`)
   */
  constructor(config, deps = {}) {
    super();
    this.mode = 'udp';
    this._config = config;
    this._dgram = deps.dgram || require('node:dgram');
    this._socket = null;
    this._closed = false;
  }

  /**
   * Bind the socket. Resolves once it is listening; the `error` handler is live
   * before the bind is issued.
   *
   * @returns {Promise<void>}
   */
  open() {
    return new Promise((resolve, reject) => {
      const socket = this._dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this._socket = socket;

      socket.on('error', (err) => {
        this.emit('error', err);
      });
      socket.on('message', (buffer, rinfo) => {
        this.emit('message', { buffer, address: rinfo.address, port: rinfo.port });
      });
      socket.on('listening', () => {
        if (this._config.broadcast && socket.setBroadcast) socket.setBroadcast(true);
        if (this._config.sendBufferSize && socket.setSendBufferSize) {
          socket.setSendBufferSize(this._config.sendBufferSize);
        }
        this.emit('listening', socket.address ? socket.address() : undefined);
        resolve();
      });

      const onOpenError = (err) => {
        socket.removeListener('listening', resolve);
        reject(err);
      };
      socket.once('error', onOpenError);
      socket.once('listening', () => socket.removeListener('error', onOpenError));

      socket.bind(this._config.bindPort, this._config.bindAddress || '0.0.0.0');
    });
  }

  /**
   * Send one datagram. The callback is the release signal the driver waits on.
   *
   * @param {Buffer} buffer
   * @param {{address: string, port: number}|null} endpoint  explicit target;
   *   falls back to the configured remote when null
   * @param {(err?: Error) => void} callback
   */
  send(buffer, endpoint, callback) {
    const address = (endpoint && endpoint.address) || this._config.remoteAddress;
    const port = (endpoint && endpoint.port) || this._config.remotePort;
    if (!address || !port) {
      callback(new Error('UDP send has no destination (no endpoint and no configured remote)'));
      return;
    }
    this._socket.send(buffer, port, address, callback);
  }

  /**
   * Close the socket, releasing the port. Always invokes `callback` — a lookup
   * that throws synchronously in teardown would hang the redeploy (§7).
   *
   * @param {() => void} callback
   */
  close(callback) {
    if (this._closed || !this._socket) {
      callback();
      return;
    }
    this._closed = true;
    this._socket.close(() => callback());
  }
}

module.exports = { UdpTransport };
