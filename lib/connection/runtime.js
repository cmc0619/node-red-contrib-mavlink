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

/**
 * Upper bound on one transport write's completion callback (issue #244). All
 * three transports gate the callback on an unbounded event — TCP and serial on
 * 'drain', UDP on dgram's callback — so a peer that stops reading (full TCP
 * window to a black-holed peer, serial flow-control stall) would otherwise
 * leave `_draining` true forever: the queue wedges silently, heartbeats stop,
 * and the vehicle's GCS-loss failsafe fires while the node still shows
 * CONNECTED. Order of seconds: far above any healthy link's drain time, far
 * below an operator noticing a silent wedge.
 */
const WRITE_TIMEOUT_MS = 5000;

/**
 * Reconnect backoff bounds. A dropped link that once worked is redialed from a
 * fresh transport on a jittered exponential schedule: first retry inside
 * {@link RECONNECT_BASE_MS}, doubling to a ceiling of {@link RECONNECT_CAP_MS},
 * forever — a vehicle that returns hours later still recovers, and redeploy
 * always wins because close() cancels the pending attempt. The jitter exists
 * for the fleet case: several connections losing one SITL host or router must
 * not redial in lockstep. Only an *established* link recovers this way; a
 * transport that never opened fails the deploy loud, exactly as before —
 * retrying a config that has never once worked would bury an editor mistake
 * (wrong port, missing device) under an eternally yellow badge.
 */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30_000;

