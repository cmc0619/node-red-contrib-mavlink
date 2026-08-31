'use strict';

const { resolveActionTarget, profileFromVehicleNode } = require('./resolve');

/**
 * Role × delivery-tier resolution shared by action palette nodes (DESIGN.md §6).
 *
 * Build + `__vehicle` → Vehicle Profile node. Build + concrete dialect → no
 * profile target rung (optional synthetic `{ firmware }` for Param). Wire tiers
 * → Connection's bound vehicle snapshot + Identity.
 * @param {object} RED
 * @param {object} opts
 * @param {string} opts.delivery
 * @param {object} opts.config
 * @param {object} [opts.payload]
 * @param {object|null} [opts.connectionNode]  deploy-resolved Connection (wire tiers)
 * @param {boolean} [opts.buildFirmwareProfile]  Param: concrete Build carries firmware
 * @param {boolean} [opts.compidFromConfig]  passed to resolveActionTarget
 * @returns {{ isBuild: boolean, useVehicle: boolean, connectionNode: object|null,
 *   profile: object|null, target: {sysid:number,compid:number},
 *   identityId: string }}
 */
function resolveDeliveryContext(RED, opts) {
  const {
    delivery,
    config,
    payload,
    connectionNode: givenConnection,
    buildFirmwareProfile = false,
    compidFromConfig,
  } = opts;

  // Editor default is `identity: ''` (no override). Admin API deploy of
  // example JSON omits that key; String(undefined) is the override id
  // "undefined", which Connection.send cannot resolve (§14).
  const identityId = payload.identityId === undefined ? config.identity : payload.identityId;

  // One tier dispatch composes the whole role context (§5). Build composes
  // the profile axis; the wire stack — the union of every caller's tier
  // select (command send/confirm/complete, param send/confirm/collect,
  // payload send/confirm, mission confirm, move send/confirm/stream) —
  // composes the Connection axis. A tier no editor select can save matches
  // no case: every field below stays unset, and the caller's own tier
  // dispatch selects nothing with the result.
  let isBuild;
  let useVehicle;
  let connectionNode;
  let profile;
  let identityNode;
  let sourceSysid;
  switch (delivery) {
    case 'build':
      isBuild = true;
      connectionNode = null;
      useVehicle = config.dialect === '__vehicle';
      if (useVehicle) {
        profile = profileFromVehicleNode(RED.nodes.getNode(config.vehicle));
      } else if (buildFirmwareProfile) {
        profile = { firmware: config.firmware };
      }
      break;
    case 'send':
    case 'confirm':
    case 'complete':
    case 'collect':
    case 'stream':
      connectionNode = givenConnection;
      isBuild = false;
      useVehicle = false;
      profile = connectionNode.vehicle;
      identityNode = RED.nodes.getNode(identityId);
      if (identityNode && identityNode.derivesSysidFromVehicle) {
        sourceSysid = connectionNode.resolveSourceIds(identityId).sysid;
      }
      break;
    default: break; // This space intentionally left blank (§5)
  }

  const payloadTarget = payload.target;

  const target = resolveActionTarget({
    payloadTarget,
    configSysid: config.targetSystem,
    configCompid: config.targetComponent,
    derivesSysidFromVehicle: !!(identityNode && identityNode.derivesSysidFromVehicle),
    sourceSysid,
    profile,
    compidFromConfig,
  });

  return {
    isBuild,
    useVehicle,
    connectionNode,
    profile,
    target,
    identityId,
  };
}

module.exports = {
  resolveDeliveryContext,
};
