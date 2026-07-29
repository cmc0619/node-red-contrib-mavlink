'use strict';

/**
 * Addressing — the runtime half of the role × tier matrix (DESIGN.md §6).
 *
 * One resolution order everywhere, per field (sysid and compid resolve
 * independently):
 *
 *   1. msg.payload.target
 *   2. companion send-as identity → derived {airframe sysid, 1}
 *      (node config target ignored — hidden is not honored; a caller that
 *      keeps its compid field visible, i.e. Payload, opts out per field)
 *   3. node config target
 *   4. profile default (connection's bound profile on wire tiers, the node's
 *      Vehicle Profile field on Build)
 *   5. 1
 *
 * Blank means inherit. A configured 0 is broadcast and survives.
 *
 * Flow `msg` and editor-validated config are trusted — resolve/normalize
 * coerce and default; they do not re-validate.
 */

/**
 * Return the first argument that is neither undefined, null, nor the empty
 * string. Preserves an explicit 0 (unlike `||`).
 *
 * @param {...*} values
 * @returns {*}
 */
function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * Default a `{sysid, compid}` pair for Move / Param / Payload builders.
 * Missing → 1; explicit 0 kept. Same shape the three modules used locally.
 *
 * @param {{sysid?: *, compid?: *}|null|undefined} target
 * @returns {{sysid: number, compid: number}}
 */
function normalizeTarget(target) {
  return {
    sysid: target && target.sysid !== undefined ? Number(target.sysid) : 1,
    compid: target && target.compid !== undefined ? Number(target.compid) : 1,
  };
}

/**
 * Resolve an outbound target per the matrix.
 *
 * @param {object} opts
 * @param {{sysid?: *, compid?: *}} [opts.payloadTarget]  msg.payload.target, if any
 * @param {*} [opts.configSysid]   node config target sysid ('' = inherit)
 * @param {*} [opts.configCompid]  node config target compid ('' = inherit)
 * @param {object|null} [opts.identityNode]  the resolved send-as Local Identity
 *   node (wire tiers only; Build passes nothing — identity is hidden there)
 * @param {{targetSysid?: number, targetCompid?: number}|null} [opts.profile]
 *   profile target defaults: `connNode.vehicle` on wire tiers, the Vehicle
 *   Profile field's defaults on Build
 * @param {boolean} [opts.compidFromConfig]  keep the compid field authoritative
 *   even under a companion identity (Payload: compid addresses a payload
 *   device, not the autopilot)
 * @returns {{sysid: number, compid: number}}
 */
function resolveActionTarget(opts) {
  const payloadTarget = opts.payloadTarget || {};
  const profile = opts.profile || null;
  const identityNode = opts.identityNode || null;
  const companion = !!(identityNode && identityNode.derivesSysidFromVehicle);

  let derivedSysid;
  if (companion) {
    // getIdentity() throws when the companion was never bound to a vehicle —
    // that is a broken deploy and the loud crash is the correct signal (§2).
    derivedSysid = identityNode.getIdentity().sysid;
  }

  const sysid = Number(firstDefined(
    payloadTarget.sysid,
    companion ? derivedSysid : undefined,
    companion ? undefined : opts.configSysid,
    companion ? undefined : profile && profile.targetSysid,
    1
  ));

  const compid = companion && !opts.compidFromConfig
    ? Number(firstDefined(payloadTarget.compid, 1))
    : Number(firstDefined(
      payloadTarget.compid,
      opts.configCompid,
      profile && profile.targetCompid,
      1
    ));

  return { sysid, compid };
}

/**
 * Resolve the firmware a Param or Mission node should assume.
 * Order: payload override → profile → 'ardupilot'. Node-level firmware
 * dropdowns are gone (§6): stored `config.firmware` is hidden, and hidden is
 * not honored.
 *
 * @param {*} payloadFirmware  msg.payload.firmware, if any
 * @param {{firmware?: string}|null} profile  as for resolveActionTarget
 * @returns {string}
 */
function resolveFirmware(payloadFirmware, profile) {
  return firstDefined(payloadFirmware, profile && profile.firmware, 'ardupilot');
}

/**
 * Extract profile target defaults + firmware from a Vehicle Profile config
 * node (Build tier's `config.vehicle` reference).
 *
 * @param {object|null|undefined} vehicleNode
 * @returns {{targetSysid: number, targetCompid: number, firmware: string}|null}
 */
function profileFromVehicleNode(vehicleNode) {
  if (!vehicleNode) return null;
  return {
    targetSysid: vehicleNode.defaultTargetSystem,
    targetCompid: vehicleNode.defaultTargetComponent,
    firmware: vehicleNode.firmware,
  };
}

module.exports = {
  resolveActionTarget,
  resolveFirmware,
  profileFromVehicleNode,
  firstDefined,
  normalizeTarget,
};
