'use strict';

/**
 * TCP transport (DESIGN.md §7 "Scheduling is the driver's"). The transport is
 * a thin, event-emitting wrapper over Node's `net` sockets. It deliberately
 * holds no outbound queue and writes exactly one buffer per `send()` call; if
 * the socket applies backpressure, the callback is released on `drain` so the
 * Connection driver can keep priority depth in its own band queue.
 *
 * `net` is injectable so tests can drive client and server sockets without
 * opening real ports. Socket `error` handlers are attached at creation and kept
 * through teardown because an unhandled async socket error would kill Node-RED.
 *
 * Events: `listening`, `connect` (client only), `message`
 * ({ buffer, address, port }), `error`, `close`.
 */

const { EventEmitter } = require('node:events');

/** Soft failure: no connected TCP peer is available for this send. */
const TCP_NO_DESTINATION = 'TCP_NO_DESTINATION';
const DEFAULT_HIGH_WATER_MARK = 1024;

/**
 * @typedef {object} TcpConfig
 * @property {string} [bindAddress]  local bind/listen address (default 0.0.0.0
 *   in server mode)
 * @property {number} [bindPort]  local listen port in server mode
 * @property {string} [remoteAddress]  remote host in client mode
 * @property {number} [remotePort]  remote port in client mode
 * @property {number} [highWaterMark]  shallow socket buffer threshold
 */

class TcpTransport extends EventEmitter {
  /**
   * @param {TcpConfig} config
   * @param {object} [deps]
   * @param {object} [deps.net]  injected `net` module (default `node:net`)
   */
  constructor(config, deps = {}) {
    super();
    this.mode = 'tcp';
    this._config = config;
    this._net = deps.net || require('node:net');
    this._socket = null;
    this._server = null;
    this._clients = new Map();
    this._connected = false;
    this._closed = false;
    /** @type {Map<object, Set<(err?: Error) => void>>} pending drain callbacks per socket */
    this._pendingBySocket = new Map();
  }

  /**
   * Open the client connection or server listener. Client mode emits both
   * `connect` and `listening` when ready so the Connection runtime can handle
   * all transports uniformly.
   *
   * @returns {Promise<void>}
   */
  open() {
    if (this._config.remoteAddress && this._config.remotePort) {
      return this._openClient();
    }
    return this._openServer();
  }

  /**
   * Send one TCP write. The callback is the release signal the driver waits on.
   *
   * @param {Buffer} buffer
   * @param {{address: string, port: number}|null} endpoint  server-mode target;
   *   ignored in client mode
   * @param {(err?: Error) => void} callback
   */
  send(buffer, endpoint, callback) {
    const socket = this._selectSocket(endpoint);
    if (!socket) {
      const err = new Error('TCP send has no destination (no connected socket for endpoint)');
      err.code = TCP_NO_DESTINATION;
      callback(err);
      return;
    }
    this._write(socket, buffer, callback);
  }

  /**
   * Close the active client socket or listener and all accepted clients.
   *
   * @param {() => void} callback
   */
  close(callback) {
    if (this._closed) {
      callback();
      return;
    }
    this._closed = true;
    this._failAllPendingWrites(new Error('TCP transport closed'));
    if (this._socket) {
      this._socket.end(callback);
      return;
    }
    for (const socket of this._clients.values()) socket.end();
    if (this._server) {
      this._server.close(() => callback());
      return;
    }
    callback();
  }

  /** @returns {Promise<void>} */
  _openClient() {
    return new Promise((resolve, reject) => {
      const endpoint = { address: this._config.remoteAddress, port: this._config.remotePort };
      const options = {
        host: this._config.remoteAddress,
        port: this._config.remotePort,
        highWaterMark: this._highWaterMark(),
      };
      if (this._config.bindAddress) options.localAddress = this._config.bindAddress;

      const socket = this._net.createConnection(options, () => {
        this._connected = true;
        this.emit('connect', endpoint);
        this.emit('listening', endpoint);
        resolve();
      });
      this._socket = socket;
      this._attachClientSocket(socket, endpoint);

      const onOpenError = (err) => reject(err);
      socket.once('error', onOpenError);
      socket.once('connect', () => socket.removeListener('error', onOpenError));
    });
  }

