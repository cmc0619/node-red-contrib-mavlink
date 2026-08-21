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
const { markSocket } = require('../dscp');

/** Soft failure: listen-only / no peer endpoint yet — not worth a warn. */
const UDP_NO_DESTINATION = 'UDP_NO_DESTINATION';
/**
 * @typedef {object} UdpConfig
 * @property {string} bindAddress  local bind address (the editor owns the
 *   0.0.0.0 default)
 * @property {number} bindPort  local bind port
 * @property {string} [remoteAddress]  default send target address
 * @property {number} [remotePort]  default send target port
 * @property {string} [broadcastAddress]  one address that reaches the whole
 *   swarm. Two kinds work, and which mechanism applies is read from the address
 *   itself rather than a mode field that could contradict it:
 *
 *   - **Multicast** — 224.0.0.0/4, e.g. ArduPilot's `239.255.145.50`. Only
 *     vehicles that joined the group hear it.
 *   - **Broadcast** — anything else, e.g. `255.255.255.255`. Every host on the
 *     link hears it, whether or not it speaks MAVLink.
 *
 *   `255.255.255.255` (limited broadcast) is the traditional choice: it needs no
 *   knowledge of the subnet, so it survives DHCP handing you a network you did
 *   not predict, and routers never forward it. Its one catch is interface
 *   selection — on a multi-homed host the OS picks by routing table, typically
 *   the default route, which may be the wrong NIC. A directed broadcast
 *   (`<subnet>.255`) is the fix for that case, being explicit about which
 *   network, at the cost of having to know it.
 * @property {number} [broadcastPort]  port for that address (default: bindPort,
 *   which is the correct answer for multicast, where every member joins the same
 *   group *and* port)
 * @property {number} [sendBufferSize]  keep this small to hold depth in the queue
 */

/**
 * IPv4 multicast is 224.0.0.0/4 — first octet 224–239. Anything else configured
 * as a broadcast address is treated as a subnet/limited broadcast.
 *
 * @param {string|undefined} address
 * @returns {boolean}
 */
function isMulticastAddress(address) {
  if (!address || typeof address !== 'string') return false;
  if (address.includes(':')) return address.toLowerCase().startsWith('ff');
  const firstOctet = Number(address.split('.')[0]);
  return Number.isInteger(firstOctet) && firstOctet >= 224 && firstOctet <= 239;
}

