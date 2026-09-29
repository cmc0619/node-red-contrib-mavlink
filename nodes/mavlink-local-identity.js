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
     * CompID is the operator's in every role: MAV_COMPONENT carries four
     * onboard-computer slots (191-194), so a second companion on a link has
     * somewhere to sit. Editor validateUint8(1) owns the range; runtime
     * trusts the form.
     */
    node.sourceComponentId = Number(config.sourceComponentId);

    /**
     * The role selects where the source sysid comes from (§5). A companion
     * derives it from the bound vehicle — that one field has no saved value
     * to read, and the Connection binds it at deploy; a ground station or a
     * custom identity carries its saved value. `derivesSysidFromVehicle` is
     * the flag addressing reads to target the companion's own vehicle.
     * `getIdentity` is the wire identity stamped into outbound frame headers;
     * a companion no Connection has bound yet carries a null sysid. A role no
     * case answers to defines neither method and craters at the Connection.
     */
    switch (config.role) {
      case 'companion': {
        let vehicleSysid = null;
        node.derivesSysidFromVehicle = true;
        node.sourceSystemId = null;
        node.bindVehicleSysid = (sysid) => { vehicleSysid = sysid; };
        node.getIdentity = () => ({ sysid: vehicleSysid, compid: node.sourceComponentId });
        break;
      }
      case 'gcs':
      case 'custom':
        node.derivesSysidFromVehicle = false;
        node.sourceSystemId = Number(config.sourceSystemId);
        node.bindVehicleSysid = () => { /** A fixed identity keeps its saved sysid. */ };
        node.getIdentity = () => ({ sysid: node.sourceSystemId, compid: node.sourceComponentId });
        break;
      default: break; // This space intentionally left blank (§5)
    }

    // Both fields carry concrete editor defaults with no blank affordance
    // (mavlink-local-identity.html) — the editor owns the gcs-matching
    // default, so the runtime just reads what was saved (§6).
    node.heartbeatType = config.heartbeatType;
    node.heartbeatAutopilot = config.heartbeatAutopilot;
    // The editor owns the 1000 default and the positive ring
    // (mavlink-local-identity.html) — just convert it.
    node.heartbeatIntervalMs = Number(config.heartbeatIntervalMs);

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
