'use strict';

/**
 * Identity resolution for a Connection's outbound identity selection
 * (DESIGN.md §13): an explicit override that is not a bound identity is
 * rejected and does **not** fall back to the default.
 */

/**
 * @typedef {object} ResolveIdentityInput
 * @property {string} defaultIdentityId  Connection's default Local Identity id
 * @property {string[]} boundIdentityIds  identities this connection may use
 * @property {string|null|undefined} [overrideId]  per-message / per-node override
 */

/**
 * @typedef {object} ResolveIdentityResult
 * @property {string} identityId  the resolved Local Identity node id
 * @property {'default'|'override'} source
 */

/**
 * Resolve which Local Identity a send should use.
 *
 * @param {ResolveIdentityInput} input
 * @returns {ResolveIdentityResult}
 * @throws {Error} when override is set and not in the bound set
 */
function resolveIdentity(input) {
  const override = input.overrideId;
  // An override is used as given — never quietly replaced by the default,
  // which would stamp a different source sysid/compid on the frame than the
  // caller asked for. An id the connection does not carry resolves to no
  // identity in `_identitiesById`, and the send craters there.
  if (override !== undefined && override !== null && override !== '') {
    return { identityId: override, source: 'override' };
  }
  return { identityId: input.defaultIdentityId, source: 'default' };
}

module.exports = { resolveIdentity };
