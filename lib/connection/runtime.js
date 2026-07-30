'use strict';

/**
 * The Connection runtime (DESIGN.md §7, §8, §12 step 4). One connection owns
 * one transport, one peer table, one outbound band queue, one subscription
 * registry, one signing channel state, and identity-driven heartbeat scheduling.
 * It decodes everything arriving against its single bound Vehicle
 * Profile — one dialect, one firmware, no per-packet lookup (§7). Framing
 * uses one stream decoder per TCP client / UDP endpoint so a partial packet
 * from peer A cannot contaminate peer B.
 *
 * Design posture (§2): the wire boundary, the transport, and the clock are all
 * injectable, so the queue driver, peer table, and subscription plumbing are
 * tested against a mock `dgram` and a trivial in-memory wire without depending
 * on `node-mavlink` being installed.
 *
 * Lifecycle and the two teardown traps of §7:
 *   - references bound at start are torn down in {@link Connection#close}; the
 *     config nodes are never re-resolved inside `close`, because a lookup that
 *     throws synchronously there never calls `done` and hangs the deploy;
 *   - timers and sockets are released on every exit path, and `done` is always
 *     called exactly once.
 *
 * Disabled means no runtime: no dialing, listening, heartbeats, or timers
 * (§7). The node does not even construct a Connection when disabled; a
 * Connection constructed with `disabled: true` is inert as a second guard.
 */

const { EventEmitter } = require('node:events');

const { OutboundQueue } = require('./queue');
const { PeerTable } = require('./peer-table');
const { SubscriptionRegistry } = require('./subscriptions');
const { HeartbeatScheduler } = require('./heartbeat');
const { SigningState } = require('./signing');
const { BAND } = require('./bands');
const { createTransport, TRANSPORT_QUIET_SEND_CODES } = require('./transport');

/** Connection state-machine values, mapped to §6 config-node badges by the node. */
const STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  CLOSED: 'closed',
  DISABLED: 'disabled',
  ERROR: 'error',
};

class Connection extends EventEmitter {
  /**
   * @param {object} config
   * @param {boolean} [config.disabled]
   * @param {object} config.transport  transport config incl. `mode`
   * @param {object} config.vehicle  bound Vehicle Profile snapshot: targetSysid,
   *   targetCompid, bundle, and optional MAV_AUTOPILOT for mismatch detection
   * @param {Array<object>} config.identities  bound Local Identity snapshots
   * @param {string} config.defaultIdentityId
   * @param {string[]} [config.boundIdentityIds]  defaults to the identities' ids
   * @param {object} [config.queue]  { capacities, ageStepMs }
   * @param {object} [config.signing]  { linkId, signOutbound, requireSigned,
   *   acceptInvalid, hasKey, key }
   * @param {object} [config.heartbeat]  { staleMs, expireMs }
   * @param {object} [deps]  injectable collaborators (now, timers, logger,
   *   transportFactory, createWire, wire, dgram, resolveIdentity)
   */
  constructor(config, deps = {}) {
    super();
    this._config = config;
    this._deps = deps;
    this._now = deps.now || Date.now;
    this._setInterval = deps.setInterval || setInterval;
    this._clearInterval = deps.clearInterval || clearInterval;
    this._logger = deps.logger || { info() {}, warn() {}, error() {} };
    this._transportFactory = deps.transportFactory || createTransport;

    // Bind references at construction so close() tears down exactly what start()
    // wired up, never re-resolving a config node (§7 teardown).
    this._disabled = !!config.disabled;
    this._identities = (config.identities || []).slice();
    this._identitiesById = new Map(this._identities.map((id) => [id.id, id]));
    this._boundIdentityIds =
      config.boundIdentityIds || this._identities.map((id) => id.id);
    this._defaultIdentityId = config.defaultIdentityId;
    this._vehicle = config.vehicle;

    this._state = this._disabled ? STATE.DISABLED : STATE.IDLE;
    this._ready = false;
    this._closed = false;
    this._draining = false;
    this._started = false;
    this._faults = new Set();

    this._transport = null;
    this._wire = null;
    this._sweepTimer = null;
    this._doneCalled = false;

    this.queue = null;
    this.peerTable = null;
    this.subscriptions = null;
    this.signing = null;
    this.heartbeats = null;
  }

  /** @returns {string} the current state-machine value */
  getState() {
    return this._state;
  }

