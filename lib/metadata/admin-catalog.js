'use strict';

const { loadMetadata } = require('./load');

/**
 * Resolve a dialect catalog source from `?vehicle=` / `?dialect=` (DESIGN.md §6).
 *
 * Prefer a deployed Vehicle Profile's compiled bundle — including
 * `customDialectPath` profiles (normal operating mode). Never invent a bundled
 * dialect under a bare `vehicle=` key. Call `getDialect()` directly; let the
 * route handler report `err.message`. Strict mode returns HTTP error bodies;
 * soft mode returns empty notices (Payload field-tips).
 *
 * @param {object} RED
 * @param {object} api  loaded metadata API
 * @param {{vehicle?: string, dialect?: string}} query
 * @param {{ soft?: boolean }} [opts]
 * @returns
 *   | {{ kind: 'bundle', bundle: object, dialect: string }}
 *   | {{ kind: 'dialect', dialect: string }}
 *   | {{ kind: 'empty', dialect: string, notice: string }}
 *   | {{ kind: 'error', status: number, body: object }}
 */
function resolveCatalogSource(RED, api, query, opts = {}) {
  const soft = opts.soft === true;
  const vehicleId = typeof query.vehicle === 'string' ? query.vehicle.trim() : '';
  const requested = typeof query.dialect === 'string' && query.dialect.trim()
    ? query.dialect.trim()
    : '';
  const dialects = () => api.knownDialects();

  if (vehicleId) {
    const vehicleNode = RED.nodes.getNode(vehicleId);
    if (vehicleNode && typeof vehicleNode.getDialect === 'function') {
      const bundle = vehicleNode.getDialect();
      return {
        kind: 'bundle',
        bundle,
        dialect: vehicleNode.dialect || bundle.dialect || 'custom',
      };
    }
    if (!requested || requested === 'custom') {
      if (soft) {
        return {
          kind: 'empty',
          dialect: requested || '',
          notice: 'Vehicle Profile not deployed — deploy the flow first',
        };
      }
      return {
        kind: 'error',
        status: 404,
        body: {
          error: 'Vehicle Profile not found or not deployed; Deploy the flow, or pass a bundled ?dialect=',
          dialects: dialects(),
        },
      };
    }
    return { kind: 'dialect', dialect: requested };
  }

  if (!requested) {
    if (soft) {
      return { kind: 'empty', dialect: '', notice: 'no dialect supplied' };
    }
    return {
      kind: 'error',
      status: 400,
      body: { error: 'dialect is required', dialects: dialects() },
    };
  }
  if (requested === 'custom') {
    if (soft) {
      return {
        kind: 'empty',
        dialect: 'custom',
        notice: 'custom dialect requires a deployed Vehicle Profile (?vehicle=id)',
      };
    }
    return {
      kind: 'error',
      status: 400,
      body: {
        error: 'custom dialect requires a deployed Vehicle Profile (?vehicle=id)',
        dialects: dialects(),
      },
    };
  }
  return { kind: 'dialect', dialect: requested };
}

/**
 * Register a GET admin route that serves a dialect catalog from vehicle/dialect
 * query params. Shared by Command commands, Build messages, and Vehicle enums.
 *
 * @param {object} RED
 * @param {object} opts
 * @param {string} opts.path           e.g. `/mavlink/command/commands`
 * @param {string} opts.logLabel       for loadMetadata logging
 * @param {function} opts.fromBundle   (api, bundle, dialect, req) => json
 * @param {function} opts.fromDialect  (api, dialect, req) => json
 * @param {string} [opts.unavailableMessage]
 */
function registerDialectCatalogRoute(RED, opts) {
  const {
    path: routePath,
    logLabel,
    fromBundle,
    fromDialect,
    unavailableMessage = 'catalog unavailable',
  } = opts;

  const { api, error } = loadMetadata(logLabel, RED);

  RED.httpAdmin.get(
    routePath,
    RED.auth.needsPermission('mavlink.read'),
    (req, res) => {
      if (!api) {
        return res.status(503).json({
          error: error ? error.message : unavailableMessage,
        });
      }
      try {
        const source = resolveCatalogSource(RED, api, req.query || {});
        if (source.kind === 'error') {
          return res.status(source.status).json(source.body);
        }
        if (source.kind === 'bundle') {
          return res.json(fromBundle(api, source.bundle, source.dialect, req));
        }
        return res.json(fromDialect(api, source.dialect, req));
      } catch (err) {
        return res.status(400).json({
          error: err.message,
          dialects: api.knownDialects(),
        });
      }
    }
  );

  return { api, error };
}

module.exports = {
  resolveCatalogSource,
  registerDialectCatalogRoute,
};
