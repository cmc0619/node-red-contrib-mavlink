'use strict';

const { resolveActionTarget, profileFromVehicleNode } = require('./resolve');
const { applyActionStatus } = require('../delivery');

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

  // Editor default is `identity: ''` (no override). Admin API deploy of
  // example JSON omits that key; String(undefined) is the override id
  // "undefined", which Connection.send cannot resolve (§14).
  const rawIdentity =
    payload && payload.identityId != null ? payload.identityId : config.identity;
  const identityId = rawIdentity == null ? '' : String(rawIdentity);
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

/**
 * Write the §6 deploy-time Connection badge, once, at the resolution boundary.
 *
 * §6's status table carries one exception to "action nodes report last
 * activity", and this is it. Red means something outside this node said no,
 * never "your settings are wrong". An unresolvable Connection qualifies on
 * those terms: the link this node was pointed at is not there, which is
 * another node's verdict, not the operator's typo. Hence `error` /
 * `no connection`.
 *
 * It is also the one config fault the editor cannot catch. The id is valid
 * there; it fails only when the runtime constructs the config node — disabled,
 * or its constructor threw — so there is nothing for a validator to see. That
 * is what keeps this from being a runtime re-check of editor work.
 *
 * Both halves matter. Node-RED publishes a status clear only when a node is
 * *removed*, not when it is modified and restarted, and the editor replays the
 * last status it received — so without the `node.status({})` a node that was
 * fixed and redeployed would keep displaying the dead badge (§14).
 *
 * This reports; it does not gate. The per-message failure path is each node's
 * own catch-all, which already turns an unusable Connection into a terminal
 * record on output 1 plus one `done(err)`.
 *
 * @param {object} node
 * @param {boolean} required  false only when this config works without a
 *   Connection — a Build tier, or fan-out's build+list exception
 * @param {object|null|undefined} connectionNode  deploy-resolved Connection
 */
function applyConnectionStatus(node, required, connectionNode) {
  if (required && !connectionNode) {
    applyActionStatus(node, 'error', 'no connection');
    return;
  }
  node.status({});
}

module.exports = {
  resolveDeliveryContext,
  applyConnectionStatus,
};
