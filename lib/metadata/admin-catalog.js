'use strict';

const { knownDialects, loadBundled } = require('./bundled');

/**
 * Resolve a dialect catalog source from `?vehicle=` / `?dialect=` (DESIGN.md §6).
 *
 * Prefer a deployed Vehicle Profile's compiled bundle — seed or catalog snapshot
 * alike. Never invent a bundled dialect under a bare `vehicle=` key: a profile
 * that is not deployed, with no `?dialect=` beside it, resolves to null and each
 * route answers that its own way. Call `getDialect()` directly; let the route
 * handler report `err.message`.
 *
 * @param {object} RED
 * @param {{vehicle?: string, dialect?: string}} query
 * @returns {?{bundle: object, dialect: string}}
 */
function resolveCatalogSource(RED, query) {
  const vehicleId = query.vehicle;
  const requested = query.dialect;

  if (vehicleId) {
    const vehicleNode = RED.nodes.getNode(vehicleId);
    if (vehicleNode && typeof vehicleNode.getDialect === 'function') {
      return { bundle: vehicleNode.getDialect(), dialect: vehicleNode.dialect };
    }
    if (!requested) return null;
  }

  return { bundle: loadBundled(requested), dialect: requested };
}

/**
 * Register a GET admin route that serves a dialect catalog from vehicle/dialect
 * query params. Shared by Command commands, Build messages, and Vehicle enums.
 *
 * @param {object} RED
 * @param {object} opts
 * @param {string} opts.path           e.g. `/mavlink/command/commands`
 * @param {function} opts.fromBundle   (bundle, dialect, req) => json
 */
function registerDialectCatalogRoute(RED, opts) {
  const { path: routePath, fromBundle } = opts;

  RED.httpAdmin.get(
    routePath,
    RED.auth.needsPermission('mavlink.read'),
    (req, res) => {
      try {
        const source = resolveCatalogSource(RED, req.query);
        if (!source) {
          return res.status(404).json({
            error: 'Vehicle Profile not found or not deployed; Deploy the flow, or pass a bundled ?dialect=',
            dialects: knownDialects(),
          });
        }
        return res.json(fromBundle(source.bundle, source.dialect, req));
      } catch (err) {
        return res.status(400).json({
          error: err.message,
          dialects: knownDialects(),
        });
      }
    }
  );
}

module.exports = {
  resolveCatalogSource,
  registerDialectCatalogRoute,
};