  /**
   * Build the runtime and open the transport. No-op when disabled.
   *
   * @returns {Promise<void>} resolves once listening (or immediately when
   *   disabled); rejects if the transport fails to open or signing is
   *   misconfigured (sign-outbound with no key fails closed)
   */
  async start() {
    if (this._disabled) return;
    if (this._started) return;
    this._started = true;

    this.signing = new SigningState({ ...(this._config.signing || {}), now: this._now });
    const check = this.signing.validate();
    if (!check.ok) {
      this._setState(STATE.ERROR);
      throw new Error(check.reason);
    }

    this.queue = new OutboundQueue({ ...(this._config.queue || {}), now: this._now });
    this.subscriptions = new SubscriptionRegistry({
      onError: (err) => this._logger.error(`inbound subscriber failed: ${err.message}`),
    });
    this.peerTable = new PeerTable({
      now: this._now,
      heartbeatStaleMs: this._config.heartbeat && this._config.heartbeat.staleMs,
      heartbeatExpireMs: this._config.heartbeat && this._config.heartbeat.expireMs,
      profileAutopilot: this._vehicle ? this._vehicle.autopilot : null,
    });
    this._forwardPeerEvents();

    this.heartbeats = new HeartbeatScheduler({
      now: this._now,
      logger: this._logger,
      setInterval: this._setInterval,
      clearInterval: this._clearInterval,
      health: (id) => !this._faults.has(id),
      emit: ({ identity, message }) => {
        this._enqueueOutbound(message, BAND.LIVENESS, identity, null);
        this._pump();
      },
    });
    for (const identity of this._identities) this.heartbeats.add(identity);

    this._wire = this._buildWire();
    this._transport = this._transportFactory(this._config.transport, {
      dgram: this._deps.dgram,
      net: this._deps.net,
      SerialPort: this._deps.SerialPort,
      logger: this._logger,
    });
    this._transport.on('error', (err) => this._onTransportError(err));
    this._transport.on('message', (datagram) => this._onDatagram(datagram));
    this._transport.on('endpoint-gone', (endpoint) => this._releaseEndpointDecoder(endpoint));

    this._setState(STATE.CONNECTING);
    await this._transport.open();
    // A redeploy can call close() while open() is still in flight. Resuming here
    // would re-arm heartbeat and sweep timers that nothing will ever clear and
    // heartbeat onto a closed socket, so release the transport we just opened and
    // stay closed (§7 "release locks and stop timers on *every* exit path").
    if (this._closed) {
      this._transport.close(() => {});
      return;
    }
    this._ready = true;
    this._setState(STATE.CONNECTED);

    this.heartbeats.start();
    this._startSweep();
    this._pump();
  }

  /**
   * Register an inbound subscriber. Returns an unsubscribe handle the caller
   * invokes in its own `close` (§7 subscriptions).
   *
   * @param {object|null} filter  { message, sysid, compid }; null matches all
   * @param {Function} handler  receives a deep copy per message
   * @returns {() => void}
   */
  subscribe(filter, handler) {
    return this.subscriptions.subscribe(filter, handler);
  }

  /**
   * Enqueue an outbound message. Resolves the identity (an override not in the
   * bound set is rejected — never falls back to the default, §13) and hands the
   * envelope to the band queue; the driver sends it.
   *
   * @param {object} message  decoded-shape message { name, fields }
   * @param {object} [options]
   * @param {number} [options.band]  defaults to Control
   * @param {string} [options.identityId]  identity override
   * @param {{sysid: number, compid: number}} [options.target]  destination
   * @returns {object} the queued item
   */
  send(message, options = {}) {
    const resolve = this._deps.resolveIdentity || require('../identity').resolveIdentity;
    const resolved = resolve({
      defaultIdentityId: this._defaultIdentityId,
      boundIdentityIds: this._boundIdentityIds,
      overrideId: options.identityId,
    });
    const identity = this._identitiesById.get(resolved.identityId);
    const band = options.band === undefined ? BAND.CONTROL : options.band;
    const item = this._enqueueOutbound(message, band, identity, options.target || null);
    this._pump();
    return item;
  }

  /**
   * Mark an identity faulted so its heartbeat is suppressed until cleared
   * (§7 "A faulted component must not heartbeat").
   *
   * @param {string} identityId
   */
  setFault(identityId) {
    this._faults.add(identityId);
  }

