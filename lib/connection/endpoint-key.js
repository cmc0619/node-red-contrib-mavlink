'use strict';

/**
 * Canonical `address:port` key for peer endpoints (DESIGN.md §8: never address
 * alone). Shared by wire decode pipelines and TCP client maps so the formats
 * cannot drift — transport must not import the wire adapter for this alone.
 */

/** Fallback key for serial / tests that omit an endpoint. */
const DEFAULT_ENDPOINT_KEY = '__default__';

/**
 * @param {{address: string, port: number}|null|undefined} endpoint
 * @returns {string}
 */
function endpointKey(endpoint) {
  if (!endpoint || endpoint.address === undefined || endpoint.address === null) {
    return DEFAULT_ENDPOINT_KEY;
  }
  return `${endpoint.address}:${endpoint.port}`;
}

module.exports = { endpointKey, DEFAULT_ENDPOINT_KEY };
