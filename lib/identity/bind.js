'use strict';

/**
 * Companion sysid binding utilities (DESIGN.md §7).
 *
 * A companion computer's source sysid is derived from the vehicle it belongs
 * to — it IS a component of that vehicle's system. The Connection stamps the
 * derived sysid at deploy time via `bindVehicleSysid`; `releaseVehicleSysid`
 * drops the claim when that connection closes or is redeployed.
 *
 * Multiple connections may bind the same companion identity, but only if they
 * all derive the same sysid. Conflicting derivations — companion bound to two
 * connections pointing at different vehicles — throw rather than silently
 * picking one.
 *
 * The claims map is owned by the caller (the node instance). These are pure
 * functions that operate on it without side effects.
 */

/**
 * @typedef {Map<string, {sysid: number, source: string}>} ClaimsMap
 *   keyed by the connection's node id (sourceId)
 */

/**
 * Record a vehicle sysid claim from a connection.
 *
 * Throws when a second connection tries to derive a *different* sysid for the
 * same identity — a companion is on one airframe.
 *
 * @param {ClaimsMap} claims
 * @param {number}    sysid     vehicle sysid being claimed
 * @param {string}    source    human-readable source label (connection name/id)
 * @param {string}    sourceId  stable key for this claim (connection node id)
 * @returns {number}  the now-current sysid
 * @throws {Error} on conflicting sysid derivation
 */
function bindVehicleSysid(claims, sysid, source, sourceId) {
  for (const [id, claim] of claims) {
    if (id !== sourceId && claim.sysid !== sysid) {
      // eslint-disable-next-line no-restricted-syntax -- §0 rule 3: two Connections deriving different sysids for one companion is cross-node state no single editor dialog can see
      throw new Error(
        `Companion identity sysid conflict: '${claim.source}' derives sysid ${claim.sysid}` +
          ` but '${source}' derives sysid ${sysid}.` +
          ' A companion belongs to one airframe — use the GCS role for multi-vehicle runtimes.'
      );
    }
  }
  claims.set(sourceId, { sysid, source });
  return sysid;
}

/**
 * Drop a connection's sysid claim. Returns the remaining live sysid, or null
 * when no other connection holds a claim.
 *
 * @param {ClaimsMap} claims
 * @param {string}    sourceId
 * @returns {number|null}
 */
function releaseVehicleSysid(claims, sourceId) {
  claims.delete(sourceId);
  const next = claims.values().next();
  return next.done ? null : next.value.sysid;
}

module.exports = { bindVehicleSysid, releaseVehicleSysid };
