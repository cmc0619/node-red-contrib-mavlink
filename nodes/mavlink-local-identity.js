'use strict';

/**
 * mavlink-local-identity — Local MAVLink Identity config node (DESIGN.md §3, §7).
 *
 * A Local Identity is who this Node-RED runtime *is* on the wire: the source
 * sysid/compid stamped into outbound frame headers and the HEARTBEAT it
 * advertises. It owns nothing about the vehicle being addressed (Vehicle
 * Profile) and nothing about how bytes move or how the link is secured
 * (Connection).
 *
 * Multiple Local Identity nodes may coexist: one Node-RED runtime may act as
 * both a GCS and an onboard companion. Which identities may transmit on a link
 * is decided by the Connection's explicit bindings, never here.
 *
 * Signing lives on the Connection: a MAVLink link has exactly one signing key
 * shared by both endpoints, so the credential and sign/verify/require policy
 * belong to the secured link — letting one identity talk signed on one
 * connection and unsigned on another.
 */

const {
  rolePreset,
  heartbeatFields,
  bindVehicleSysid,
  releaseVehicleSysid,
} = require('../lib/identity');
const { numberOr } = require('../lib/addressing');

module.exports = function registerMavlinkLocalIdentity(RED) {
  /**
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkLocalIdentityNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // role is editor-guaranteed: a `required` select of the ROLE_PRESETS keys
    // (mavlink-local-identity.html), so the red ring is the protector and the
    // runtime trusts the saved member (§6). A hand-edited non-member craters at
    // the preset read below, at construction.
    node.role = config.role;
    const preset = rolePreset(node.role);

    /**
     * Whether this identity derives its source sysid from the bound vehicle
     * rather than carrying a fixed value. True only for the companion role.
     * The Connection stamps the derived sysid at deploy via bindVehicleSysid.
     */
    node.derivesSysidFromVehicle = preset.derivesSysidFromVehicle;

    /** @type {Map<string, {sysid: number, source: string}>} keyed by connection id */
    node._vehicleSysidClaims = new Map();

    /** @type {number|null} null until a Connection derives it (companion only) */
    node._vehicleSysid = null;

    /**
     * Companion role: sysid is derived from the vehicle; compid is pinned to
     * 191 (MAV_COMP_ID_ONBOARD_COMPUTER). Config values saved by a previous
     * role are ignored rather than risking a silent mismatch.
     */
    if (node.derivesSysidFromVehicle) {
      node.sourceSystemId = null;
      node.sourceComponentId = 191;
    } else {
      // Editor validateUint8(1) owns the range; runtime trusts the form.
      node.sourceSystemId = Number(config.sourceSystemId);
      node.sourceComponentId = Number(config.sourceComponentId);
    }

    node.heartbeatType = config.heartbeatType || preset.heartbeatType;
    node.heartbeatAutopilot = config.heartbeatAutopilot || preset.heartbeatAutopilot;
    node.heartbeatIntervalMs = parseHeartbeatIntervalMs(config.heartbeatIntervalMs);

    node.status({ fill: 'grey', shape: 'ring', text: 'idle' });

    /**
     * Record a vehicle sysid claim from a Connection.
     * Companion only; throws on conflicting derivations.
     *
     * @param {number} sysid
     * @param {string} source   human-readable connection label
     * @param {string} sourceId connection node id
     */
    node.bindVehicleSysid = (sysid, source, sourceId) => {
      node._vehicleSysid = bindVehicleSysid(node._vehicleSysidClaims, sysid, source, sourceId);
    };

    /**
     * Drop a Connection's sysid claim (on close/redeploy).
     *
     * @param {string} sourceId  connection node id
     */
    node.releaseVehicleSysid = (sourceId) => {
      node._vehicleSysid = releaseVehicleSysid(node._vehicleSysidClaims, sourceId);
    };

    /**
     * The wire identity to stamp into outbound frame headers.
     *
     * @returns {{sysid: number, compid: number}}
     * @throws {Error} for an unbound companion (no Connection has derived sysid yet)
     */
    node.getIdentity = () => {
      if (node.derivesSysidFromVehicle) {
        if (node._vehicleSysid === null) {
          // eslint-disable-next-line no-restricted-syntax -- §0 rule 3: no Connection has resolved the vehicle sysid yet at call time
          throw new Error(
            `Local Identity '${config.name || node.id}' is an onboard companion whose` +
              ' source SysID comes from the Vehicle Profile it is bound to,' +
              ' but no Connection has resolved one yet.'
          );
        }
        return { sysid: node._vehicleSysid, compid: node.sourceComponentId };
      }
      return { sysid: node.sourceSystemId, compid: node.sourceComponentId };
    };

    /**
     * HEARTBEAT field values for this identity (DESIGN.md §7 Heartbeat).
     * Local Identity owns the heartbeat content and interval.
     *
     * @returns {import('../lib/identity/heartbeat').HeartbeatFields}
     */
    node.getHeartbeatFields = () =>
      heartbeatFields({ heartbeatType: node.heartbeatType, heartbeatAutopilot: node.heartbeatAutopilot });

    /**
     * Human-readable label for log messages and status: "name (sysid/compid)".
     *
     * @returns {string}
     */
    node.describe = () => {
      const sysid = node.derivesSysidFromVehicle
        ? node._vehicleSysid === null
          ? '<vehicle>'
          : node._vehicleSysid
        : node.sourceSystemId;
      return `${config.name || node.id} (${sysid}/${node.sourceComponentId})`;
    };
  }

  RED.nodes.registerType('mavlink-local-identity', MavlinkLocalIdentityNode);
};

/**
 * Blank defaults to 1 Hz. The editor's `positiveNumberValidator`
 * (mavlink-local-identity.html) owns the rest (§14: a finite-number check on
 * operator input is a guardrail).
 *
 * @param {*} value
 * @returns {number} interval in milliseconds; defaults to 1 Hz
 */
function parseHeartbeatIntervalMs(value) {
  return numberOr(value, 1000);
}