  /** @param {string} identityId */
  clearFault(identityId) {
    this._faults.delete(identityId);
  }

  /**
   * Tear down timers, the socket, and all state, then call `done` exactly once.
   * Uses only references bound at start; never re-resolves a config node.
   *
   * @param {() => void} [done]
   */
  close(done) {
    // Read by start() after its `await open()`, so a close that lands mid-dial
    // is not undone by the rest of start().
    this._closed = true;

    const finish = () => {
      if (this._doneCalled) return;
      this._doneCalled = true;
      this._setState(STATE.CLOSED);
      if (done) done();
    };

    if (this.heartbeats) this.heartbeats.stop();
    this._stopSweep();
    if (this.queue) this.queue.clear();
    if (this.subscriptions) this.subscriptions.clear();
    if (this._wire && typeof this._wire.clearDecoders === 'function') {
      this._wire.clearDecoders();
    }
    this._ready = false;

    if (this._transport) {
      this._transport.close(finish);
    } else {
      finish();
    }
  }

  /**
   * Build an outbound envelope and enqueue it. The envelope mirrors the
   * message name so the queue's Streaming coalescing key is correct, and
   * carries the resolved identity and target the driver needs to serialize and
   * address the frame.
   *
   * @param {object} message
   * @param {number} band
   * @param {object} identity  resolved identity snapshot
   * @param {{sysid: number, compid: number}|null} target
   * @returns {object}
   */
  _enqueueOutbound(message, band, identity, target) {
    const envelope = { name: message.name, message, identity, target };
    const targetKey = target ? `${target.sysid}.${target.compid}` : '';
    return this.queue.enqueue({
      band,
      message: envelope,
      identityId: identity.id,
      target: targetKey,
    });
  }

  /**
   * The driver (§7 "Scheduling is the driver's"): dequeue one item, serialize
   * it, write it, and use the transport's completion callback as the release —
   * only then dequeue the next. This keeps the socket buffer shallow so band
   * priority is not defeated at the kernel boundary.
   */
  _pump() {
    if (!this._ready || this._draining) return;
    const item = this.queue.dequeue();
    if (!item) return;
    this._draining = true;

    const envelope = item.message;
    const identity = envelope.identity;
    const target = envelope.target;
    const endpoint = target ? this.peerTable.endpointFor(target.sysid, target.compid) : null;

    let buffer;
    try {
      buffer = this._wire.serialize(envelope.message, {
        sysid: identity.sysid,
        compid: identity.compid,
        seq: this.signing.nextSeq(),
        sign: this.signing.signOutbound,
        linkId: this.signing.linkId,
        key: this._config.signing && this._config.signing.key,
        timestamp: this.signing.nextOutboundTimestamp(identity.sysid, identity.compid),
      });

      if (typeof this._transport.setDscp === 'function') {
        this._transport.setDscp(item.dscp, endpoint);
      }
    } catch (err) {
      // serialize throws for a message name absent from the dialect. Uncaught it
      // leaves `_draining` set — the queue wedges and heartbeats stop while the
      // badge still reads connected — and from a timer tick or transport callback
      // it kills the runtime (§2). Drop this one envelope, say so, keep draining.
      this._draining = false;
      this._logger.error(`outbound dropped (${envelope.name}): ${err.message}`);
      this._pump();
      return;
    }

    this._transport.send(buffer, endpoint, (err) => {
      this._draining = false;
      if (err) {
        // No peer / not connected yet: drop quietly. Heartbeats and speculative
        // sends are normal before a remote exists; warn spam is not.
        if (!TRANSPORT_QUIET_SEND_CODES.has(err.code)) {
          this._logger.warn(`outbound send failed: ${err.message}`);
          if (target) this.peerTable.markPrimaryFailed(target.sysid, target.compid);
        }
      }
      this._pump();
    });
  }

  /**
   * @param {{buffer: Buffer, address: string, port: number}} datagram
   */
  _onDatagram(datagram) {
    const endpoint = { address: datagram.address, port: datagram.port };
    const now = this._now();
    // Per-endpoint stream decoder — do not share splitter state across peers.
    const frames = this._wire.decode(datagram.buffer, endpoint, now);
    for (const frame of frames) this._onFrame(frame, endpoint, now);
  }

