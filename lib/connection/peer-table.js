'use strict';

/**
 * The peer table (DESIGN.md §8). The Connection builds and owns exactly one;
 * it is populated from HEARTBEAT and enriched from everything else.
 *
 * **Keyed by sysid, with components nested underneath** — a vehicle is a
 * system; its autopilot, gimbal, and companion are components of it. Flat
 * `(sysid, compid)` keys turn "is the copter armed" into a search.
 *
 * **Freshness is per section, not per record** — a 1 Hz heartbeat must not make
 * a two-minute-old position look live, so heartbeat, position, battery, and GPS
 * are timestamped independently.
 *
 * **An endpoint is always address *and* port** — ten SITL instances on one host
 * share an IP and are distinguished only by port. Sending follows the primary
 * endpoint, falling back to another on failure; a component seen on more than
 * one endpoint is surfaced, never auto-deconflicted (MAVLink has no
 * cross-channel deconfliction — §8, §14).
 *
 * Two freshness thresholds, both emitting events so a flow reacts rather than
 * polls: **stale** (missed N heartbeats, still listed, marked) and **expired**
 * (dropped from the table).
 *
 * Events: `peer-new`, `component-new`, `heartbeat`, `stale`, `expired`,
 * `endpoint-added`, `primary-changed`, `multi-endpoint`, `profile-mismatch`,
 * `statustext`.
 */

const { EventEmitter } = require('node:events');
const { endpointKey } = require('./endpoint-key');

/** MAV_MODE_FLAG_SAFETY_ARMED — bit 7 of `base_mode`; set when armed. */
const SAFETY_ARMED_BIT = 128;
/** MAV_AUTOPILOT_INVALID — declared by GCS/companion heartbeats, not vehicles. */
const AUTOPILOT_INVALID = 8;
/** How many STATUSTEXT lines to retain per component. */
const STATUSTEXT_HISTORY = 20;

const DEFAULT_OPTIONS = {
  heartbeatStaleMs: 5000, // ~5 missed heartbeats at 1 Hz (§7 RF convention)
  heartbeatExpireMs: 15000,
  statustextHistory: STATUSTEXT_HISTORY,
};

/**
 * @typedef {object} Endpoint
 * @property {string} address
 * @property {number} port
 */

/**
 * @typedef {object} DecodedMessage
 * @property {string} name  e.g. `HEARTBEAT`
 * @property {number} sysid
 * @property {number} compid
 * @property {Object<string, *>} fields  decoded field values by wire name
 */

