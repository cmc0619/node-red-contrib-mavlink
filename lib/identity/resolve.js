'use strict';

const { isBlank } = require('../addressing/resolve');

/**
 * Identity resolution for a Connection's outbound identity selection
 * (DESIGN.md §13). An override is passed through as given: this layer owns
 * one behaviour, not several, so it has no dispatcher and no membership test
 * (§0, §5). It never silently substitutes the default for an override the
 * caller asked for.
 */

/**
 * @typedef {object} ResolveIdentityInput
 * @property {string} defaultIdentityId  Connection's default Local Identity id
 * @property {string|null|undefined} [overrideId]  per-message / per-node override
 */

/**
 * @typedef {object} ResolveIdentityResult
 * @property {string} identityId  the resolved Local Identity node id
 */

/**
 * Resolve which Local Identity a send should use.
 *
 * @param {ResolveIdentityInput} input
 * @returns {ResolveIdentityResult}
 */
function resolveIdentity(input) {
  // An override is used as given — never quietly replaced by the default,
  // which would stamp a different source sysid/compid on the frame than the
  // caller asked for. An id the connection does not carry resolves to no
  // identity in `_identitiesById`, and the send craters there.
  return { identityId: isBlank(input.overrideId) ? input.defaultIdentityId : input.overrideId };
}

module.exports = { resolveIdentity };
