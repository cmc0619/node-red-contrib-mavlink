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
 * ({ buffer, address, port }), `endpoint-gone` ({ address, port }) when a
 * peer socket closes — server-mode accepted client *or* client-mode remote
 * disconnect — so the Connection can drop that stream decoder, `error`,
 * `close`.
 */

const { EventEmitter } = require('node:events');
const { markSocket } = require('../dscp');
const { endpointKey } = require('../endpoint-key');

/** Soft failure: no connected TCP peer is available for this send. */
const TCP_NO_DESTINATION = 'TCP_NO_DESTINATION';
/** Targeted peer socket is gone — not quiet; driver should failover primary. */
const TCP_PEER_GONE = 'TCP_PEER_GONE';
/** close() raced an in-flight open(); the rejection means "close won", not a failure. */
const TCP_CLOSED_DURING_OPEN = 'TCP_CLOSED_DURING_OPEN';
const DEFAULT_HIGH_WATER_MARK = 1024;

/**
 * @typedef {object} TcpConfig
 * @property {string} bindAddress  listen address in server mode, local
 *   address in client mode (the editor owns the 0.0.0.0 default)
 * @property {number} [bindPort]  local listen port in server mode
 * @property {string} [remoteAddress]  remote host in client mode
 * @property {number} [remotePort]  remote port in client mode
 * @property {number} [highWaterMark]  shallow socket buffer threshold (tests)
 */

class TcpTransport extends EventEmitter {
  /**
   * @param {TcpConfig} config
   * @param {object} [deps]
   * @param {object} [deps.net]  injected `net` module (default `node:net`)
   * @param {Function} [deps.markDscp]  injected DSCP marker for tests
   * @param {object} [deps.logger]
   */
  constructor(config, deps = {}) {
    super();
    this.mode = 'tcp';
    this._config = config;
    this._net = deps.net || require('node:net');
    this._markDscp = deps.markDscp || markSocket;
    this._logger = deps.logger;
    this._socket = null;
    this._server = null;
    this._clients = new Map();
    this._connected = false;
    this._closed = false;
    /** @type {Map<object, Set<(err?: Error) => void>>} pending drain callbacks per socket */
    this._pendingBySocket = new Map();
    /**
     * Socket resolved by setDscp() for the immediately following send(), so
     * the send does not repeat the lookup. Consume-once, and honoured only
     * for the same endpoint reference — the pump calls the pair back to back
     * synchronously, so the socket cannot have changed in between; any other
     * call pattern falls through to a fresh resolution.
     * @type {{endpoint: {address: string, port: number}|null, socket: object}|null}
     */
    this._marked = null;
    /**
     * Reject handle for an in-flight open(). Destroying a connecting socket
     * (or closing a binding server) emits neither 'connect'/'listening' nor
     * 'error', so without this a close() racing open() would leave start()
     * awaiting forever (§7 teardown race).
     * @type {((err: Error) => void)|null}
     */
    this._rejectPendingOpen = null;
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
    const marked = this._marked;
    this._marked = null;
    const socket = marked && marked.endpoint === endpoint
      ? marked.socket
      : this._resolveSocket(endpoint);
    if (!socket) {
      let err;
      if (this._server && endpoint) {
        // Targeted peer socket is gone — loud, so the driver fails over.
        err = new Error(`TCP peer ${endpoint.address}:${endpoint.port} is gone`);
        err.code = TCP_PEER_GONE;
      } else {
        err = new Error('TCP send has no destination (no connected socket)');
        err.code = TCP_NO_DESTINATION;
      }
      callback(err);
      return;
    }
    this._write(socket, buffer, callback);
  }

  /**
   * Best-effort DSCP mark for the socket that the immediately following send
   * will use. Missing destinations stay unmarked and still fail in `send()`.
   *
   * @param {number} dscp
   * @param {{address: string, port: number}|null} endpoint
   * @returns {boolean}
   */
  setDscp(dscp, endpoint) {
    const socket = this._resolveSocket(endpoint);
    this._marked = socket ? { endpoint, socket } : null;
    if (!socket) return false;
    return this._markDscp(socket, dscp, {
      family: socket.remoteFamily,
      logger: this._logger,
    });
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
    // Settle an in-flight open() first: the socket/server teardown below emits
    // no event the open promise is waiting on, and the runtime treats this
    // rejection as "close won the race", not a connection failure.
    if (this._rejectPendingOpen) {
      const rejectOpen = this._rejectPendingOpen;
      this._rejectPendingOpen = null;
      const err = new Error('TCP transport closed during open');
      err.code = TCP_CLOSED_DURING_OPEN;
      rejectOpen(err);
    }
    this._failAllPendingWrites(new Error('TCP transport closed'));
    if (this._socket) {
      // Always invoke callback — a destroyed/disconnected socket's end() may
      // never emit 'finish', which would hang Node-RED redeploy (§7).
      const socket = this._socket;
      if (socket.destroyed || !this._connected) {
        if (typeof socket.destroy === 'function') socket.destroy();
        callback();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (typeof socket.destroy === 'function') socket.destroy();
        callback();
      };
      socket.once('close', finish);
      socket.end(finish);
      return;
    }
    for (const socket of this._clients.values()) {
      if (typeof socket.destroy === 'function') socket.destroy();
      else socket.end();
    }
    this._clients.clear();
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
        localAddress: this._config.bindAddress,
      };

