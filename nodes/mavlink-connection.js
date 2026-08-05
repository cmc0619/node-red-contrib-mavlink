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
 * `node.send`, `node.peerTable`, and `node.vehicle`.
 *
 * References are captured at construction and released in `close`; the config
 * nodes are never re-resolved during teardown (§7).
 */

const { Connection, STATE, PeerTable } = require('../lib/connection');
const { resolveIdentity } = require('../lib/identity');
const { autopilotForFirmware } = require('../lib/vehicle');
const { capBadge } = require('../lib/delivery');

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
    //
    // The stubs still answer, because a disabled Connection is a valid choice,
    // not a broken reference. An empty peer table (no timers — sweeping is
    // driven by the runtime, which does not exist here) lets action nodes
    // report "no members" instead of "invalid config", which is the honest
    // answer: the flow is configured correctly and the link is switched off.
    if (node.disabled) {
      node.status({ fill: 'grey', shape: 'ring', text: 'disabled' });
      node.subscribe = () => () => {};
      node.send = () => {};
      node.resolveSourceIds = () => null;
      node.peerTable = new PeerTable({});
      node.on('close', (done) => done());
      return;
    }

    // getNode returns null for a deleted, disabled, or not-yet-deployed config
    // node — an ordinary editing sequence, not an exotic one. Fail with the
    // same clear-message style buildSigning uses, not a raw TypeError (#95).
    const vehicleNode = RED.nodes.getNode(config.vehicle);
    if (!vehicleNode) {
      throw new Error(
        'mavlink-connection: the referenced Vehicle Profile is missing or disabled — reselect a Vehicle in the connection config and redeploy'
      );
    }
    const bundle = vehicleNode.getDialect();
    const defaults = vehicleNode.getDefaults();

    // Public frozen snapshot so palette nodes can inherit target defaults from
    // the Vehicle Profile without reaching into private runtime fields. `id` is
    // the profile node id: a node that needs the compiled bundle resolves the
    // profile node and calls getDialect() — never loadBundled(name), which only
    // knows bundled dialects and would break custom XML profiles.
    node.vehicle = Object.freeze({
      id: config.vehicle,
      targetSystem: defaults.defaultTargetSystem,
      targetComponent: defaults.defaultTargetComponent,
      firmware: defaults.firmware,
      dialect: defaults.dialect,
      autopilot: autopilotForFirmware(defaults.firmware),
    });

    const identityIds = [config.localIdentity, ...(config.additionalIdentities || [])].filter(
      Boolean
    );
    node._identityNodes = identityIds.map((id) => {
      const idNode = RED.nodes.getNode(id);
      if (!idNode) {
        throw new Error(
          `mavlink-connection: the referenced Local Identity "${id}" is missing or disabled — reselect the Identity in the connection config and redeploy`
        );
      }
      return idNode;
    });

    const identities = node._identityNodes.map((idNode) =>
      identitySnapshot(idNode, defaults, bundle, node.id)
    );

    const config_ = {
      disabled: false,
      transport: buildTransportConfig(config),
      vehicle: {
        targetSystem: defaults.defaultTargetSystem,
        targetComponent: defaults.defaultTargetComponent,
        bundle,
        firmware: defaults.firmware,
        autopilot: autopilotForFirmware(defaults.firmware),
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
    node.resolveSourceIds = (identityId) => node.connection.resolveSourceIds(identityId);
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
    credentials: { signingPassphrase: { type: 'password' }, signingKeyHex: { type: 'password' } },
  });
};

// Exposed for direct unit testing (test/nodes/connection-signing.test.js) —
// same pattern as mavlink-vehicle.js's FIRMWARE_TYPES/VEHICLE_FAMILIES export.
module.exports.buildSigning = buildSigning;