  /** @returns {Promise<void>} */
  _openServer() {
    return new Promise((resolve, reject) => {
      const server = this._net.createServer({ highWaterMark: this._highWaterMark() }, (socket) => {
        this._attachServerSocket(socket);
      });
      this._server = server;

      server.on('error', (err) => {
        this.emit('error', err);
      });
      server.on('close', () => {
        this.emit('close');
      });
      server.on('listening', () => {
        this.emit('listening', server.address ? server.address() : undefined);
        resolve();
      });

      const onOpenError = (err) => reject(err);
      server.once('error', onOpenError);
      server.once('listening', () => server.removeListener('error', onOpenError));

      server.listen(this._config.bindPort, this._config.bindAddress || '0.0.0.0');
    });
  }

  /**
   * @param {object} socket
   * @param {{address: string, port: number}} endpoint
   */
  _attachClientSocket(socket, endpoint) {
    socket.on('error', (err) => {
      this._failSocketWrites(socket, err);
      this.emit('error', err);
    });
    socket.on('data', (buffer) => {
      this.emit('message', { buffer, address: endpoint.address, port: endpoint.port });
    });
    socket.on('close', () => {
      this._connected = false;
      const err = new Error('TCP client disconnected');
      err.code = 'TCP_DISCONNECTED';
      this._failSocketWrites(socket, err);
      // Client mode: surface so the Connection runtime leaves CONNECTED (§7).
      if (!this._closed) this.emit('error', err);
      this.emit('close');
    });
  }

  /** @param {object} socket */
  _attachServerSocket(socket) {
    const endpoint = { address: socket.remoteAddress, port: socket.remotePort };
    const key = endpointKey(endpoint);
    this._clients.set(key, socket);
    socket.on('error', (err) => {
      // One peer failing must not mark the whole Connection ERROR — other
      // accepted clients can still send/receive.
      this._failSocketWrites(socket, err);
      this._clients.delete(key);
    });
    socket.on('data', (buffer) => {
      this.emit('message', { buffer, address: endpoint.address, port: endpoint.port });
    });
    socket.on('close', () => {
      this._clients.delete(key);
      this._failSocketWrites(socket, new Error('TCP peer disconnected'));
    });
  }

  /**
   * @param {{address: string, port: number}|null} endpoint
   * @returns {object|null}
   */
  _selectSocket(endpoint) {
    if (this._socket) return this._connected ? this._socket : null;
    if (endpoint) {
      const socket = this._clients.get(endpointKey(endpoint));
      if (socket) return socket;
    }
    if (this._clients.size === 1) return this._clients.values().next().value;
    return null;
  }

  /**
   * @param {object} socket
   * @param {Buffer} buffer
   * @param {(err?: Error) => void} callback
   */
  _write(socket, buffer, callback) {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      const set = this._pendingBySocket.get(socket);
      if (set) {
        set.delete(finish);
        if (set.size === 0) this._pendingBySocket.delete(socket);
      }
      socket.removeListener('drain', onDrain);
      socket.removeListener('error', onFail);
      socket.removeListener('close', onFailClose);
      callback(err);
    };
    const onDrain = () => finish();
    const onFail = (err) => finish(err || new Error('TCP write aborted'));
    const onFailClose = () => {
      const err = new Error('TCP write aborted (socket closed)');
      err.code = TCP_NO_DESTINATION;
      finish(err);
    };

    let set = this._pendingBySocket.get(socket);
    if (!set) {
      set = new Set();
      this._pendingBySocket.set(socket, set);
    }
    set.add(finish);
    if (socket.write(buffer)) {
      finish();
      return;
    }
    socket.once('drain', onDrain);
    socket.once('error', onFail);
    socket.once('close', onFailClose);
  }

  /**
   * @param {object} socket
   * @param {Error} err
   */
  _failSocketWrites(socket, err) {
    const set = this._pendingBySocket.get(socket);
    if (!set) return;
    this._pendingBySocket.delete(socket);
    for (const finish of set) finish(err);
  }

  /** @param {Error} err */
  _failAllPendingWrites(err) {
    const sockets = [...this._pendingBySocket.keys()];
    for (const socket of sockets) this._failSocketWrites(socket, err);
  }

  /** @returns {number} */
  _highWaterMark() {
    return this._config.highWaterMark || DEFAULT_HIGH_WATER_MARK;
  }
}

/**
 * @param {{address: string, port: number}} endpoint
 * @returns {string}
 */
function endpointKey(endpoint) {
  return `${endpoint.address}:${endpoint.port}`;
}

module.exports = { TcpTransport, TCP_NO_DESTINATION };
