'use strict';

/**
 * Per-identity heartbeat emission (DESIGN.md §7 "Heartbeat"). The spec is
 * explicit: components must regularly broadcast HEARTBEAT, even when not
 * commanding anything — ArduPilot's GCS failsafe fires on heartbeat loss, so
 * stopping is not free.
 *
 * **Ownership splits.** Local Identity owns the *content* and *interval* (type,
 * autopilot field, system status, source IDs, and rate); this scheduler is the
 * connection-side send-path detail that enqueues due identity heartbeats on a
 * link. An identity bound to two connections heartbeats on both links.
 *
 * **A faulted component must not heartbeat.** The emitter reads health rather
 * than running as a blind timer: a fatal condition stops the heartbeat and it
 * resumes when the condition clears, logged once at each transition. A dead
 * companion that keeps announcing itself is worse than one that goes quiet,
 * because silence is a signal every other participant already reads.
 *
 * MAVLink does not define a heartbeat rate. Local Identity defaults to 1 Hz,
 * while the peer table's stale threshold remains an inbound freshness setting.
 */

/** MAVLink wire version carried in HEARTBEAT — v2 only on transmit (§1). */
const MAVLINK_VERSION = 3;
/** MAV_STATE_ACTIVE — the default reported status absent a health override. */
const MAV_STATE_ACTIVE = 4;

/**
 * @typedef {object} HeartbeatIdentity
 * @property {string} id  the Local Identity node id
 * @property {number} sysid  source system id
 * @property {number} compid  source component id
 * @property {number} [heartbeatIntervalMs]  Local Identity heartbeat interval
 * @property {{type: number, autopilot: number, systemStatus?: number}} heartbeat
 *   heartbeat content owned by the identity
 */

/**
 * @typedef {boolean|{healthy: boolean, systemStatus?: number}} HealthResult
 * A bare boolean, or an object that also supplies the live MAV_STATE so the
 * heartbeat reflects actual state rather than a constant.
 */

class HeartbeatScheduler {
  /**
   * @param {object} options
   * @param {(entry: {identity: HeartbeatIdentity, message: object}) => void} options.emit
   *   called with a built HEARTBEAT for a healthy identity; the runtime enqueues
   *   it on the Liveness band
   * @param {(identityId: string) => HealthResult} [options.health]  read once per
   *   identity per tick; a falsey / `{healthy:false}` result suppresses emission
   * @param {number} [options.intervalMs]  fallback emission period (default 1000)
   * @param {() => number} [options.now]
   * @param {{info: Function, warn: Function}} [options.logger]
   * @param {Function} [options.setInterval]
   * @param {Function} [options.clearInterval]
   */
  constructor(options) {
    this._emit = options.emit;
    this._health = options.health || (() => true);
    this._intervalMs = options.intervalMs || 1000;
    this._now = options.now || Date.now;
    this._logger = options.logger || { info() {}, warn() {} };
    this._setInterval = options.setInterval || setInterval;
    this._clearInterval = options.clearInterval || clearInterval;
    /** @type {Map<string, HeartbeatIdentity>} */
    this._identities = new Map();
    /** @type {Map<string, boolean>} last observed health per identity */
    this._lastHealthy = new Map();
    /** @type {Map<string, number>} last heartbeat emit time per identity */
    this._lastEmitAt = new Map();
    this._timer = null;
  }

  /**
   * Bind an identity to heartbeat on this connection. Idempotent per id.
   *
   * @param {HeartbeatIdentity} identity
   */
  add(identity) {
    this._identities.set(identity.id, identity);
    this._restartIfRunning();
  }

  /**
   * @param {string} identityId
   */
  remove(identityId) {
    this._identities.delete(identityId);
    this._lastHealthy.delete(identityId);
    this._lastEmitAt.delete(identityId);
    this._restartIfRunning();
  }

  /** Start the base timer. Safe to call twice. */
  start() {
    if (this._timer) return;
    this._timer = this._setInterval(() => this.tick(), this._baseIntervalMs());
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** Stop and release the timer (teardown). */
  stop() {
    if (!this._timer) return;
    this._clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * Emit one round of heartbeats. Exposed for deterministic tests; the timer
   * calls it internally.
   */
  tick() {
    const now = this._now();
    for (const identity of this._identities.values()) {
      const intervalMs = this._identityIntervalMs(identity);
      const lastEmitAt = this._lastEmitAt.get(identity.id);
      if (lastEmitAt !== undefined && now - lastEmitAt < intervalMs) continue;
      const health = normalizeHealth(this._health(identity.id));
      const was = this._lastHealthy.get(identity.id);
      if (!health.healthy) {
        if (was !== false) {
          this._logger.warn(
            `identity ${identity.id} faulted; suppressing heartbeat until it clears`
          );
        }
        this._lastHealthy.set(identity.id, false);
        continue;
      }
      if (was === false) {
        this._logger.info(`identity ${identity.id} healthy again; resuming heartbeat`);
      }
      this._lastHealthy.set(identity.id, true);
      this._emit({ identity, message: buildHeartbeat(identity, health.systemStatus) });
      this._lastEmitAt.set(identity.id, now);
    }
  }

  /** @returns {number} number of bound identities */
  size() {
    return this._identities.size;
  }

  /** @returns {number} smallest configured identity heartbeat interval */
  _baseIntervalMs() {
    let min = this._intervalMs;
    for (const identity of this._identities.values()) {
      min = Math.min(min, this._identityIntervalMs(identity));
    }
    return min;
  }

  /**
   * @param {HeartbeatIdentity} identity
   * @returns {number}
   */
  _identityIntervalMs(identity) {
    return identity.heartbeatIntervalMs || this._intervalMs;
  }

  _restartIfRunning() {
    if (!this._timer) return;
    this.stop();
    this.start();
  }
}

/**
 * @param {HealthResult} result
 * @returns {{healthy: boolean, systemStatus: number|undefined}}
 */
function normalizeHealth(result) {
  if (typeof result === 'object' && result !== null) {
    return { healthy: !!result.healthy, systemStatus: result.systemStatus };
  }
  return { healthy: !!result, systemStatus: undefined };
}

/**
 * Build a HEARTBEAT for an identity. Node-RED is not a flight controller, so
 * `base_mode` and `custom_mode` are zero and the autopilot field is whatever
 * the identity declares (MAV_AUTOPILOT_INVALID for GCS/companion). MAV_STATE
 * comes from the live health read when supplied, else the identity's configured
 * status, else MAV_STATE_ACTIVE.
 *
 * @param {HeartbeatIdentity} identity
 * @param {number} [systemStatusOverride]
 * @returns {object} a decoded-shape HEARTBEAT ready for the wire codec
 */
function buildHeartbeat(identity, systemStatusOverride) {
  const hb = identity.heartbeat;
  const systemStatus =
    systemStatusOverride !== undefined
      ? systemStatusOverride
      : hb.systemStatus !== undefined
        ? hb.systemStatus
        : MAV_STATE_ACTIVE;
  return {
    name: 'HEARTBEAT',
    sysid: identity.sysid,
    compid: identity.compid,
    fields: {
      type: hb.type,
      autopilot: hb.autopilot,
      base_mode: 0,
      custom_mode: 0,
      system_status: systemStatus,
      mavlink_version: MAVLINK_VERSION,
    },
  };
}

module.exports = { HeartbeatScheduler, buildHeartbeat };