/**
 * Build the runtime identity snapshot from a Local Identity config node,
 * deriving the companion's sysid from the vehicle and resolving heartbeat enum
 * names to their numeric wire values against the bound dialect (§7).
 *
 * @param {object} idNode  the Local Identity node
 * @param {object} defaults  Vehicle Profile defaults
 * @param {object} bundle  the dialect bundle (for enum resolution)
 * @param {string} connectionId  this connection's node id (for sysid claims)
 * @returns {{id: string, sysid: number, compid: number, heartbeatIntervalMs: number, heartbeat: object}}
 */
function identitySnapshot(idNode, defaults, bundle, connectionId) {
  if (idNode.derivesSysidFromVehicle) {
    idNode.bindVehicleSysid(defaults.defaultTargetSystem, idNode.describe(), connectionId);
  }
  const wire = idNode.getIdentity();
  const hb = idNode.getHeartbeatFields();
  return {
    id: idNode.id,
    sysid: wire.sysid,
    compid: wire.compid,
    heartbeatIntervalMs: idNode.heartbeatIntervalMs,
    heartbeat: {
      type: enumValue(bundle, 'MAV_TYPE', hb.type),
      autopilot: enumValue(bundle, 'MAV_AUTOPILOT', hb.autopilot),
      systemStatus: enumValue(bundle, 'MAV_STATE', hb.system_status),
    },
  };
}

/**
 * Map editor transport fields onto the runtime transport config.
 * UDP/TCP share bind + optional remote; serial uses path + baud.
 *
 * @param {object} config  Node-RED node config
 * @returns {object}
 */
function buildTransportConfig(config) {
  const mode = config.mode || 'udp';
  if (mode === 'serial') {
    return {
      mode: 'serial',
      path: config.serialPath || '',
      baudRate: config.baudRate ? Number(config.baudRate) : 57600,
    };
  }
  return {
    mode,
    bindAddress: config.bindHost || '0.0.0.0',
    bindPort: Number(config.bindPort),
    remoteAddress: config.remoteHost || undefined,
    remotePort: config.remotePort ? Number(config.remotePort) : undefined,
    // UDP only — TCP has no broadcast, and the editor hides the row for it.
    broadcastAddress: mode === 'udp' && config.broadcastHost
      ? config.broadcastHost
      : undefined,
    broadcastPort: mode === 'udp' && config.broadcastPort
      ? Number(config.broadcastPort)
      : undefined,
  };
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
 * @param {object} [credentials]
 * @returns {object}
 */
function buildSigning(config, credentials) {
  const passphrase = credentials && credentials.signingPassphrase;
  const keyHex = credentials && credentials.signingKeyHex && credentials.signingKeyHex.trim();

  // Two independent key sources configured is an ambiguous deploy, and which
  // one wins would be a silent guess — fail loud at construction (§7, §2).
  if (passphrase && keyHex) {
    throw new Error(
      'mavlink-connection: both a signing passphrase and a raw signing key are set — ' +
        'clear one; the connection will not guess which key to use'
    );
  }

  const signing = {
    linkId: config.linkId ? Number(config.linkId) : 0,
    signOutbound: !!config.signOutbound,
    requireSigned: !!config.requireSigned,
    acceptInvalid: !!config.acceptInvalid,
    hasKey: !!(passphrase || keyHex),
    key: null,
  };
  if (keyHex) {
    // Raw 32-byte key, entered as 64 hex chars — the form both firmwares are
    // provisioned with (SETUP_SIGNING carries raw bytes) and the only way to
    // match a fleet whose key did not come from a Mission-Planner-style
    // sha256(passphrase) (e.g. QGC derives via PBKDF2, which a passphrase
    // here cannot reproduce).
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error(
        'mavlink-connection: raw signing key must be exactly 64 hex characters ' +
          `(32 bytes); got ${keyHex.length} characters`
      );
    }
    signing.key = Buffer.from(keyHex, 'hex');
  } else if (passphrase) {
    const { MavLinkPacketSignature } = require('node-mavlink');
    signing.key = MavLinkPacketSignature.key(passphrase);
  }
  return signing;
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
  node.status({ fill: badge.fill, shape: badge.shape, text: capBadge(badge.text) });
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