/** Connection state-machine values, mapped to §6 config-node badges by the node. */
const STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
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
    this._setTimeout = deps.setTimeout || setTimeout;
    this._clearTimeout = deps.clearTimeout || clearTimeout;
    this._logger = deps.logger || { info() {}, warn() {}, error() {} };
    this._transportFactory = deps.transportFactory || createTransport;
    this._random = deps.random || Math.random;

    // Bind references at construction so close() tears down exactly what start()
    // wired up, never re-resolving a config node (§7 teardown).
    this._disabled = !!config.disabled;
    this._identities = config.identities.slice();
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
    /** @type {Map<string, *>} identityId -> pending health-lease timer handle */
    this._healthLeases = new Map();

    this._transport = null;
    this._wire = null;
    this._sweepTimer = null;
    this._writeTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    // Reconnect is recovery of a link that once worked, never a retry loop on
    // a config that has never opened — deploy-time failures stay loud (§2).
    this._everConnected = false;
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
        // A HEARTBEAT carries no target fields and is addressed to everyone,
        // so it rides _pump's broadcast ladder (§14.63: configured broadcast
        // address, else every learned peer primary, else the configured
        // remote) — a null target would take the directed path and reach only
        // the configured remote, starving every other star peer. Compid 0 is
        // MAV_COMP_ID_ALL: the lookup expands it to every learned component's
        // endpoint (deduped), so a companion-only system or second GCS hears
        // it too — an autopilot-only lookup would skip them with no fallback.
        this._enqueueOutbound(message, BAND.LIVENESS, identity, { sysid: 0, compid: 0 });
        this._pump();
      },
    });
    for (const identity of this._identities) this.heartbeats.add(identity);

    this._wire = this._buildWire();
    this._transport = this._buildTransport();

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
    this._everConnected = true;
    this._setState(STATE.CONNECTED);

    this.heartbeats.start();
    this._startSweep();
    this._pump();
  }

  /**
   * Construct a transport from the bound config and attach the runtime's
   * handlers. One implementation for the deploy-time open and every reconnect
   * attempt (§2) — recovery redials the same config, it does not re-resolve it.
   *
   * @returns {object} the transport
   */
  _buildTransport() {
    const transport = this._transportFactory(this._config.transport, {
      dgram: this._deps.dgram,
      net: this._deps.net,
      SerialPort: this._deps.SerialPort,
      logger: this._logger,
    });
    transport.on('error', (err) => this._onTransportError(err));
    transport.on('message', (datagram) => this._onDatagram(datagram));
    transport.on('endpoint-gone', (endpoint) => this._releaseEndpointDecoder(endpoint));
    return transport;
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
   * Resolve the outbound identity a send with `identityId` would use — the
   * one resolution path shared by send() and resolveSourceIds(). Throws when
   * the identity cannot resolve (send's loud path).
   *
   * @param {string} [identityId]  identity override
   * @returns {object}  identity record ({sysid, compid, ...})
   */
  _resolveOutboundIdentity(identityId) {
    const resolve = this._deps.resolveIdentity || require('../identity').resolveIdentity;
    const resolved = resolve({
      defaultIdentityId: this._defaultIdentityId,
      boundIdentityIds: this._boundIdentityIds,
      overrideId: identityId,
    });
    return this._identitiesById.get(resolved.identityId);
  }

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
      const identity = this._resolveOutboundIdentity(identityId);
      return identity ? { sysid: identity.sysid, compid: identity.compid } : null;
    } catch {
      return null;
    }
  }

  send(message, options = {}) {
    const identity = this._resolveOutboundIdentity(options.identityId);
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
   * Flow-facing health assertion with an expiring lease (§7 "A faulted
   * component must not heartbeat", extended to the flow that feeds it). A
   * healthy assertion clears the fault and arms a countdown for `ttlMs`; a
   * renewal before it fires replaces the countdown, and letting it fire
   * faults the identity on its own — the companion-failsafe posture, where a
   * flow that has gone quiet reads as unhealthy rather than "still fine"
   * (heartbeat.js's own rule for the wire, applied here to the lease). An
   * unhealthy assertion faults immediately and drops any pending countdown —
   * there is nothing left to wait for. Emits 'health-expired' only on the
   * timer path; an explicit assertion is already known to its own caller. An
   * assertion landing after close() throws into the caller's failure path: a
   * timer armed after close() cleared the lease map would fire into torn-down
   * state (§7 teardown race — the same class the write and reconnect timers
   * guard), and a silent drop would let the asserting node report `healthy`
   * for a lease that was never armed (§2 no phantom success).
   *
   * @param {string} identityId
   * @param {boolean} healthy
   * @param {number} ttlMs  ignored when `healthy` is false
   * @throws {Error} on a closed connection
   */
  assertHealth(identityId, healthy, ttlMs) {
    // An assertion racing redeploy teardown must not arm a timer nothing will
    // cancel — and it must not no-op either, because the asserting node would
    // then report `healthy` for a lease that was never armed. Refusing loud is
    // the §2 "no phantom success" posture, into the node's existing failure
    // path.
    if (this._closed) {
      throw new Error('health assertion on a closed connection — the link was torn down');
    }
    // A lease on an id this Connection does not heartbeat would report
    // healthy while no scheduler is bound to it (§0 rule 3 — false success).
    if (!this._identitiesById.has(identityId)) {
      throw new Error(`health assertion for identity '${identityId}' — not bound to this connection`);
    }
    const pending = this._healthLeases.get(identityId);
    if (pending) this._clearTimeout(pending);
    this._healthLeases.delete(identityId);
    if (!healthy) {
      this.setFault(identityId);
      return;
    }
    this.clearFault(identityId);
    const timer = this._setTimeout(() => {
      this._healthLeases.delete(identityId);
      this.setFault(identityId);
      this.emit('health-expired', { identityId });
    }, ttlMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this._healthLeases.set(identityId, timer);
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
    // A pending write timer must not fire after teardown — it would flip
    // CLOSED into ERROR from a link that was deliberately taken down (#244).
    this._disarmWriteTimer();
    // A pending redial must not fire after teardown — redeploy wins over
    // recovery, and a reconnect landing after close would resurrect a socket
    // nothing owns.
    if (this._reconnectTimer) {
      this._clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    // A pending health lease must not fire after teardown — the identity it
    // would fault may already be reused by the next deploy's Connection.
    for (const timer of this._healthLeases.values()) this._clearTimeout(timer);
    this._healthLeases.clear();
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
   * priority is not defeated at the kernel boundary. The release is bounded by
   * {@link WRITE_TIMEOUT_MS}; a write that never completes faults the link.
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
    let settled = false;
    for (const destination of destinations) {
      if (typeof this._transport.setDscp === 'function') {
        this._transport.setDscp(item.dscp, destination);
      }
      this._transport.send(buffer, destination, (err) => {
        if (settled) return;
        if (err && !failure) failure = err;
        pending -= 1;
        // Every destination has reported; the item is done either way.
        if (pending > 0) return;
        settled = true;
        this._disarmWriteTimer();
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
    // Bound the completion callback (issue #244): a transport that accepts the
    // write but never completes it must fault the link within WRITE_TIMEOUT_MS,
    // not wedge _draining forever. Expiry routes through the same
    // transport-error machinery a socket error uses; `settled` makes any late
    // completion a no-op so it cannot double-release the pump or mutate the
    // peer table of a faulted link. Armed only when a write is still in flight
    // after the send loop — a synchronously completing transport (unblocked
    // TCP write, immediate failure) has already settled, and a timer created
    // just to be cleared in the same tick is churn per frame at streaming
    // rates. A persistent `refresh()`ed handle is not an option: timers come
    // through injected deps.setTimeout/clearTimeout (fake clocks in tests),
    // which promise no Node Timeout surface. If a sync completion re-entered
    // _pump above, `settled` is true here and the recursion's own timer is
    // left untouched.
    if (!settled) {
      this._writeTimer = this._setTimeout(() => {
        settled = true;
        this._writeTimer = null;
        const err = new Error(
          `outbound write timed out after ${WRITE_TIMEOUT_MS}ms (${envelope.name})`
        );
        err.code = 'WRITE_TIMEOUT';
        this._onTransportError(err);
      }, WRITE_TIMEOUT_MS);
      if (this._writeTimer && typeof this._writeTimer.unref === 'function') {
        this._writeTimer.unref();
      }
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
    // Multicast loopback returns our own transmissions. A component does not
    // treat its own frames as peer traffic (standard MAVLink routing posture),
    // so an exact bound (sysid, compid) is our echo and drops silently — the
    // same sysid under a different compid is a real peer (a companion).
    if (this._identities.some((id) => id.sysid === frame.sysid && id.compid === frame.compid)) {
      return;
    }
    const verdict = this.signing.acceptInbound(
      {
        sysid: frame.sysid,
        compid: frame.compid,
        linkId: frame.linkId,
        timestamp: frame.timestamp,
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
    // The thresholds resolve in the peer table (blank config falls back there)
    // — the sweep runs on its stale period and the UDP idle-decoder TTL is its
    // expire period, so the timer and the table can never disagree (#35).
    const period = this.peerTable.staleMs;
    const idleMs = this.peerTable.expireMs;
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

  /** Disarm the in-flight write's completion timer (issue #244). */
  _disarmWriteTimer() {
    if (!this._writeTimer) return;
    this._clearTimeout(this._writeTimer);
    this._writeTimer = null;
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
    // A socket error can arrive with a write still in flight whose completion
    // callback never comes (dgram does not fail pending sends on error); its
    // timer must not fire a second, spurious transport-error later (#244).
    this._disarmWriteTimer();
    // Stop the heartbeat scheduler: it would only pile frames into a pump that
    // does not drain (issue #93); reconnect restarts it. The sweep stays
    // RUNNING deliberately — mavlink-state consumes the peer table while the
    // link is down (stale/expired transitions come only from sweep()), and a
    // dead transport is precisely when "vehicle lost" must still fire.
    if (this.heartbeats) this.heartbeats.stop();
    this._logger.error(`transport error: ${err.message}`);
    this.emit('transport-error', err);
    if (this._closed) return;
    if (this._everConnected) {
      // A link that once worked is redialed on the backoff schedule.
      this._scheduleReconnect();
      return;
    }
    // A transport that never opened is a deploy problem, not an outage:
    // ERROR stays terminal until redeploy, loud at the moment the operator is
    // looking at the editor (§2).
    this._setState(STATE.ERROR);
  }

  /**
   * Tear down the dead transport and arm one backoff timer for the next
   * attempt. Idempotent while a timer is pending: a socket error and its
   * close-cascade both land here, and must schedule one redial, not two.
   */
  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    const dead = this._transport;
    this._transport = null;
    if (dead) {
      // The old transport's teardown events must not re-enter this machinery —
      // but a dying socket can still emit 'error' (an ECONNRESET during end, a
      // late ICMP), the wrappers forward it, and an EventEmitter 'error' with
      // no listener throws: the §2 process-kill (Codex #334). So the corpse
      // keeps exactly one listener — a sink.
      dead.removeAllListeners();
      dead.on('error', () => {});
      dead.close(() => {});
    }
    // Fresh streams start clean: a reconnected TCP peer reuses its endpoint
    // key, and inheriting a dead stream's partial frame would corrupt the
    // first packets of the new one.
    if (this._wire && typeof this._wire.clearDecoders === 'function') {
      this._wire.clearDecoders();
    }
    this._setState(STATE.RECONNECTING);
    // The outer min also absorbs the far tail: past ~1024 attempts 2**n
    // overflows to Infinity, and min(cap, Infinity) is still the cap.
    const ceiling = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * 2 ** this._reconnectAttempts
    );
    // Half-jitter: the delay lands in [ceiling/2, ceiling).
    const delayMs = Math.floor(ceiling / 2 + this._random() * (ceiling / 2));
    this._reconnectAttempts += 1;
    this._logger.warn(
      `reconnecting in ${delayMs}ms (attempt ${this._reconnectAttempts})`
    );
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null;
      // open() rejections are handled inside; this catch is for the recovery
      // machinery itself breaking. An unhandled rejection here would kill the
      // whole Node-RED runtime (§2), so it lands as terminal ERROR instead —
      // loud, locatable, and no longer pretending to recover.
      this._attemptReconnect().catch((err) => {
        this._logger.error(`reconnect machinery failed: ${err.message}`);
        this._setState(STATE.ERROR);
      });
    }, delayMs);
    if (this._reconnectTimer && typeof this._reconnectTimer.unref === 'function') {
      this._reconnectTimer.unref();
    }
  }

  /**
   * One redial: a fresh transport from the bound config. Success resumes the
   * full runtime — heartbeats, pump, whatever queued during the outage;
   * failure re-enters the backoff schedule. An error event fired during
   * open() reaches _onTransportError first and schedules the next attempt
   * itself, which is why the catch below funnels into the same idempotent
   * _scheduleReconnect rather than owning a retry path of its own.
   */
  async _attemptReconnect() {
    if (this._closed) return;
    const transport = this._buildTransport();
    this._transport = transport;
    try {
      await transport.open();
    } catch (err) {
      if (this._closed) return;
      this._logger.warn(`reconnect failed: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    if (this._closed) {
      // close() ran while we were opening — same race as start()'s (§7).
      transport.close(() => {});
      return;
    }
    if (this._transport !== transport) {
      // An error event landed while open() was settling (CodeRabbit #334):
      // _onTransportError already detached this transport and armed the next
      // redial. Recovery belongs to that attempt — this stale continuation
      // declaring CONNECTED would reset the backoff and point the resumed
      // pump and heartbeats at a nulled transport: a TypeError inside a
      // timer callback, which takes the whole Node-RED runtime with it (§2).
      transport.close(() => {});
      return;
    }
    this._reconnectAttempts = 0;
    // Recovery resumes live traffic, never stale intent (owner ruling,
    // 2026-08-18). Everything queued against the dead link already reported
    // its loud failure — ack waiters time out in seconds — so transmitting
    // those frames now would have the vehicle act on commands the flows were
    // told failed: a phantom action, the mirror of the phantom success §2
    // forbids. Cleared here, at the last moment before the pump resumes, so
    // the outage has no tail: items enqueued before and during the drop die
    // together.
    this.queue.clear();
    this._ready = true;
    this._setState(STATE.CONNECTED);
    this._logger.info('transport reconnected');
    this.heartbeats.start();
    this._pump();
  }

  /** @param {string} state */
  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this.emit('state', state);
  }
}

module.exports = {
  Connection,
  STATE,
  WRITE_TIMEOUT_MS,
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
};
