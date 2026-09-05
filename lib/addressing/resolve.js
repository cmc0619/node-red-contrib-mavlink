'use strict';

/**
 * Addressing — the runtime half of the role × tier matrix (DESIGN.md §6).
 *
 * One resolution order everywhere, per field (sysid and compid resolve
 * independently):
 *
 *   1. msg.payload.target
 *   2. companion identity → derived {airframe sysid, 1}
 *      (node config target ignored — hidden is not honored; a caller that
 *      keeps its compid field visible, i.e. Payload, opts out per field)
 *   3. node config target
 *   4. profile default (connection's bound profile on wire tiers; on Build
 *      only the node's Vehicle Profile field, and only when the dialect is the
 *      `__vehicle` escape — a concrete Build dialect has no profile rung)
 *
 * Blank means inherit. A configured 0 is broadcast and survives.
 * Companion's trailing compid `1` is the derived autopilot address, not a
 * global "nothing configured" fallback — profile/config supply the rest.
 *
 * Flow `msg` and editor-validated config are trusted — resolve coerces and
 * inherits; it does not re-validate ranges.
 */

/**
 * Blank means "no value supplied": undefined, null, or a string with nothing
 * in it but whitespace.
 *
 * The whitespace arm is load-bearing, not tidiness: `Number(' ')` is a
 * *finite* 0, and 0 is a legitimate broadcast sysid/compid — so a blank test
 * of `=== ''` lets a string that merely looks empty skip the inherit chain
 * and silently become broadcast. A padded number (`' 4 '`) is still a
 * value — only strings with no content are blank.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isBlank(value) {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
}

/**
 * Return the first argument that is not blank. Preserves an explicit 0
 * (unlike `||`).
 *
 * @param {...*} values
 * @returns {*}
 */
function firstDefined(...values) {
  for (const v of values) {
    if (!isBlank(v)) return v;
  }
  return undefined;
}

/**
 * Payload-first scalar. Only absence selects the configured value; an explicit
 * payload value — null, blank, 0 — rides unchanged.
 *
 * @param {object} payload
 * @param {object} config
 * @param {string} key
 * @returns {*}
 */
function valueFrom(payload, config, key) {
  return payload[key] === undefined ? config[key] : payload[key];
}

/**
 * Resolve an outbound target per the matrix.
 *
 * @param {object} opts
 * @param {{sysid?: *, compid?: *}} [opts.payloadTarget]  msg.payload.target, if any
 * @param {*} [opts.configSysid]   node config target sysid ('' = inherit)
 * @param {*} [opts.configCompid]  node config target compid ('' = inherit)
 * @param {object|null} [opts.identityNode]  the resolved Local Identity
 *   node (wire tiers only; Build passes nothing — identity is hidden there)
 * @param {{targetSystem?: number, targetComponent?: number}|null} [opts.profile]
 *   profile target defaults: `connNode.vehicle` on wire tiers; on Build the
 *   Vehicle Profile field's defaults, and only under the `__vehicle` escape
 * @param {boolean} [opts.compidFromConfig]  keep the compid field authoritative
 *   even under a companion identity (Payload: compid addresses a payload
 *   device, not the autopilot)
 * @returns {{sysid: number, compid: number}}
 */
function resolveActionTarget(opts) {
  const payloadTarget = opts.payloadTarget === undefined ? {} : opts.payloadTarget;
  const profile = opts.profile;
  const identityNode = opts.identityNode;
  const companion = Boolean(identityNode && identityNode.derivesSysidFromVehicle);

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
    companion ? undefined : profile && profile.targetSystem
  ));

  // Companion → autopilot compid 1 unless payload overrides (matrix step 2).
  const compid = companion && !opts.compidFromConfig
    ? Number(firstDefined(payloadTarget.compid, 1))
    : Number(firstDefined(
      payloadTarget.compid,
      opts.configCompid,
      profile && profile.targetComponent
    ));

  return { sysid, compid };
}

/**
 * Extract profile target defaults + firmware/family from a Vehicle Profile
 * config node (Build tier's `config.vehicle` reference).
 *
 * @param {object} vehicleNode  a deployed Vehicle Profile node; a missing one
 *   craters here rather than resolving to nothing
 * @returns {{targetSystem: number, targetComponent: number, firmware: string,
 *   vehicleFamily: string}}
 */
function profileFromVehicleNode(vehicleNode) {
  return {
    targetSystem: vehicleNode.defaultTargetSystem,
    targetComponent: vehicleNode.defaultTargetComponent,
    firmware: vehicleNode.firmware,
    vehicleFamily: vehicleNode.vehicleFamily,
  };
}

module.exports = {
  resolveActionTarget,
  profileFromVehicleNode,
  firstDefined,
  valueFrom,
  isBlank,
};