class UdpTransport extends EventEmitter {
  /**
   * @param {UdpConfig} config
   * @param {object} [deps]
   * @param {object} [deps.dgram]  injected `dgram` module (default `node:dgram`)
   * @param {Function} [deps.markDscp]  injected DSCP marker for tests
   * @param {object} [deps.logger]
   */
  constructor(config, deps = {}) {
    super();
    this.mode = 'udp';
    this._config = config;
    this._dgram = deps.dgram || require('node:dgram');
    this._markDscp = deps.markDscp || markSocket;
    this._logger = deps.logger;
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
      const type = udpSocketType(this._config.bindAddress);
      const socket = this._dgram.createSocket({ type, reuseAddr: true });
      this._socket = socket;

      socket.on('error', (err) => {
        this.emit('error', err);
      });
      socket.on('message', (buffer, rinfo) => {
        this.emit('message', { buffer, address: rinfo.address, port: rinfo.port });
      });
      socket.on('listening', () => {
        if (this._config.sendBufferSize && socket.setSendBufferSize) {
          socket.setSendBufferSize(this._config.sendBufferSize);
        }
        try {
          this._enableBroadcast(socket);
        } catch (err) {
          // Loud, but as a failed open rather than a throw. This runs inside an
          // event handler, where an escaping exception takes the whole Node-RED
          // runtime with it (§2) — the deploy must fail, not the process.
          //
          // Release the port on the way out. This is the only path that rejects
          // *after* a successful bind, and `Connection.start()` rethrows without
          // closing the transport — so a leaked socket would hold the bind port
          // and make the next deploy fail with EADDRINUSE instead of the real
          // error. A loud failure that reports the wrong cause is worse than none.
          this._closed = true;
          socket.close(() => reject(err));
          return;
        }
        this.emit('listening', socket.address ? socket.address() : undefined);
        resolve();
      });

      const onOpenError = (err) => {
        reject(err);
      };
      socket.once('error', onOpenError);
      socket.once('listening', () => socket.removeListener('error', onOpenError));

      socket.bind(this._config.bindPort, this._config.bindAddress);
    });
  }

  /**
   * Turn on whichever one-write-reaches-everyone mechanism `broadcastAddress`
   * names. Called once the socket is listening, because neither option can be
   * set on an unbound socket.
   *
   * Multicast needs the group *joined* to receive it at all — the NIC filters
   * unjoined groups before the socket ever sees them, so listening passively is
   * not a thing. Loopback is turned off because we send to the same group we
   * joined; left on, every frame we transmit comes straight back and the peer
   * table learns our own GCS identity as a vehicle.
   *
   * Subnet broadcast needs `SO_BROADCAST` or the OS refuses the send outright
   * with EACCES.
   *
   * Failures here throw, which rejects `open()` — a group that cannot be joined
   * or an interface that does not exist is a broken deploy, and the loud stop is
   * the correct signal (§2). Do not soften this into a warning: silently falling
   * back to unicast would look like working swarm delivery that reaches one.
   *
   * @param {object} socket
   */
  _enableBroadcast(socket) {
    const address = this._config.broadcastAddress;
    if (!address) return;
    if (isMulticastAddress(address)) {
      if (socket.setMulticastLoopback) socket.setMulticastLoopback(false);
      socket.addMembership(address);
      return;
    }
    socket.setBroadcast(true);
  }

  /**
   * The single destination that reaches every vehicle, when one is configured.
   *
   * `Connection._pump` prefers this over fanning out to learned peers: on a
   * medium that can carry a real broadcast, one write is the point. Null means
   * no such address, and the fan-out stays in charge.
   *
   * @returns {{address: string, port: number}|null}
   */
  broadcastDestination() {
    const address = this._config.broadcastAddress;
    if (!address) return null;
    // Multicast members join one group *and* port, so the port we bound is the
    // port the group speaks on.
    const port = this._config.broadcastPort || this._config.bindPort;
    if (!port) return null;
    return { address, port };
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
      // Listen-only UDP (or pre-peer bind) is valid; the driver drops quietly.
      // The editor pairs remote host/port (both or neither), and learned peer
      // endpoints always carry both, so a missing half means no destination.
      const err = new Error('UDP send has no destination (no endpoint and no configured remote)');
      err.code = UDP_NO_DESTINATION;
      callback(err);
      return;
    }
    this._socket.send(buffer, port, address, callback);
  }

  /**
   * Best-effort DSCP mark for the next datagram. UDP owns one socket, so the
   * runtime can call this immediately before `send()` without changing routing.
   *
   * @param {number} dscp
   * @returns {boolean}
   */
  setDscp(dscp) {
    if (!this._socket) return false;
    return this._markDscp(this._socket, dscp, {
      family: socketFamily(this._socket, this._config.bindAddress),
      logger: this._logger,
    });
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

/**
 * @param {string|undefined} bindAddress
 * @returns {'udp4'|'udp6'}
 */
function udpSocketType(bindAddress) {
  return looksIpv6(bindAddress) ? 'udp6' : 'udp4';
}

/**
 * Prefer the live socket's type; fall back to the bind address.
 *
 * @param {object} socket
 * @param {string|undefined} bindAddress
 * @returns {'ipv4'|'ipv6'}
 */
function socketFamily(socket, bindAddress) {
  const type = socket && (socket.type || (socket.address && socket.address().family));
  if (type === 'udp6' || type === 'IPv6' || type === 6) return 'ipv6';
  if (type === 'udp4' || type === 'IPv4' || type === 4) return 'ipv4';
  return looksIpv6(bindAddress) ? 'ipv6' : 'ipv4';
}

/**
 * @param {string|undefined} address
 * @returns {boolean}
 */
function looksIpv6(address) {
  if (!address || typeof address !== 'string') return false;
  return address.includes(':');
}

module.exports = {
  UdpTransport,
  UDP_NO_DESTINATION,
  isMulticastAddress,
};