  /**
   * @param {{address: string, port: number}|null} endpoint
   */
  _releaseEndpointDecoder(endpoint) {
    if (this._wire && typeof this._wire.releaseDecoder === 'function') {
      this._wire.releaseDecoder(endpoint);
    }
  }

  /**
   * Apply the signing policy, enrich the peer table, and deliver a copy to
   * every matching subscriber. A rejected frame is dropped; an admitted but
   * untrusted frame (unsigned-allowlisted, or invalid-accepted) is delivered
   * flagged so nothing downstream treats it as authenticated (§7).
   *
   * @param {object} frame  a wire DecodedFrame
   * @param {{address: string, port: number}} endpoint
   * @param {number} now
   */
  _onFrame(frame, endpoint, now) {
    const verdict = this.signing.acceptInbound(
      {
        sysid: frame.sysid,
        compid: frame.compid,
        linkId: frame.linkId || 0,
        timestamp: frame.timestamp || 0,
        signaturePresent: frame.signaturePresent,
        signatureValid: frame.signatureValid,
        messageName: frame.name,
      },
      now
    );
    if (!verdict.accept) {
      this.emit('rejected', { frame, reason: verdict.reason });
      return;
    }
    const decoded = {
      name: frame.name,
      sysid: frame.sysid,
      compid: frame.compid,
      fields: frame.fields,
      trusted: verdict.trusted,
    };
    this.peerTable.update(decoded, endpoint, now);
    this.subscriptions.dispatch(decoded);
  }

  /**
   * @returns {object} the wire adapter — injected verbatim, or built from the
   *   factory / default (which lazy-loads node-mavlink)
   */
  _buildWire() {
    if (this._deps.wire) return this._deps.wire;
    const factory = this._deps.createWire || require('./wire').createWire;
    return factory({
      bundle: this._vehicle && this._vehicle.bundle,
      key: this._config.signing && this._config.signing.key,
    });
  }

  /** Start the peer-table freshness sweep on the stale interval. */
  _startSweep() {
    const period = (this._config.heartbeat && this._config.heartbeat.staleMs) || 5000;
    // Match PeerTable's default heartbeatExpireMs (15s) when the editor leaves
    // expireMs blank — a longer decoder idle would reuse stale splitter bytes
    // after the peer entry had already expired (Codex #35).
    const idleMs =
      (this._config.heartbeat && this._config.heartbeat.expireMs) || 15_000;
    this._sweepTimer = this._setInterval(() => {
      this.peerTable.sweep();
      // Idle decoder eviction is UDP-only (§7): TCP/serial keep open-stream
      // partials until endpoint-gone or Connection close. A long gap between
      // TCP chunks must not wipe framing state.
      const mode = this._config.transport && this._config.transport.mode;
      if (
        mode === 'udp' &&
        this._wire &&
        typeof this._wire.evictIdleDecoders === 'function'
      ) {
        this._wire.evictIdleDecoders(this._now(), idleMs);
      }
    }, period);
    if (this._sweepTimer && typeof this._sweepTimer.unref === 'function') {
      this._sweepTimer.unref();
    }
  }

  _stopSweep() {
    if (!this._sweepTimer) return;
    this._clearInterval(this._sweepTimer);
    this._sweepTimer = null;
  }

  /** Re-emit peer-table events on the connection so the node can badge them. */
  _forwardPeerEvents() {
    const events = [
      'peer-new',
      'component-new',
      'stale',
      'expired',
      'primary-changed',
      'multi-endpoint',
      'profile-mismatch',
      'statustext',
    ];
    for (const name of events) {
      this.peerTable.on(name, (payload) => this.emit(`peer:${name}`, payload));
    }
  }

  /**
   * A transport `error` event. Unhandled it would kill the Node-RED runtime
   * (§2); handled it surfaces as connection state and a logged error.
   *
   * @param {Error} err
   */
  _onTransportError(err) {
    // Stop the driver pump — CONNECTED with a dead TCP/serial socket would keep
    // dequeuing into quiet no-destination failures forever.
    this._ready = false;
    this._draining = false;
    this._logger.error(`transport error: ${err.message}`);
    this._setState(STATE.ERROR);
    this.emit('transport-error', err);
  }

  /** @param {string} state */
  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this.emit('state', state);
  }
}

module.exports = { Connection, STATE };