class PeerTable extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]  clock source (ms)
   * @param {number} [options.heartbeatStaleMs]
   * @param {number} [options.heartbeatExpireMs]
   * @param {number|null} [options.profileAutopilot]  the bound Vehicle Profile's
   *   MAV_AUTOPILOT value; a contradicting HEARTBEAT is surfaced, never used to
   *   silently reassign the profile (§7 "HEARTBEAT verifies the binding")
   */
  constructor(options = {}) {
    super();
    this._now = options.now || Date.now;
    this._opts = { ...DEFAULT_OPTIONS, ...options };
    this._profileAutopilot =
      options.profileAutopilot === undefined ? null : options.profileAutopilot;
    /** @type {Map<number, {sysid: number, components: Map<number, object>}>} */
    this._peers = new Map();
  }

  /**
   * Fold a decoded message into the table, recording the endpoint it arrived on
   * and refreshing the relevant section's freshness.
   *
   * @param {DecodedMessage} decoded
   * @param {Endpoint} endpoint  address + port the datagram came from
   * @param {number} [now]
   */
  update(decoded, endpoint, now = this._now()) {
    const component = this._ensureComponent(decoded.sysid, decoded.compid, now);
    component.lastSeen = now;
    this._recordEndpoint(component, endpoint, now);

    const handler = SOURCES[decoded.name];
    if (handler) handler(this, component, decoded.fields || {}, now);
  }

  /**
   * Recompute stale/expired transitions and emit events. The driver calls this
   * on an interval; it never fires from message arrival, because staleness is
   * the *absence* of messages.
   *
   * @param {number} [now]
   */
  sweep(now = this._now()) {
    for (const peer of this._peers.values()) {
      for (const [compid, component] of peer.components) {
        const age = now - this._freshnessRef(component);
        if (age > this._opts.heartbeatExpireMs) {
          peer.components.delete(compid);
          this.emit('expired', { sysid: peer.sysid, compid, component });
        } else if (age > this._opts.heartbeatStaleMs && component.state !== 'stale') {
          component.state = 'stale';
          this.emit('stale', { sysid: peer.sysid, compid, component });
        } else if (age <= this._opts.heartbeatStaleMs && component.state === 'stale') {
          component.state = 'active';
        }
      }
      if (peer.components.size === 0) this._peers.delete(peer.sysid);
    }
  }

  /**
   * The primary endpoint to send to for a component. Sending follows the
   * primary, and the caller falls back to another on failure via
   * {@link PeerTable#markPrimaryFailed}. When `compid` is omitted the autopilot
   * (component 1) is preferred, then any component.
   *
   * @param {number} sysid
   * @param {number} [compid]
   * @returns {Endpoint|null}
   */
  endpointFor(sysid, compid) {
    const peer = this._peers.get(sysid);
    if (!peer) return null;
    const component =
      compid !== undefined
        ? peer.components.get(compid)
        : peer.components.get(1) || peer.components.values().next().value;
    if (!component || !component.primaryEndpoint) return null;
    const ep = component.endpoints.get(component.primaryEndpoint);
    return ep ? { address: ep.address, port: ep.port } : null;
  }

  /**
   * Demote the current primary endpoint after a send failure and promote the
   * next most-recently-seen one, emitting `primary-changed`. That is a link
   * failover, worth seeing (§8).
   *
   * @param {number} sysid
   * @param {number} compid
   * @returns {Endpoint|null} the new primary, or null when none remains
   */
  markPrimaryFailed(sysid, compid) {
    const component = this.getComponent(sysid, compid);
    if (!component || !component.primaryEndpoint) return null;
    const previous = component.primaryEndpoint;
    // Always drop the failed endpoint — retaining it lets a later failure
    // promote a known-dead address back to primary.
    component.endpoints.delete(previous);
    if (component.endpoints.size === 0) {
      component.primaryEndpoint = null;
      return null;
    }
    let next = null;
    for (const [key, ep] of component.endpoints) {
      if (next === null || ep.lastSeen > component.endpoints.get(next).lastSeen) next = key;
    }
    if (next === null) {
      component.primaryEndpoint = null;
      return null;
    }
    component.primaryEndpoint = next;
    const ep = component.endpoints.get(next);
    this.emit('primary-changed', {
      sysid,
      compid,
      from: previous,
      to: next,
      endpoint: { address: ep.address, port: ep.port },
    });
    return { address: ep.address, port: ep.port };
  }

  /**
   * Every distinct primary endpoint a `target_system = 0` frame has to reach.
   *
   * On a shared medium — serial, or UDP to a broadcast/multicast address — one
   * write reaches everyone and this is not needed. On a star, where each
   * vehicle dials in and gets its own return path (ArduPilot `udpclient`, the
   * shape the SITL lab uses), "everyone" is N separate writes to N addresses
   * the peer table learned from their heartbeats.
   *
   * Deduped by address:port, because two components of the same vehicle share
   * one return path and the frame should cross the wire once per destination,
   * not once per component.
   *
   * No freshness filter, matching {@link PeerTable#endpointFor}: a stale
   * component still receives directed sends, so it receives broadcasts too.
   * Expired components need no filter — `sweep()` deletes them outright, so
   * they are not in `components` to be found.
   *
   * @param {number} compid  the component the broadcast addresses (autopilot 1
   *   for fan-out); taken literally, since a broadcast names one component
   *   across all systems.
   * @returns {{address: string, port: number}[]} possibly empty — an empty
   *   table means no peer has been heard yet, which the caller reads as
   *   "fall back to the configured remote".
   */
  endpointsForBroadcast(compid) {
    const out = [];
    const seen = new Set();
    for (const peer of this._peers.values()) {
      const component = peer.components.get(compid);
      if (!component || !component.primaryEndpoint) continue;
      const ep = component.endpoints.get(component.primaryEndpoint);
      if (!ep) continue;
      const key = `${ep.address}:${ep.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ address: ep.address, port: ep.port });
    }
    return out;
  }

  /**
   * @param {number} sysid
   * @returns {object|undefined} the peer record, components nested
   */
  get(sysid) {
    return this._peers.get(sysid);
  }

  /**
   * @param {number} sysid
   * @param {number} compid
   * @returns {object|undefined}
   */
  getComponent(sysid, compid) {
    const peer = this._peers.get(sysid);
    return peer ? peer.components.get(compid) : undefined;
  }

  /**
   * @param {number} sysid
   * @returns {boolean}
   */
  has(sysid) {
    return this._peers.has(sysid);
  }

  /** @returns {number} number of systems currently tracked */
  size() {
    return this._peers.size;
  }

  /**
   * A plain, JSON-serializable view of the table for the State node and status.
   *
   * @returns {object[]}
   */
  snapshot() {
    const out = [];
    for (const peer of this._peers.values()) {
      const components = [];
      for (const component of peer.components.values()) {
        components.push({
          compid: component.compid,
          type: component.type,
          autopilot: component.autopilot,
          systemStatus: component.systemStatus,
          armed: component.armed,
          flightMode: component.flightMode,
          state: component.state,
          mismatch: component.mismatch,
          sections: sectionAges(component, this._now()),
          endpoints: [...component.endpoints.values()].map((ep) => ({
            address: ep.address,
            port: ep.port,
            lastSeen: ep.lastSeen,
            primary: endpointKey(ep) === component.primaryEndpoint,
          })),
          statustext: component.statustext.slice(),
        });
      }
      out.push({ sysid: peer.sysid, components });
    }
    return out;
  }

  /** Drop every peer (teardown). */
  clear() {
    this._peers.clear();
  }

  /**
   * @param {number} sysid
   * @param {number} compid
   * @param {number} now
   * @returns {object} the component record, creating peer/component as needed
   */
  _ensureComponent(sysid, compid, now) {
    let peer = this._peers.get(sysid);
    if (!peer) {
      peer = { sysid, components: new Map() };
      this._peers.set(sysid, peer);
      this.emit('peer-new', { sysid });
    }
    let component = peer.components.get(compid);
    if (!component) {
      component = {
        sysid,
        compid,
        type: null,
        autopilot: null,
        systemStatus: null,
        baseMode: null,
        armed: null,
        flightMode: null,
        state: 'active',
        mismatch: false,
        sections: {},
        endpoints: new Map(),
        primaryEndpoint: null,
        lastSeen: now,
        autopilotVersion: null,
        capabilities: null,
        sysStatus: null,
        gps: null,
        position: null,
        battery: null,
        home: null,
        statustext: [],
      };
      peer.components.set(compid, component);
      this.emit('component-new', { sysid, compid, component });
    }
    return component;
  }

  /**
   * Record the source endpoint on a component. The first endpoint becomes the
   * primary; a genuinely new endpoint on an already-seen component surfaces the
   * multi-endpoint condition for the operator to resolve.
   *
   * @param {object} component
   * @param {Endpoint} endpoint
   * @param {number} now
   */
  _recordEndpoint(component, endpoint, now) {
    if (!endpoint) return;
    const key = endpointKey(endpoint);
    const known = component.endpoints.get(key);
    if (known) {
      known.lastSeen = now;
      return;
    }
    component.endpoints.set(key, { address: endpoint.address, port: endpoint.port, lastSeen: now });
    if (component.primaryEndpoint === null) {
      component.primaryEndpoint = key;
    }
    this.emit('endpoint-added', { sysid: component.sysid, compid: component.compid, endpoint });
    if (component.endpoints.size > 1) {
      this.emit('multi-endpoint', {
        sysid: component.sysid,
        compid: component.compid,
        endpoints: [...component.endpoints.values()].map((ep) => ({
          address: ep.address,
          port: ep.port,
        })),
      });
    }
  }

  /**
   * The timestamp staleness ages against: the heartbeat section when a
   * heartbeat has ever been seen (§8 stale = missed heartbeats), else the
   * general last-seen so a telemetry-only component still expires.
   *
   * @param {object} component
   * @returns {number}
   */
  _freshnessRef(component) {
    const hb = component.sections.heartbeat;
    return hb ? hb.lastSeen : component.lastSeen;
  }

  /**
   * @param {object} component
   * @param {string} section
   * @param {number} now
   * @param {object} [data]
   */
  _touchSection(component, section, now, data) {
    component.sections[section] = { lastSeen: now, ...(data ? { data } : {}) };
  }
}

/**
 * Per-source enrichment. Each entry folds one message type's fields into the
 * component and refreshes the section it belongs to (§8 source table).
 *
 * @type {Object<string, (table: PeerTable, component: object, fields: object, now: number) => void>}
 */
const SOURCES = {
  HEARTBEAT(table, component, fields, now) {
    const wasActive = component.state === 'active';
    component.type = numberOr(fields.type, component.type);
    component.autopilot = numberOr(fields.autopilot, component.autopilot);
    component.systemStatus = numberOr(fields.system_status, component.systemStatus);
    component.baseMode = numberOr(fields.base_mode, component.baseMode);
    component.flightMode = numberOr(fields.custom_mode, component.flightMode);
    component.armed =
      component.baseMode === null ? null : Math.floor(component.baseMode / SAFETY_ARMED_BIT) % 2 === 1;
    table._touchSection(component, 'heartbeat', now);
    if (component.state === 'stale') component.state = 'active';
    table.emit('heartbeat', {
      sysid: component.sysid,
      compid: component.compid,
      component,
      recovered: !wasActive,
    });

    const profile = table._profileAutopilot;
    if (
      profile !== null &&
      component.autopilot !== null &&
      component.autopilot !== AUTOPILOT_INVALID &&
      component.autopilot !== profile &&
      !component.mismatch
    ) {
      component.mismatch = true;
      table.emit('profile-mismatch', {
        sysid: component.sysid,
        compid: component.compid,
        declared: component.autopilot,
        profile,
      });
    }
  },

  AUTOPILOT_VERSION(_table, component, fields) {
    component.autopilotVersion = {
      flightSwVersion: numberOr(fields.flight_sw_version, null),
      boardVersion: numberOr(fields.board_version, null),
    };
    component.capabilities = fields.capabilities !== undefined ? fields.capabilities : null;
  },

  SYS_STATUS(table, component, fields, now) {
    component.sysStatus = {
      sensorsPresent: numberOr(fields.onboard_control_sensors_present, null),
      sensorsHealth: numberOr(fields.onboard_control_sensors_health, null),
      batteryVoltage: numberOr(fields.voltage_battery, null),
      batteryRemaining: numberOr(fields.battery_remaining, null),
    };
    table._touchSection(component, 'battery', now, component.sysStatus);
    component.battery = component.sysStatus;
  },

  GPS_RAW_INT(table, component, fields, now) {
    component.gps = {
      fixType: numberOr(fields.fix_type, null),
      satellites: numberOr(fields.satellites_visible, null),
    };
    table._touchSection(component, 'gps', now, component.gps);
  },

  GLOBAL_POSITION_INT(table, component, fields, now) {
    component.position = {
      lat: numberOr(fields.lat, null),
      lon: numberOr(fields.lon, null),
      alt: numberOr(fields.alt, null),
      relativeAlt: numberOr(fields.relative_alt, null),
      heading: numberOr(fields.hdg, null),
    };
    table._touchSection(component, 'position', now, component.position);
  },

  BATTERY_STATUS(table, component, fields, now) {
    component.battery = {
      id: numberOr(fields.id, null),
      remaining: numberOr(fields.battery_remaining, null),
      current: numberOr(fields.current_battery, null),
    };
    table._touchSection(component, 'battery', now, component.battery);
  },

  HOME_POSITION(_table, component, fields) {
    component.home = {
      lat: numberOr(fields.latitude, null),
      lon: numberOr(fields.longitude, null),
      alt: numberOr(fields.altitude, null),
    };
  },

  STATUSTEXT(table, component, fields) {
    const text = typeof fields.text === 'string' ? fields.text.replace(/\u0000+$/, '') : '';
    component.statustext.push({ severity: numberOr(fields.severity, null), text });
    if (component.statustext.length > table._opts.statustextHistory) component.statustext.shift();
    table.emit('statustext', { sysid: component.sysid, compid: component.compid, text });
  },
};

/**
 * @param {object} component
 * @param {number} now
 * @returns {Object<string, number>} per-section age in ms
 */
function sectionAges(component, now) {
  const out = {};
  for (const [name, section] of Object.entries(component.sections)) {
    out[name] = now - section.lastSeen;
  }
  return out;
}

/**
 * @param {*} value
 * @param {*} fallback
 * @returns {*} `value` coerced to Number when finite, else `fallback`
 */
function numberOr(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

module.exports = { PeerTable };
