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
  const bound = Array.isArray(input.boundIdentityIds) ? input.boundIdentityIds : [];
  const defaultId = input.defaultIdentityId;
  const override = input.overrideId;

  if (override !== undefined && override !== null && override !== '') {
    if (!bound.includes(override)) {
      throw new Error(
        `Identity override '${override}' is not among the connection's bound identities` +
          (bound.length ? ` (${bound.join(', ')})` : ' (none bound)') +
          '; refusing to fall back to the default.'
      );
    }
    return { identityId: override, source: 'override' };
  }

  if (!defaultId) {
    throw new Error('Connection has no default Local Identity.');
  }
  if (bound.length && !bound.includes(defaultId)) {
    throw new Error(
      `Default identity '${defaultId}' is not among the connection's bound identities.`
    );
  }
  return { identityId: defaultId, source: 'default' };
}

module.exports = { resolveIdentity };
