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

module.exports = function registerMavlinkLocalIdentity(RED) {
  /**
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkLocalIdentityNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    /**
     * Whether this identity derives its source sysid from the bound vehicle
     * rather than carrying a fixed value. True only for the companion role.
     * The Connection stamps the derived sysid at deploy.
     */
    switch (config.role) {
      case 'companion':
        node.derivesSysidFromVehicle = true;
        break;
      case 'gcs':
      case 'custom':
        node.derivesSysidFromVehicle = false;
        break;
      default: break; // This space intentionally left blank (§5)
    }

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
     * The wire identity to stamp into outbound frame headers. A companion no
     * Connection has bound yet carries a null sysid.
     *
     * @returns {{sysid: number|null, compid: number}}
     */
    node.bindVehicleSysid = (sysid) => { node._vehicleSysid = sysid; };

    node.getIdentity = () => node.derivesSysidFromVehicle
      ? { sysid: node._vehicleSysid, compid: node.sourceComponentId }
      : { sysid: node.sourceSystemId, compid: node.sourceComponentId };

    /**
     * HEARTBEAT content this identity owns (DESIGN.md §7 Heartbeat): the
     * MAV_TYPE and MAV_AUTOPILOT names, resolved to wire values by the
     * Connection that emits them.
     *
     * @returns {{type: string, autopilot: string}}
     */
    node.getHeartbeatFields = () => ({ type: node.heartbeatType, autopilot: node.heartbeatAutopilot });

  }

  RED.nodes.registerType('mavlink-local-identity', MavlinkLocalIdentityNode);
};
