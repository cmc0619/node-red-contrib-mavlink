'use strict';

/**
 * mavlink-connection — Connection config node (DESIGN.md §3, §6, §7, §8).
 *
 * The Connection owns how traffic moves and stays channel-correct: the
 * transport (UDP, TCP, or serial), the peer table, its one bound Vehicle
 * Profile, the outbound queue and its bands, the signing link state, the
 * default identity plus opt-in additional ones, and the disable switch.
 *
 * The node is thin (§2): it reads config, resolves the bound Vehicle Profile
 * and Local Identity config nodes, and hands a plain snapshot to the
 * {@link Connection} runtime in `lib/connection`, which owns every piece of
 * behaviour. Palette nodes reach the runtime through `node.subscribe`,
 * `node.send`, `node.peerTable`, `node.vehicle`, `node.assertHealth`,
 * `node.onHealthExpired`, and `node.crcFailureCount`.
 *
 * References are captured at construction and released in `close`; the config
 * nodes are never re-resolved during teardown (§7).
 */

const { Connection, STATE, PeerTable } = require('../lib/connection');
const { listSerialPorts } = require('../lib/connection/transport/serial');
const { resolveIdentity } = require('../lib/identity/resolve');
const { capBadge } = require('../lib/delivery');

/** Admin endpoint path listing host serial ports for the editor (§6). */
const SERIAL_PORTS_ROUTE = '/mavlink/serial-ports';

/** Whether the admin serial-ports route has been registered (once per process). */
let _serialPortsRouteRegistered = false;

