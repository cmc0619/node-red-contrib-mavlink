'use strict';

/**
 * Per-identity heartbeat emission (DESIGN.md §7 "Heartbeat"). The spec is
 * explicit: components must regularly broadcast HEARTBEAT, even when not
 * commanding anything — ArduPilot's GCS failsafe fires on heartbeat loss, so
 * stopping is not free.
 *
 * **Ownership splits.** Local Identity owns the *content* and *interval* (type,
 * autopilot field, source IDs, and rate); this scheduler is the
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
/** MAV_STATE_ACTIVE — the status every heartbeat this emitter sends carries. */
const MAV_STATE_ACTIVE = 4;

/**
 * @typedef {object} HeartbeatIdentity
 * @property {string} id  the Local Identity node id
 * @property {number} sysid  source system id
 * @property {number} compid  source component id
 * @property {number} heartbeatIntervalMs  Local Identity heartbeat interval
 * @property {{type: number, autopilot: number}} heartbeat
 *   heartbeat content owned by the identity
 */

class HeartbeatScheduler {
  /**
   * @param {object} options
   * @param {(entry: {identity: HeartbeatIdentity, message: object}) => void} options.emit
   *   called with a built HEARTBEAT for a healthy identity; the runtime enqueues
   *   it on the Liveness band
   * @param {(identityId: string) => boolean} options.health  read once per
   *   beat; false suppresses that identity's emission
   * @param {{info: Function, warn: Function}} options.logger
   * @param {Function} options.setInterval
   * @param {Function} options.clearInterval
   */
  constructor(options) {
    this._emit = options.emit;
    this._health = options.health;
    this._logger = options.logger;
    this._setInterval = options.setInterval;
    this._clearInterval = options.clearInterval;
    /** @type {Map<string, HeartbeatIdentity>} */
    this._identities = new Map();
    /** @type {Map<string, boolean>} last observed health per identity */
    this._lastHealthy = new Map();
    /** @type {Map<string, *>} identity id -> its own interval handle */
    this._timers = new Map();
  }

  /**
   * Bind an identity to heartbeat on this connection. Idempotent per id.
   *
   * @param {HeartbeatIdentity} identity
   */
  add(identity) {
    this._identities.set(identity.id, identity);
  }

  /**
   * Start one interval per identity, each on that identity's own
   * `heartbeatIntervalMs`, so a 1500 ms identity beats every 1500 ms beside a
   * 1000 ms one. Safe to call twice.
   */
  start() {
    if (this._timers.size > 0) return;
    for (const identity of this._identities.values()) {
      const timer = this._setInterval(() => this._beat(identity), identity.heartbeatIntervalMs);
      timer.unref();
      this._timers.set(identity.id, timer);
    }
  }

  /** Stop and release every identity's timer (teardown). */
  stop() {
    for (const timer of this._timers.values()) this._clearInterval(timer);
    this._timers.clear();
  }

  /** Emit one heartbeat for every bound identity now. Exposed for deterministic tests. */
  tick() {
    for (const identity of this._identities.values()) this._beat(identity);
  }

  /**
   * Emit one heartbeat for a healthy identity; a faulted one stays silent,
   * with each transition logged once.
   *
   * @param {HeartbeatIdentity} identity
   */
  _beat(identity) {
    const healthy = this._health(identity.id);
    const was = this._lastHealthy.get(identity.id);
    if (!healthy) {
      if (was !== false) {
        this._logger.warn(
          `identity ${identity.id} faulted; suppressing heartbeat until it clears`
        );
      }
      this._lastHealthy.set(identity.id, false);
      return;
    }
    if (was === false) {
      this._logger.info(`identity ${identity.id} healthy again; resuming heartbeat`);
    }
    this._lastHealthy.set(identity.id, true);
    this._emit({ identity, message: buildHeartbeat(identity) });
  }
}

/**
 * Build a HEARTBEAT for an identity. Node-RED is not a flight controller, so
 * `base_mode` and `custom_mode` are zero and the autopilot field is whatever
 * the identity declares (MAV_AUTOPILOT_INVALID for GCS/companion).
 *
 * MAV_STATE is always MAV_STATE_ACTIVE, and a component that is not active
 * does not send this message at all: an unhealthy identity has its heartbeat
 * suppressed by `_beat`, which is the signal every MAVLink participant already
 * reads. There is no state between beating and silent for this emitter to
 * report.
 *
 * @param {HeartbeatIdentity} identity
 * @returns {object} a decoded-shape HEARTBEAT ready for the wire codec
 */
function buildHeartbeat(identity) {
  const hb = identity.heartbeat;
  return {
    name: 'HEARTBEAT',
    sysid: identity.sysid,
    compid: identity.compid,
    fields: {
      type: hb.type,
      autopilot: hb.autopilot,
      base_mode: 0,
      custom_mode: 0,
      system_status: MAV_STATE_ACTIVE,
      mavlink_version: MAVLINK_VERSION,
    },
  };
}

module.exports = { HeartbeatScheduler };
