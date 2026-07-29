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
 * Resolved ids are MAVLink uint8 integers in [0, 255].
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
 * Validate a MAVLink uint8 target field value, returning the resolved number
 * and an error string (null when valid).
 *
 * Target ids allow 0 (broadcast / all) — unlike source ids which disallow it.
 * Used by the Vehicle Profile editor and by runtime target coercion.
 *
 * @param {*}      value
 * @param {string} field     readable field name for error messages
 * @param {number} fallback  value to return when blank
 * @returns {{value: number, error: string|null}}
 */
function parseTargetUint8(value, field, fallback) {
  if (value === undefined || value === null || value === '') {
    return { value: fallback, error: null };
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    return {
      value: fallback,
      error: `${field} must be an integer in [0, 255] (got ${JSON.stringify(value)})`,
    };
  }
  return { value: n, error: null };
}

/**
 * Coerce a target id through parseTargetUint8, throwing on invalid input.
 * Blank / missing → fallback. Explicit 0 is preserved.
 *
 * @param {*} value
 * @param {string} field
 * @param {number} fallback
 * @returns {number}
 */
function coerceTargetUint8(value, field, fallback) {
  const result = parseTargetUint8(value, field, fallback);
  if (result.error) throw new Error(result.error);
  return result.value;
}

/**
 * Normalize a `{sysid, compid}` target pair for Move / Param / Payload builders.
 * Missing fields default to 1; explicit 0 (broadcast) is kept; non-uint8 values
 * throw (runtime message boundary — not an editor contract).
 *
 * @param {{sysid?: *, compid?: *}|null|undefined} target
 * @returns {{sysid: number, compid: number}}
 */
function normalizeTarget(target) {
  const t = target || {};
  return {
    sysid: coerceTargetUint8(t.sysid, 'target.sysid', 1),
    compid: coerceTargetUint8(t.compid, 'target.compid', 1),
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

  const sysid = coerceTargetUint8(firstDefined(
    payloadTarget.sysid,
    companion ? derivedSysid : undefined,
    companion ? undefined : opts.configSysid,
    companion ? undefined : profile && profile.targetSysid,
    1
  ), 'target.sysid', 1);

  const compid = companion && !opts.compidFromConfig
    ? coerceTargetUint8(firstDefined(payloadTarget.compid, 1), 'target.compid', 1)
    : coerceTargetUint8(firstDefined(
      payloadTarget.compid,
      opts.configCompid,
      profile && profile.targetCompid,
      1
    ), 'target.compid', 1);

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
  parseTargetUint8,
  normalizeTarget,
};