module.exports = function registerMavlinkConnection(RED) {
  /**
   * Serial path suggestions for the editor (§6 "Register with
   * RED.auth.needsPermission"), once per process like the dialects route. An
   * absent `serialport` answers `{ports: []}` with 200 — nothing to
   * enumerate is not a failure; a listing that genuinely fails answers 500
   * with its message.
   */
  if (!_serialPortsRouteRegistered) {
    RED.httpAdmin.get(
      SERIAL_PORTS_ROUTE,
      RED.auth.needsPermission('mavlink.read'),
      (_req, res) => {
        listSerialPorts().then(
          (ports) => res.json({ ports }),
          (err) => res.status(500).json({ ports: [], error: err.message })
        );
      }
    );
    _serialPortsRouteRegistered = true;
  }

  /**
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkConnectionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.disabled = Boolean(config.disabled);

    const vehicleNode = RED.nodes.getNode(config.vehicle);
    const defaults = vehicleNode.getDefaults();

    // The addressing/firmware descriptor both vehicle shapes below derive
    // from — built once so the public snapshot and the runtime config cannot
    // drift apart.
    const vehicleDescriptor = {
      targetSystem: defaults.defaultTargetSystem,
      targetComponent: defaults.defaultTargetComponent,
      firmware: defaults.firmware,
    };

    // Public frozen snapshot so palette nodes can inherit target defaults from
    // the Vehicle Profile without reaching into private runtime fields. `id` is
    // the profile node id: a node that needs the compiled bundle resolves the
    // profile node and calls getDialect() — never loadBundled(name), which only
    // knows bundled dialects and would break custom XML profiles.
    node.vehicle = Object.freeze({
      id: config.vehicle,
      ...vehicleDescriptor,
      vehicleFamily: defaults.vehicleFamily,
    });

    // Disabled means no runtime is constructed at all: no dialing, listening,
    // or timers (§7) — the dialect compile above waits too. Show the grey
    // disabled badge and stop.
    //
    // The read-side stubs still answer, because a disabled Connection is a
    // valid choice, not a broken reference. An empty peer table (no timers —
    // sweeping is driven by the runtime, which does not exist here) lets
    // action nodes report "no members" instead of "invalid config", which is
    // the honest answer: the flow is configured correctly and the link is
    // switched off. The vehicle snapshot above is part of that read side —
    // wire-tier nodes resolve their dialect through it at deploy, so the flow
    // loads and fails at send time. `send` refuses instead — swallowing a
    // frame would let the sender report "sent" over a link that moved
    // nothing (§2).
    // The Local Identity id, read live by a node whose editor hides the
    // Identity field on a single-identity Connection (mavlink-health).
    node.localIdentity = config.localIdentity;

    if (node.disabled) {
      node.status({ fill: 'grey', shape: 'ring', text: 'disabled' });
      node.subscribe = () => () => {};
      node.send = () => {
        // eslint-disable-next-line no-restricted-syntax -- §0 rule 3: a send on a disabled link is an operational failure at send time
        throw new Error(
          'mavlink-connection: connection disabled — enable it in the connection config and redeploy'
        );
      };
      node.resolveSourceIds = () => null;
      node.peerTable = new PeerTable({});
      node.assertHealth = () => {
        // eslint-disable-next-line no-restricted-syntax -- §0 rule 3: a health assertion on a disabled link is an operational failure at assertion time
        throw new Error(
          'mavlink-connection: connection disabled — enable it in the connection config and redeploy'
        );
      };
      node.onHealthExpired = () => () => {};
      node.crcFailureCount = () => 0;
      node.on('close', (done) => done());
      return;
    }

    const bundle = vehicleNode.getDialect();

    // localIdentity is a required reference and additionalIdentities is the
    // editor's normalized list (oneditsave always writes it) — used as saved.
    const identityIds = [config.localIdentity, ...config.additionalIdentities];

    // Built before the identity claims — a signing misconfig throws with
    // nothing to release yet — and kept: the rejected/status wiring below
    // needs hasKey and acceptInvalid (#243).
    const signing = buildSigning(config, node.credentials);

    const identities = identityIds.map((id) => {
      const idNode = RED.nodes.getNode(id);
      return identitySnapshot(idNode, defaults, bundle);
    });

    node.connection = new Connection({
        transport: buildTransportConfig(config),
        vehicle: {
          ...vehicleDescriptor,
          bundle,
        },
        identities,
        defaultIdentityId: config.localIdentity,
        signing,
        // The editor owns both thresholds (5000/15000 defaults, blank reds);
        // Number() is Node-RED serialization plumbing, not validation (§0).
        heartbeat: {
          staleMs: Number(config.staleMs),
          expireMs: Number(config.expireMs),
        },
    }, {
        logger: {
          info: (m) => node.log(m),
          warn: (m) => node.warn(m),
          error: (m) => node.error(m),
        },
        resolveIdentity,
    });

    node.connection.on('state', (state) => applyStatus(node, state, signing.acceptInvalid));
    node.connection.on('rejected', makeRejectedHandler(node, signing));

    node.subscribe = (filter, handler) => node.connection.subscribe(filter, handler);
    node.send = (message, options) => node.connection.send(message, options);
    node.resolveSourceIds = (identityId) => node.connection.resolveSourceIds(identityId);
    node.assertHealth = (identityId, healthy, ttlMs) =>
      node.connection.assertHealth(identityId, healthy, ttlMs);
    node.onHealthExpired = (handler) => {
      node.connection.on('health-expired', handler);
      return () => node.connection.off('health-expired', handler);
    };
    node.crcFailureCount = () => node.connection.crcFailureCount();
    Object.defineProperty(node, 'peerTable', { get: () => node.connection.peerTable });

    // start() sets CONNECTING synchronously before its first await, and the
    // 'state' listener above is already on, so the badge follows it from here.
    node.connection.start().catch((err) => {
      applyStatus(node, STATE.ERROR, signing.acceptInvalid);
      node.error(err.message);
    });

    node.on('close', (done) => {
      node.connection.close(done);
    });
  }

  RED.nodes.registerType('mavlink-connection', MavlinkConnectionNode, {
    credentials: { signingPassphrase: { type: 'password' }, signingKeyHex: { type: 'password' } },
  });
};

// Exposed for direct unit testing (test/nodes/connection-signing.test.js).
module.exports.buildSigning = buildSigning;
module.exports.makeRejectedHandler = makeRejectedHandler;
module.exports.applyStatus = applyStatus;

/**
 * Build the runtime identity snapshot from a Local Identity config node,
 * deriving the companion's sysid from the vehicle and resolving heartbeat enum
 * names to their numeric wire values against the bound dialect (§7).
 *
 * @param {object} idNode  the Local Identity node
 * @param {object} defaults  Vehicle Profile defaults
 * @param {object} bundle  the dialect bundle (for enum resolution)
 * @returns {{id: string, sysid: number, compid: number, heartbeatIntervalMs: number, heartbeat: object}}
 */
function identitySnapshot(idNode, defaults, bundle) {
  if (idNode.derivesSysidFromVehicle) idNode.bindVehicleSysid(defaults.defaultTargetSystem);
  const wire = idNode.getIdentity();
  const hb = idNode.getHeartbeatFields();
  return {
    id: idNode.id,
    sysid: wire.sysid,
    compid: wire.compid,
    heartbeatIntervalMs: idNode.heartbeatIntervalMs,
    heartbeat: {
      type: bundle.enums.MAV_TYPE.byName[hb.type],
      autopilot: bundle.enums.MAV_AUTOPILOT.byName[hb.autopilot],
    },
  };
}

/**
 * Map editor transport fields onto the runtime transport config.
 * UDP/TCP share bind + optional remote; serial uses path + baud.
 *
 * @param {object} config  Node-RED node config
 * @returns {object|undefined} undefined for a mode no case answers to (§5)
 */
function buildTransportConfig(config) {
  // The editor owns the transport fields: mode is a required closed select,
  // serial path / baud red when serial, and bind host/port red for UDP/TCP.
  // Number() is Node-RED serialization plumbing, not validation (§0).
  const socket = () => ({
    mode: config.mode,
    bindAddress: config.bindHost,
    bindPort: Number(config.bindPort),
    remoteAddress: config.remoteHost,
    remotePort: Number(config.remotePort),
  });
  switch (config.mode) {
    case 'serial':
      return {
        mode: 'serial',
        path: config.serialPath,
        baudRate: Number(config.baudRate),
      };
    case 'tcp':
      return socket();
    case 'udp':
      return {
        ...socket(),
        // UDP only — TCP has no broadcast, and the editor hides the row for it.
        broadcastAddress: config.broadcastHost,
        broadcastPort: Number(config.broadcastPort),
      };
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

/**
 * Assemble the signing config for the runtime. The passphrase lives only in
 * Node-RED encrypted credentials; the key is derived from it via node-mavlink's
 * primitive whenever a passphrase is present (§7). Sign-outbound and
 * require-signed stay independent switches that control *policy* — outbound
 * signing and whether unsigned inbound is rejected — not whether the key
 * exists to verify with: gating derivation on those checkboxes left a
 * passphrase-only connection with no key at all, so every signed inbound
 * frame failed verification silently. Sign-outbound with no passphrase still
 * fails the connection closed in the runtime.
 *
 * @param {object} config
 * @param {object} credentials  the node's credentials object (Node-RED always assigns one)
 * @returns {object}
 */
function buildSigning(config, credentials) {
  const passphrase = credentials.signingPassphrase;
  const keyHex = credentials.signingKeyHex;

  const signing = {
    linkId: Number(config.linkId),
    signOutbound: Boolean(config.signOutbound),
    requireSigned: Boolean(config.requireSigned),
    acceptInvalid: Boolean(config.acceptInvalid),
    hasKey: Boolean(passphrase || keyHex),
    key: null,
  };
  if (keyHex) {
    // Raw 32-byte key, entered as 64 hex chars — the form both firmwares are
    // provisioned with (SETUP_SIGNING carries raw bytes) and the only way to
    // match a fleet whose key did not come from a Mission-Planner-style
    // sha256(passphrase) (e.g. QGC derives via PBKDF2, which a passphrase
    // here cannot reproduce). The editor owns the format and the exclusivity
    // against the passphrase (mavlink-connection.html credentials).
    signing.key = Buffer.from(keyHex, 'hex');
  } else if (passphrase) {
    const { MavLinkPacketSignature } = require('node-mavlink');
    signing.key = MavLinkPacketSignature.key(passphrase);
  }
  return signing;
}

/**
 * Consume the runtime's 'rejected' event (issue #243). Rejection is the
 * fail-closed policy working as designed; dropping traffic *silently* is not —
 * a signing vehicle pointed at a key-less connection would otherwise read as
 * total silence, with no hint that the recovery override even exists. One warn
 * plus badge per consecutive same-reason streak (the mavlink-move advisory
 * dedup pattern); redeploy resets naturally — new node instance.
 *
 * @param {object} node
 * @param {{hasKey: boolean, acceptInvalid: boolean}} signing  buildSigning result
 * @returns {(event: {reason: string}) => void}
 */
function makeRejectedHandler(node, signing) {
  let lastReason = null;
  return ({ reason }) => {
    if (reason === lastReason) return;
    lastReason = reason;
    const surface = rejectedSurface(reason, signing.hasKey);
    node.warn(surface.log);
    // The conspicuous UNTRUSTED badge (applyStatus) outranks per-reason drop
    // badges while the recovery override is on; the warn still lands.
    if (!signing.acceptInvalid) {
      node.status({ fill: 'yellow', shape: 'ring', text: capBadge(surface.badge) });
    }
  };
}

/**
 * Operator-facing text for an inbound rejection verdict — reasons from
 * lib/connection/signing.js. The log names the exact cause; the badge is a
 * §6-capped short form. The no-key case is called out by name: with no key
 * every signed frame verifies false, so "invalid signature" alone would point
 * the operator at the vehicle instead of at this connection's missing key.
 *
 * @param {string} reason  verdict reason tag
 * @param {boolean} hasKey  whether a verification key is configured
 * @returns {{log: string, badge: string}}
 */
function rejectedSurface(reason, hasKey) {
  if (reason === 'invalid-signature') {
    return hasKey
      ? { log: 'dropping signed traffic — signature verification failed', badge: 'drop: invalid signature' }
      : {
          log: 'dropping signed traffic — no key configured (set a signing passphrase or raw key on this connection)',
          badge: 'drop: no signing key',
        };
  }
  if (reason === 'unsigned-rejected-require-signed') {
    return { log: 'dropping unsigned traffic — require signed inbound is on', badge: 'drop: unsigned inbound' };
  }
  if (reason === 'replay-or-out-of-order') {
    return { log: 'dropping signed traffic — replayed or out-of-order timestamp', badge: 'drop: replayed frame' };
  }
  // 'first-contact-too-old', and any future verdict: the tag is already the
  // message. The floor is first-contact only — an established stream is
  // governed by monotonicity alone (§7 signing, #264).
  return { log: `dropping signed traffic — ${reason}`, badge: `drop: ${reason}` };
}

/**
 * Map a runtime state to a §6 config-node status badge. Config nodes report a
 * state machine: green dot connected, yellow ring connecting, grey ring
 * idle/closed, red ring error. Shape carries meaning independently of
 * colour — ring is not-running/not-ok, dot is active/settled-good.
 *
 * @param {object} node
 * @param {string} state
 * @param {boolean} untrusted  the accept-invalid recovery override is on
 */
function applyStatus(node, state, untrusted) {
  if (untrusted && state === STATE.CONNECTED) {
    // DESIGN §7 "Accept invalid signatures": with the recovery override on,
    // status must show the connection as untrusted conspicuously — red dot,
    // not the settled green — whenever the override is enabled, not only when
    // an invalid frame happens to arrive.
    node.status({ fill: 'red', shape: 'dot', text: capBadge('connected — UNTRUSTED') });
    return;
  }
  const badge = STATUS_BADGES[state];
  node.status({ fill: badge.fill, shape: badge.shape, text: capBadge(badge.text) });
}

/** @type {Object<string, {fill: string, shape: string, text: string}>} */
const STATUS_BADGES = {
  [STATE.CONNECTED]: { fill: 'green', shape: 'dot', text: 'connected' },
  [STATE.CONNECTING]: { fill: 'yellow', shape: 'ring', text: 'connecting' },
  [STATE.RECONNECTING]: { fill: 'yellow', shape: 'ring', text: 'reconnecting' },
  [STATE.IDLE]: { fill: 'grey', shape: 'ring', text: 'idle' },
  [STATE.CLOSED]: { fill: 'grey', shape: 'ring', text: 'closed' },
  [STATE.ERROR]: { fill: 'red', shape: 'ring', text: 'error' },
};
