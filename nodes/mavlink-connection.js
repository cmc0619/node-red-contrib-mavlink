'use strict';

/**
 * mavlink-connection — Connection config node (DESIGN.md §3, §6, §7, §8).
 *
 * The Connection owns how traffic moves and stays channel-correct: the
 * transport (UDP first), the peer table, its one bound Vehicle Profile, the
 * outbound queue and its bands, the signing link state, the default identity
 * plus opt-in additional ones, and the disable switch.
 *
 * The node is thin (§2): it reads config, resolves the bound Vehicle Profile
 * and Local Identity config nodes, and hands a plain snapshot to the
 * {@link Connection} runtime in `lib/connection`, which owns every piece of
 * behaviour. Palette nodes reach the runtime through `node.subscribe`,
 * `node.send`, and `node.peerTable`.
 *
 * References are captured at construction and released in `close`; the config
 * nodes are never re-resolved during teardown (§7).
 */

const { Connection, STATE } = require('../lib/connection');
const { resolveIdentity } = require('../lib/identity');

/** Cap on node-status badge text (§6 "Cap badge text at 24 characters"). */
const BADGE_MAX = 24;

module.exports = function registerMavlinkConnection(RED) {
  /**
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkConnectionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.disabled = !!config.disabled;

    // Disabled means no runtime is constructed at all: no dialing, listening,
    // or timers (§7). Show the grey disabled badge and stop.
    if (node.disabled) {
      node.status({ fill: 'grey', shape: 'ring', text: 'disabled' });
      node.subscribe = () => () => {};
      node.send = () => {};
      node.on('close', (done) => done());
      return;
    }

    const vehicleNode = RED.nodes.getNode(config.vehicle);
    const bundle = vehicleNode.getDialect();
    const defaults = vehicleNode.getDefaults();

    const identityIds = [config.localIdentity, ...(config.additionalIdentities || [])].filter(
      Boolean
    );
    node._identityNodes = identityIds.map((id) => RED.nodes.getNode(id));

    // Legacy flows stored cadence on the Connection (`heartbeatInterval`). Prefer
    // that when an identity still has the default 1000 ms so upgrades do not
    // silently reset a custom rate. Re-saving the Connection drops the legacy key.
    const legacyHeartbeatIntervalMs = parseLegacyHeartbeatInterval(config.heartbeatInterval);
    const identities = node._identityNodes.map((idNode) =>
      identitySnapshot(idNode, defaults, bundle, node.id, legacyHeartbeatIntervalMs)
    );

    const config_ = {
      disabled: false,
      transport: {
        mode: config.mode || 'udp',
        bindAddress: config.bindHost || '0.0.0.0',
        bindPort: Number(config.bindPort),
        remoteAddress: config.remoteHost || undefined,
        remotePort: config.remotePort ? Number(config.remotePort) : undefined,
      },
      vehicle: {
        targetSysid: defaults.defaultTargetSystem,
        targetCompid: defaults.defaultTargetComponent,
        bundle,
        firmware: defaults.firmware,
        autopilot: firmwareAutopilot(defaults.firmware),
      },
      identities,
      defaultIdentityId: config.localIdentity,
      boundIdentityIds: identityIds,
      signing: buildSigning(config, node.credentials),
      heartbeat: {
        staleMs: config.staleMs ? Number(config.staleMs) : undefined,
        expireMs: config.expireMs ? Number(config.expireMs) : undefined,
      },
    };

    node.connection = new Connection(config_, {
      logger: {
        info: (m) => node.log(m),
        warn: (m) => node.warn(m),
        error: (m) => node.error(m),
      },
      resolveIdentity,
    });

    node.connection.on('state', (state) => applyStatus(node, state));
    node.connection.on('transport-error', () => {});

    node.subscribe = (filter, handler) => node.connection.subscribe(filter, handler);
    node.send = (message, options) => node.connection.send(message, options);
    Object.defineProperty(node, 'peerTable', { get: () => node.connection.peerTable });

    applyStatus(node, STATE.CONNECTING);
    node.connection.start().catch((err) => {
      applyStatus(node, STATE.ERROR);
      node.error(err.message);
    });

    node.on('close', (done) => {
      for (const idNode of node._identityNodes) {
        if (idNode && idNode.releaseVehicleSysid) idNode.releaseVehicleSysid(node.id);
      }
      node.connection.close(done);
    });
  }

  RED.nodes.registerType('mavlink-connection', MavlinkConnectionNode, {
    credentials: { signingPassphrase: { type: 'password' } },
  });
};

/**
 * Build the runtime identity snapshot from a Local Identity config node,
 * deriving the companion's sysid from the vehicle and resolving heartbeat enum
 * names to their numeric wire values against the bound dialect (§7).
 *
 * @param {object} idNode  the Local Identity node
 * @param {object} defaults  Vehicle Profile defaults
 * @param {object} bundle  the dialect bundle (for enum resolution)
 * @param {string} connectionId  this connection's node id (for sysid claims)
 * @param {number|null} [legacyHeartbeatIntervalMs]  Connection-era cadence, if any
 * @returns {{id: string, sysid: number, compid: number, heartbeatIntervalMs: number, heartbeat: object}}
 */
function identitySnapshot(idNode, defaults, bundle, connectionId, legacyHeartbeatIntervalMs) {
  if (idNode.derivesSysidFromVehicle) {
    idNode.bindVehicleSysid(defaults.defaultTargetSystem, idNode.describe(), connectionId);
  }
  const wire = idNode.getIdentity();
  const hb = idNode.getHeartbeatFields();
  const fromIdentity = Number(idNode.heartbeatIntervalMs);
  let heartbeatIntervalMs = Number.isFinite(fromIdentity) && fromIdentity > 0 ? fromIdentity : 1000;
  // Migrate Connection-era cadence only when the identity never saved the new
  // field (defaults alone look like 1000 and must not override an explicit 1000).
  if (
    legacyHeartbeatIntervalMs != null
    && !idNode.heartbeatIntervalMsConfigured
  ) {
    heartbeatIntervalMs = legacyHeartbeatIntervalMs;
  }
  return {
    id: idNode.id,
    sysid: wire.sysid,
    compid: wire.compid,
    heartbeatIntervalMs,
    heartbeat: {
      type: enumValue(bundle, 'MAV_TYPE', hb.type),
      autopilot: enumValue(bundle, 'MAV_AUTOPILOT', hb.autopilot),
      systemStatus: enumValue(bundle, 'MAV_STATE', hb.system_status),
    },
  };
}

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseLegacyHeartbeatInterval(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Assemble the signing config for the runtime. The passphrase lives only in
 * Node-RED encrypted credentials; the key is derived from it via node-mavlink's
 * primitive, and only when signing is actually on (§7). Sign-outbound with no
 * passphrase fails the connection closed in the runtime.
 *
 * @param {object} config
 * @param {object} [credentials]
 * @returns {object}
 */
function buildSigning(config, credentials) {
  const passphrase = credentials && credentials.signingPassphrase;
  const signOutbound = !!config.signOutbound;
  const requireSigned = !!config.requireSigned;
  const signing = {
    linkId: config.linkId ? Number(config.linkId) : 0,
    signOutbound,
    requireSigned,
    acceptInvalid: !!config.acceptInvalid,
    hasKey: !!passphrase,
    key: null,
  };
  if (passphrase && (signOutbound || requireSigned)) {
    const { MavLinkPacketSignature } = require('node-mavlink');
    signing.key = MavLinkPacketSignature.key(passphrase);
  }
  return signing;
}

/**
 * Map a firmware identifier to its MAV_AUTOPILOT value for peer-table binding
 * verification (§7 "HEARTBEAT verifies the binding").
 *
 * @param {string} firmware
 * @returns {number|null}
 */
function firmwareAutopilot(firmware) {
  if (firmware === 'ardupilot') return 3; // MAV_AUTOPILOT_ARDUPILOTMEGA
  if (firmware === 'px4') return 12; // MAV_AUTOPILOT_PX4
  return null;
}

/**
 * Resolve an enum entry's screaming name to its numeric value from the bundle.
 *
 * @param {object} bundle
 * @param {string} enumName
 * @param {string} entryName
 * @returns {number}
 * @throws {Error} when the enum or entry is not in the dialect
 */
function enumValue(bundle, enumName, entryName) {
  const enumDef = bundle.enums[enumName];
  const entry = enumDef && enumDef.entries.find((e) => e.name === entryName);
  if (!entry) throw new Error(`${entryName} is not defined in enum ${enumName}`);
  return Number(entry.value);
}

/**
 * Map a runtime state to a §6 config-node status badge. Config nodes report a
 * state machine: green dot connected, yellow ring connecting, grey ring
 * idle/closed/disabled, red ring error. Shape carries meaning independently of
 * colour — ring is not-running/not-ok, dot is active/settled-good.
 *
 * @param {object} node
 * @param {string} state
 */
function applyStatus(node, state) {
  const badge = STATUS_BADGES[state] || { fill: 'grey', shape: 'ring', text: state };
  node.status({ fill: badge.fill, shape: badge.shape, text: badge.text.slice(0, BADGE_MAX) });
}

/** @type {Object<string, {fill: string, shape: string, text: string}>} */
const STATUS_BADGES = {
  [STATE.CONNECTED]: { fill: 'green', shape: 'dot', text: 'connected' },
  [STATE.CONNECTING]: { fill: 'yellow', shape: 'ring', text: 'connecting' },
  [STATE.IDLE]: { fill: 'grey', shape: 'ring', text: 'idle' },
  [STATE.CLOSED]: { fill: 'grey', shape: 'ring', text: 'closed' },
  [STATE.DISABLED]: { fill: 'grey', shape: 'ring', text: 'disabled' },
  [STATE.ERROR]: { fill: 'red', shape: 'ring', text: 'error' },
};
