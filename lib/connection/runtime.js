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
const {
  createTransport,
  TRANSPORT_QUIET_SEND_CODES,
  TRANSPORT_TRANSIENT_SEND_CODES,
} = require('./transport');

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
   * @param {object} config.vehicle  bound Vehicle Profile snapshot: targetSystem,
   *   targetComponent, bundle, and optional MAV_AUTOPILOT for mismatch detection
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
    this._draining = false;
    this._started = false;
    this._faults = new Set();

    this._transport = null;
    this._wire = null;
    this._sweepTimer = null;
    this._doneCalled = false;
    // Set by close(); start() re-checks it after the transport-open await so a
    // close() that raced an in-flight start() cannot resume into CONNECTED
    // with heartbeat/sweep timers that close() already tore down (§7 teardown
    // race — mirrors the same check in transport/serial.js's open()).
    this._closed = false;

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
    /** Targets already warned about missing endpoints — re-armed on resolve. */
    this._fallbackWarned = new Set();
    const check = this.signing.validate();
    if (!check.ok) {
      this._setState(STATE.ERROR);
      throw new Error(check.reason);
    }

    this.queue = new OutboundQueue({ ...(this._config.queue || {}), now: this._now });
    this.subscriptions = new SubscriptionRegistry({ logger: this._logger });
    this.peerTable = new PeerTable({
      now: this._now,
      heartbeatStaleMs: this._config.heartbeat && this._config.heartbeat.staleMs,
      heartbeatExpireMs: this._config.heartbeat && this._config.heartbeat.expireMs,
      profileAutopilot: this._vehicle ? this._vehicle.autopilot : null,
    });
    this._forwardPeerEvents();
    // Re-arm the missing-endpoint warning the moment an endpoint is learned —
    // not only when a send happens to occur while it is known. Otherwise
    // warn → endpoint learned → endpoint expired → next fallback stays silent.
    this.peerTable.on('endpoint-added', ({ sysid, compid }) => {
      this._fallbackWarned.delete(`${sysid}/${compid}`);
    });

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
    try {
      await this._transport.open();
    } catch (err) {
      // A transport settles its in-flight open() when close() races it (e.g.
      // TCP destroy-during-connect emits neither 'connect' nor 'error'). That
      // rejection means close won — stay quiet rather than surfacing a
      // spurious deploy-time ERROR from the node's start().catch().
      if (this._closed) return;
      throw err;
    }
    if (this._closed) {
      // close() ran while we were opening. Its own transport.close() call may
      // already have fired (the transport itself is idempotent either way),
      // but it could not have known this open() would still complete — so
      // this call must close it and stop here, never touching CONNECTED.
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
  /**
   * The source sysid/compid a send with this identity would stamp — for ack
   * attribution (§9/§10): a waiter that knows its own ids can ignore a
   * COMMAND_ACK explicitly addressed to a different GCS on a shared link.
   * Returns null instead of throwing when the identity cannot resolve; the
   * caller is gating, not sending, and the send path stays the loud one.
   *
   * @param {string} [identityId]  identity override, as passed to send()
   * @returns {{sysid: number, compid: number}|null}
   */
  resolveSourceIds(identityId) {
    try {
      const resolve = this._deps.resolveIdentity || require('../identity').resolveIdentity;
      const resolved = resolve({
        defaultIdentityId: this._defaultIdentityId,
        boundIdentityIds: this._boundIdentityIds,
        overrideId: identityId,
      });
      const identity = this._identitiesById.get(resolved.identityId);
      return identity ? { sysid: identity.sysid, compid: identity.compid } : null;
    } catch {
      return null;
    }
  }

  send(message, options = {}) {
    const resolve = this._deps.resolveIdentity || require('../identity').resolveIdentity;
    const resolved = resolve({
      defaultIdentityId: this._defaultIdentityId,
      boundIdentityIds: this._boundIdentityIds,
      overrideId: options.identityId,
    });
    const identity = this._identitiesById.get(resolved.identityId);
    // Serialize-validate before enqueueing, so an unencodable message (a name
    // absent from the bound dialect, a field the codec rejects) throws HERE —
    // synchronously into the sending node's existing error path — instead of
    // being dropped later by _pump()'s guard while the node reports a phantom
    // green `sent` (§2 "no phantom success"; the pump guard remains as the
    // backstop that keeps _draining from wedging). A dry run: seq 0, unsigned,
    // so no signing counter or sequence number is consumed.
    if (this._wire) {
      this._wire.serialize(message, { sysid: identity.sysid, compid: identity.compid, seq: 0 });
    }
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
    const isBroadcast = !!target && target.sysid === 0;
    const endpoint = target && !isBroadcast
      ? this.peerTable.endpointFor(target.sysid, target.compid)
      : null;

    // A targeted send with no resolved endpoint rides the transport's
    // configured-remote fallback. Legal (the frame still carries its target
    // ids, so wrong receivers drop it) but never silent (§2): warn once per
    // target until an endpoint appears, then re-arm (issue #91). The re-arm
    // rides the peer table's endpoint-added event (see start()) so it fires
    // when the endpoint is *learned*, not only if a send happens to occur
    // while it is known. Broadcast does not warn: it has destinations of its
    // own (below), and before any peer is heard the configured remote is the
    // correct and only path.
    if (target && !isBroadcast && !endpoint && !this._fallbackWarned.has(`${target.sysid}/${target.compid}`)) {
      this._fallbackWarned.add(`${target.sysid}/${target.compid}`);
      this._logger.warn(
        `no known endpoint for target ${target.sysid}/${target.compid} — sending via the configured remote (if any)`
      );
    }

    let buffer;
    try {
      buffer = this._wire.serialize(envelope.message, {
        sysid: identity.sysid,
        compid: identity.compid,
        seq: this.signing.nextSeq(identity.sysid, identity.compid),
        sign: this.signing.signOutbound,
        linkId: this.signing.linkId,
        key: this._config.signing && this._config.signing.key,
        timestamp: this.signing.nextOutboundTimestamp(identity.sysid, identity.compid),
      });
    } catch (err) {
      // serialize() throws for a message name absent from the bound dialect
      // (wire.js). Drop just this envelope rather than leaving _draining
      // stuck true, which would wedge the queue and silence heartbeats.
      this._draining = false;
      this._logger.error(`serialize failed, dropping ${envelope.name}: ${err.message}`);
      this._pump();
      return;
    }

    // One serialized frame, one or more destinations. A directed send has a
    // single destination — its endpoint, or `null` for the configured-remote
    // fallback. A broadcast resolves in preference order:
    //
    //   1. A configured broadcast address (multicast group or subnet
    //      broadcast). The medium does the fan-out, so one write is both
    //      correct and the whole point of configuring it.
    //   2. Every learned peer endpoint. `target_system = 0` only reaches
    //      everyone by itself on a shared medium; on a star each vehicle has
    //      its own return path, so "everyone" is N writes.
    //   3. The configured remote — the pre-peer path, same `null` a directed
    //      send falls back to.
    //
    // The frame is serialized once in every case: N datagrams carrying one
    // sequence number, not N frames burning N.
    const configured = isBroadcast ? this._broadcastDestination() : null;
    const learned = isBroadcast && !configured
      ? this.peerTable.endpointsForBroadcast(target.compid)
      : null;
    const destinations = configured
      ? [configured]
      : (learned && learned.length ? learned : [endpoint]);

    let pending = destinations.length;
    let failure = null;
    for (const destination of destinations) {
      if (typeof this._transport.setDscp === 'function') {
        this._transport.setDscp(item.dscp, destination);
      }
      this._transport.send(buffer, destination, (err) => {
        if (err && !failure) failure = err;
        pending -= 1;
        // Every destination has reported; the item is done either way.
        if (pending > 0) return;
        this._draining = false;
        if (failure && !TRANSPORT_QUIET_SEND_CODES.has(failure.code)) {
          // No peer / not connected yet: drop quietly. Heartbeats and
          // speculative sends are normal before a remote exists; warn spam is
          // not.
          this._logger.warn(`outbound send failed: ${failure.message}`);
          // Demote the endpoint only on non-transient failures — an ICMP
          // unreachable while the peer reboots must not turn one lost packet
          // into a permanently forgotten address (issue #91). Truly dead
          // peers age out via the expiry sweep instead. A broadcast has no
          // single primary to demote, and one unreachable vehicle must not
          // cost the others their addresses.
          if (target && !isBroadcast && !TRANSPORT_TRANSIENT_SEND_CODES.has(failure.code)) {
            this.peerTable.markPrimaryFailed(target.sysid, target.compid);
          }
        }
        this._pump();
      });
    }
  }

  /**
   * The transport's single reaches-everyone address, when it has one.
   *
   * Only UDP offers this: a multicast group or a broadcast address, where the
   * network itself does the fan-out and one write is the entire point of having
   * configured it.
   *
   * The other two need nothing. TCP cannot broadcast at all — it is
   * connection-oriented unicast — but a TCP server does not have to, because
   * each accepted client is its own learned endpoint and the fan-out above
   * already writes to every one of them. Serial is a real bus: every peer on the
   * wire records the same endpoint, so the fan-out dedupes to a single write on
   * its own.
   *
   * @returns {{address: string, port: number}|null}
   */
  _broadcastDestination() {
    if (typeof this._transport.broadcastDestination !== 'function') return null;
    return this._transport.broadcastDestination();
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
    // ERROR is terminal until redeploy (§2 declines speculative reconnects),
    // so stop the heartbeat scheduler: it would only pile frames into a pump
    // that never drains (issue #93). The sweep stays RUNNING deliberately —
    // mavlink-state consumes the peer table after ERROR (stale/expired
    // transitions come only from sweep()), and a dead transport is precisely
    // when "vehicle lost" must still fire.
    if (this.heartbeats) this.heartbeats.stop();
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