      const socket = this._net.createConnection(options, () => {
        this._rejectPendingOpen = null;
        this._connected = true;
        this.emit('connect', endpoint);
        this.emit('listening', endpoint);
        resolve();
      });
      this._socket = socket;
      this._rejectPendingOpen = reject;
      this._attachClientSocket(socket, endpoint);

      const onOpenError = (err) => {
        this._rejectPendingOpen = null;
        reject(err);
      };
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
        this._rejectPendingOpen = null;
        this.emit('listening', server.address ? server.address() : undefined);
        resolve();
      });

      const onOpenError = (err) => {
        this._rejectPendingOpen = null;
        reject(err);
      };
      server.once('error', onOpenError);
      server.once('listening', () => server.removeListener('error', onOpenError));

      this._rejectPendingOpen = reject;
      server.listen(this._config.bindPort, this._config.bindAddress);
    });
  }

  /**
   * @param {object} socket
   * @param {{address: string, port: number}} endpoint
   */
  _attachClientSocket(socket, endpoint) {
    // prependListener so lifecycle cleanup always runs before any later
    // once('close'/'error') handlers attached by an in-flight `_write`.
    socket.prependListener('error', (err) => {
      this._connected = false;
      // Emit before failing pending writes so the runtime clears `_ready`
      // before the send callback resumes the queue pump.
      this.emit('error', err);
      this._failSocketWrites(socket, err);
    });
    socket.on('data', (buffer) => {
      this.emit('message', { buffer, address: endpoint.address, port: endpoint.port });
    });
    socket.prependListener('close', () => {
      this._connected = false;
      const err = new Error('TCP client disconnected');
      err.code = 'TCP_DISCONNECTED';
      // Client mode: surface so the Connection runtime leaves CONNECTED (§7)
      // before pending-write callbacks can dequeue the next frame.
      if (!this._closed) this.emit('error', err);
      this._failSocketWrites(socket, err);
      // Only the current client socket owns the endpoint decoder.
      if (this._socket === socket) {
        this.emit('endpoint-gone', {
          address: endpoint.address,
          port: endpoint.port,
        });
      }
      this.emit('close');
    });
  }

  /** @param {object} socket */
  _attachServerSocket(socket) {
    const endpoint = { address: socket.remoteAddress, port: socket.remotePort };
    const key = endpointKey(endpoint);
    const previous = this._clients.get(key);
    this._clients.set(key, socket);
    // Same address:port reused before the old socket's close ran — drop the
    // superseded stream's decoder now so the replacement starts clean, and so
    // the delayed close cannot wipe this socket's pipeline.
    if (previous && previous !== socket) {
      this.emit('endpoint-gone', {
        address: endpoint.address,
        port: endpoint.port,
      });
    }
    socket.prependListener('error', (err) => {
      // One peer failing must not mark the whole Connection ERROR — other
      // accepted clients can still send/receive. Drop the socket from the map
      // before releasing pending writes so the resumed pump cannot select it.
      if (this._clients.get(key) === socket) this._clients.delete(key);
      this._failSocketWrites(socket, err);
    });
    socket.on('data', (buffer) => {
      // Ignore bytes from a superseded socket — same address:port may already
      // own a fresh decoder after reconnect.
      if (this._clients.get(key) !== socket) return;
      this.emit('message', { buffer, address: endpoint.address, port: endpoint.port });
    });
    socket.prependListener('close', () => {
      const stillOwner = this._clients.get(key) === socket;
      if (stillOwner) this._clients.delete(key);
      const err = new Error(
        `TCP peer ${endpoint.address}:${endpoint.port} disconnected`
      );
      err.code = TCP_PEER_GONE;
      this._failSocketWrites(socket, err);
      if (stillOwner) {
        this.emit('endpoint-gone', {
          address: endpoint.address,
          port: endpoint.port,
        });
      }
    });
  }

  /**
   * The socket a send/mark to `endpoint` uses — shared by setDscp() and
   * send() so both resolve identically (and once per frame, via `_marked`).
   * Server mode with a target is exact-match only: a gone peer must surface
   * as TCP_PEER_GONE, never silently reroute to another client.
   *
   * @param {{address: string, port: number}|null} endpoint
   * @returns {object|null|undefined}
   */
  _resolveSocket(endpoint) {
    if (this._server && endpoint) {
      return this._clients.get(endpointKey(endpoint));
    }
    if (this._socket) return this._connected ? this._socket : null;
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
      callback(err);
    };
    const onDrain = () => finish();

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
    // Close/error release pending writes via `_attach*Socket` so a quiet
    // write-local close handler cannot beat peer demotion / runtime ERROR.
    socket.once('drain', onDrain);
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

module.exports = { TcpTransport, TCP_NO_DESTINATION, TCP_PEER_GONE };
