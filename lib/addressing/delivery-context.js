'use strict';

const { resolveActionTarget, profileFromVehicleNode } = require('./resolve');

/**
 * Role × delivery-tier resolution shared by action palette nodes (DESIGN.md §6).
 *
 * Build + `__vehicle` → Vehicle Profile node. Build + concrete dialect → no
 * profile target rung (optional synthetic `{ firmware }` for Param). Wire tiers
 * → Connection's bound vehicle snapshot + Send-as identity.
 * @param {object} RED
 * @param {object} opts
 * @param {string} opts.delivery
 * @param {object} opts.config
 * @param {object} [opts.payload]
 * @param {object|null} [opts.connectionNode]  deploy-resolved Connection (wire tiers)
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
  const identityNode = isBuild
    ? null
    : (identityId ? RED.nodes.getNode(identityId) : null);

  const payloadTarget =
    payload && typeof payload === 'object' ? payload.target : undefined;

  const target = resolveActionTarget({
    payloadTarget,
    configSysid: config.targetSystem,
    configCompid: config.targetComponent,
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

module.exports = {
  resolveDeliveryContext,
};
