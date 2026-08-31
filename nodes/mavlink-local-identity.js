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
  ROLE_PRESETS,
  heartbeatFields,
} = require('../lib/identity');

module.exports = function registerMavlinkLocalIdentity(RED) {
  /**
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkLocalIdentityNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.role = config.role;
    const preset = ROLE_PRESETS[node.role];

    /**
     * Whether this identity derives its source sysid from the bound vehicle
     * rather than carrying a fixed value. True only for the companion role.
     * The Connection stamps the derived sysid at deploy via bindVehicleSysid.
     */
    node.derivesSysidFromVehicle = preset.derivesSysidFromVehicle;

    /** @type {Map<string, number>} keyed by connection id */
    node._vehicleSysidClaims = new Map();

    /** @type {number|null} null until a Connection derives it (companion only) */
    node._vehicleSysid = null;

    /**
     * Companion role derives its sysid from the vehicle — that one field has no
     * saved value to read. CompID is the operator's in every role: MAV_COMPONENT
     * carries four onboard-computer slots (191-194), so a second companion on a
     * link has somewhere to sit. Editor validateUint8(1) owns the range; runtime
     * trusts the form.
     */
    node.sourceSystemId = node.derivesSysidFromVehicle ? null : Number(config.sourceSystemId);
    node.sourceComponentId = Number(config.sourceComponentId);

    // Both fields carry concrete editor defaults with no blank affordance
    // (mavlink-local-identity.html) — the editor owns the gcs-matching
    // default, so the runtime just reads what was saved (§6).
    node.heartbeatType = config.heartbeatType;
    node.heartbeatAutopilot = config.heartbeatAutopilot;
    // The editor owns the 1000 default and the positive ring
    // (mavlink-local-identity.html) — just convert it.
    node.heartbeatIntervalMs = Number(config.heartbeatIntervalMs);

    node.status({ fill: 'grey', shape: 'ring', text: 'idle' });

    /**
     * Record a vehicle sysid claim from a Connection.
     * Companion only; throws on conflicting derivations.
     *
     * @param {number} sysid
     * @param {string} sourceId connection node id
     */
    node.bindVehicleSysid = (sysid, sourceId) => {
      // getIdentity() answers connection-agnostically at action time, so two
      // Connections deriving different sysids would retarget one link's
      // actions to the other's aircraft. Cross-node state no single editor
      // dialog can see — a companion belongs to one airframe (§14.136).
      for (const [id, claimed] of node._vehicleSysidClaims) {
        if (id !== sourceId && claimed !== sysid) {
          // eslint-disable-next-line no-restricted-syntax -- §0 rule 3: two Connections deriving different sysids for one companion is cross-node state no single editor dialog can see
          throw new Error(
            `Companion identity sysid conflict: one Connection derives sysid ${claimed}` +
              ` but another derives sysid ${sysid}.` +
              ' A companion belongs to one airframe — use the GCS role for multi-vehicle runtimes.'
          );
        }
      }
      node._vehicleSysidClaims.set(sourceId, sysid);
      node._vehicleSysid = sysid;
    };

    /**
     * Drop a Connection's sysid claim (on close/redeploy).
     *
     * @param {string} sourceId  connection node id
     */
    node.releaseVehicleSysid = (sourceId) => {
      node._vehicleSysidClaims.delete(sourceId);
      const next = node._vehicleSysidClaims.values().next();
      node._vehicleSysid = next.done ? null : next.value;
    };

    /**
     * The wire identity to stamp into outbound frame headers. A companion no
     * Connection has bound yet carries a null sysid.
     *
     * @returns {{sysid: number|null, compid: number}}
     */
    node.getIdentity = () => node.derivesSysidFromVehicle
      ? { sysid: node._vehicleSysid, compid: node.sourceComponentId }
      : { sysid: node.sourceSystemId, compid: node.sourceComponentId };

    /**
     * HEARTBEAT field values for this identity (DESIGN.md §7 Heartbeat).
     * Local Identity owns the heartbeat content and interval.
     *
     * @returns {import('../lib/identity/heartbeat').HeartbeatFields}
     */
    node.getHeartbeatFields = () =>
      heartbeatFields({ heartbeatType: node.heartbeatType, heartbeatAutopilot: node.heartbeatAutopilot });

  }

  RED.nodes.registerType('mavlink-local-identity', MavlinkLocalIdentityNode);
};
