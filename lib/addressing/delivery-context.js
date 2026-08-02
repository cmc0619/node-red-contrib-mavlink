'use strict';

const { resolveActionTarget, profileFromVehicleNode, firstDefined } = require('./resolve');
const { applyActionStatus } = require('../delivery');

/**
 * Role × delivery-tier resolution shared by action palette nodes (DESIGN.md §6).
 *
 * Build + `__vehicle` → Vehicle Profile node. Build + concrete dialect → no
 * profile target rung (optional synthetic `{ firmware }` for Param). Wire tiers
 * → Connection's bound vehicle snapshot + Send-as identity.
 *
 * Command historically persisted `targetSysid` / `targetCompid`; readers accept
 * those as a one-shot compat fallback behind the canonical
 * `targetSystem` / `targetComponent` names.
 *
 * @param {object} RED
 * @param {object} opts
 * @param {string} opts.delivery
 * @param {object} opts.config
 * @param {object} [opts.payload]
 * @param {object|null} [opts.connectionNode]  Connection bound at deploy (wire tiers).
 *   Callers must pass the closed-over ref — this helper does **not** re-`getNode`
 *   `config.connection` (Node-RED restarts consumers when a config node restarts;
 *   per-message re-lookup is false lifecycle recovery).
 * @param {boolean} [opts.buildFirmwareProfile]  Param: concrete Build carries firmware
 * @param {boolean} [opts.compidFromConfig]  passed to resolveActionTarget
 * @returns {{ isBuild: boolean, useVehicle: boolean, connectionNode: object|null,
 *   profile: object|null, identityNode: object|null, target: {sysid:number,compid:number},
 *   identityId: string }}
 */
function resolveDeliveryContext(RED, opts) {
  const {
    delivery,
    config,
    payload = {},
    connectionNode: givenConnection = null,
    buildFirmwareProfile = false,
    compidFromConfig,
  } = opts;

  const isBuild = delivery === 'build';
  // Wire tiers: trust the deploy-time bind. Build has no Connection.
  const connectionNode = isBuild ? null : givenConnection;
  const useVehicle = isBuild && config.dialect === '__vehicle';

  let profile;
  if (isBuild) {
    if (useVehicle) {
      profile = profileFromVehicleNode(RED.nodes.getNode(config.vehicle));
    } else if (buildFirmwareProfile) {
      profile = { firmware: config.firmware };
    } else {
      profile = null;
    }
  } else {
    profile = (connectionNode && connectionNode.vehicle) || null;
  }

  const identityId = String(
    (payload && payload.identityId != null ? payload.identityId : config.identity) || ''
  );
  // Dynamic msg.identityId is a runtime boundary; static config.identity still
  // resolves here (bind-once identity is a follow-on).
  const identityNode = isBuild
    ? null
    : (identityId ? RED.nodes.getNode(identityId) : null);

  const payloadTarget =
    payload && typeof payload === 'object' ? payload.target : undefined;

  // Canonical names first; Command's historical targetSysid/targetCompid last.
  const configSysid = firstDefined(config.targetSystem, config.targetSysid);
  const configCompid = firstDefined(config.targetComponent, config.targetCompid);

  const target = resolveActionTarget({
    payloadTarget,
    configSysid,
    configCompid,
    identityNode,
    profile,
    compidFromConfig,
  });

  return {
    isBuild,
    useVehicle,
    connectionNode,
    profile,
    identityNode,
    target,
    identityId,
  };
}

/**
 * Deploy-time gate: wire tiers need a Connection (§9).
 * Sets the invalid-config badge when missing; clears status otherwise.
 * Call once from the constructor with the bind-once Connection ref.
 *
 * @param {object} node
 * @param {string} delivery
 * @param {object|null|undefined} connectionNode
 * @returns {boolean} true when the gate fails (no connection on a wire tier)
 */
function missingConnectionGate(node, delivery, connectionNode) {
  if (delivery !== 'build' && !connectionNode) {
    applyActionStatus(node, 'invalid', 'invalid config');
    return true;
  }
  node.status({});
  return false;
}

module.exports = {
  resolveDeliveryContext,
  missingConnectionGate,
};
