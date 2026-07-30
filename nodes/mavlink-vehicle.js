'use strict';

/**
 * mavlink-vehicle — Vehicle Profile config node (DESIGN.md §3, §7, §11, §12.3).
 *
 * A Vehicle Profile describes the vehicle being *addressed*: dialect, firmware,
 * default target ids, and vehicle family for mode tables and parameter metadata.
 * It deliberately owns nothing about the local side — no source sysid/compid,
 * no heartbeat identity, no signing. Those belong to the Local Identity node.
 *
 * One connection, one Vehicle Profile: everything arriving on a connection is
 * decoded against its profile — one dialect, one firmware, no per-packet lookup
 * (§7). A mixed fleet is expressed as more connections, not more configuration
 * inside one.
 *
 * The type is always registered even if `mavlink-mappings` failed to load, so
 * Connection / Build keep their standard config-node edit/add pickers. Runtime
 * dialect access then fails loud with a status badge.
 */

let vehicleApi = null;
/** @type {Error|null} */
let vehicleLoadError = null;
try {
  vehicleApi = require('../lib/vehicle');
} catch (err) {
  vehicleLoadError = err;
}

/** Admin endpoint path for dialect list. */
const DIALECTS_ROUTE = '/mavlink/dialects';
/** Admin endpoint path for shared dialect enum catalogs. */
const ENUMS_ROUTE = '/mavlink/enums';
/** Admin endpoint base path for the downloadable XML dialect catalog (§4). */
const XML_CATALOG_ROUTE = '/mavlink/xml-catalog';

/** Whether the admin dialects route has been registered (once per process). */
let _dialectsRouteRegistered = false;
/** Whether the admin enums route has been registered (once per process). */
let _enumsRouteRegistered = false;
/** Whether the XML-catalog routes have been registered (once per process). */
let _xmlCatalogRouteRegistered = false;

/**
 * Resolve the XML-catalog cache directory under the Node-RED user dir
 * (`<userDir>/mavlink/xml`), falling back to the cwd when settings are absent.
 *
 * @param {object} RED
 * @returns {string}
 */
function xmlCatalogBaseDir(RED) {
  const path = require('path');
  const userDir = (RED && RED.settings && RED.settings.userDir) || process.cwd();
  return path.join(userDir, 'mavlink', 'xml');
}

module.exports = function registerMavlinkVehicle(RED) {
  if (!vehicleApi) {
    const msg = vehicleLoadError ? vehicleLoadError.message : 'vehicle library unavailable';
    if (RED.log && typeof RED.log.error === 'function') {
      RED.log.error(`[mavlink-vehicle] ${msg}`);
    }
    function BrokenVehicleNode(config) {
      RED.nodes.createNode(this, config);
      this.status({ fill: 'red', shape: 'ring', text: 'missing deps' });
      this.getDialect = () => {
        throw vehicleLoadError || new Error(msg);
      };
      // Do not invent profile defaults (especially target 1/1) on a broken
      // load — Connection must fail loud, not bind companions to system 1.
      this.getDefaults = () => {
        throw vehicleLoadError || new Error(msg);
      };
    }
    RED.nodes.registerType('mavlink-vehicle', BrokenVehicleNode);
    return;
  }

  const {
    normalizeFirmware,
    normalizeFamily,
    resolveDialect,
    knownDialects,
  } = vehicleApi;

  /**
   * Register the admin HTTP endpoint that serves the bundled dialect list to
   * editor dropdowns (§6 "Register with RED.auth.needsPermission"). Done once
   * per process; subsequent node registrations are no-ops.
   */
  if (!_dialectsRouteRegistered) {
    RED.httpAdmin.get(
      DIALECTS_ROUTE,
      RED.auth.needsPermission('mavlink.read'),
      (_req, res) => {
        res.json({ dialects: knownDialects() });
      }
    );
    _dialectsRouteRegistered = true;
  }

  /**
   * Register the shared enum catalog route used by editor dropdowns (§6).
   * It follows the same Vehicle Profile / dialect rules as the Build message
   * catalog: prefer a deployed profile's bundle, and never invent a bundled
   * dialect for a missing `?vehicle=`.
   */
  if (!_enumsRouteRegistered) {
    let catalogApi = null;
    let catalogLoadError = null;
    try {
      catalogApi = require('../lib/metadata');
    } catch (err) {
      catalogLoadError = err;
      if (RED.log && typeof RED.log.error === 'function') {
        RED.log.error(`[mavlink-vehicle] enum catalog unavailable: ${err.message}`);
      }
    }

    RED.httpAdmin.get(
      ENUMS_ROUTE,
      RED.auth.needsPermission('mavlink.read'),
      (req, res) => {
        if (!catalogApi) {
          return res.status(503).json({
            error: catalogLoadError
              ? catalogLoadError.message
              : 'enum catalog unavailable',
          });
        }
        const {
          listEnumsCatalog,
          catalogEnumsFromBundle,
          knownDialects,
        } = catalogApi;
        try {
          const vehicleId = typeof req.query.vehicle === 'string'
            ? req.query.vehicle.trim()
            : '';
          const requested = typeof req.query.dialect === 'string' && req.query.dialect.trim()
            ? req.query.dialect.trim()
            : '';
          const names = typeof req.query.names === 'string' ? req.query.names : '';

          if (vehicleId) {
            const vehicleNode = RED.nodes.getNode(vehicleId);
            if (vehicleNode && typeof vehicleNode.getDialect === 'function') {
              const bundle = vehicleNode.getDialect();
              const dialect = vehicleNode.dialect || bundle.dialect || 'custom';
              return res.json(catalogEnumsFromBundle(bundle, dialect, names));
            }
            if (!requested || requested === 'custom') {
              return res.status(404).json({
                error: 'Vehicle Profile not found or not deployed; Deploy the flow, or pass a bundled ?dialect=',
                dialects: knownDialects(),
              });
            }
            return res.json(listEnumsCatalog(requested, names));
          }

          const dialect = requested || 'ardupilotmega';
          if (dialect === 'custom') {
            return res.status(400).json({
              error: 'custom dialect requires a deployed Vehicle Profile (?vehicle=id)',
              dialects: knownDialects(),
            });
          }
          res.json(listEnumsCatalog(dialect, names));
        } catch (err) {
          res.status(400).json({
            error: err.message,
            dialects: catalogApi.knownDialects(),
          });
        }
      }
    );

    _enumsRouteRegistered = true;
  }

  /**
   * Downloadable MAVLink XML dialect catalog (§4). Downloaded XML files are
   * managed *Custom* dialect paths, not a new runtime mode and not a
   * replacement for bundled dialects. Registered once per process.
   *
   * GET  /mavlink/xml-catalog          dialect library (name → seed + dated versions)
   * POST /mavlink/xml-catalog/update   download/refresh from an official source
   * GET  /mavlink/xml-catalog/compare  informational diff vs the seed dialect
   */
  if (!_xmlCatalogRouteRegistered) {
    let catalogApi = null;
    let catalogLoadError = null;
    try {
      catalogApi = require('../lib/metadata');
    } catch (err) {
      catalogLoadError = err;
      if (RED.log && typeof RED.log.error === 'function') {
        RED.log.error(`[mavlink-vehicle] XML catalog unavailable: ${err.message}`);
      }
    }

    const newCatalog = () => new catalogApi.XmlCatalog({ baseDir: xmlCatalogBaseDir(RED) });
    const catalogUnavailable = (res) =>
      res.status(503).json({
        ok: false,
        error: catalogLoadError ? catalogLoadError.message : 'XML catalog unavailable',
      });

    // GET list: needs read permission (§6). Never discloses the absolute base
    // dir — only the per-file paths a profile persists into customDialectPath.
    RED.httpAdmin.get(
      XML_CATALOG_ROUTE,
      RED.auth.needsPermission('mavlink.read'),
      (_req, res) => {
        if (!catalogApi) {
          return catalogUnavailable(res);
        }
        try {
          const catalog = newCatalog();
          const library = catalogApi.dialectLibrary(catalog);
          res.json({ ok: true, dialects: library.dialects });
        } catch (err) {
          res.status(500).json({ ok: false, error: err.message, code: err.code });
        }
      }
    );

    // POST update: downloads (network + disk write). No `mavlink.write` scope
    // exists in this package, so it shares the read guard, matching the rest of
    // the admin routes here.
    RED.httpAdmin.post(
      `${XML_CATALOG_ROUTE}/update`,
      RED.auth.needsPermission('mavlink.read'),
      (req, res) => {
        if (!catalogApi) {
          return catalogUnavailable(res);
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        // `repo`/`ref` are interpolated into GitHub URLs — constrain their shape
        // so a crafted value cannot inject extra path segments server-side.
        if (body.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(String(body.repo))) {
          return res.status(400).json({ ok: false, error: "repo must look like 'owner/name'." });
        }
        if (body.ref !== undefined && !/^[\w./-]+$/.test(String(body.ref))) {
          return res.status(400).json({ ok: false, error: 'ref contains unsupported characters.' });
        }
        newCatalog()
          .update({
            repo: body.repo,
            ref: body.ref,
            files: Array.isArray(body.files) ? body.files : undefined,
          })
          .then((manifest) => res.json({ ok: true, manifest }))
          .catch((err) => res.status(500).json({ ok: false, error: err.message, code: err.code }));
      }
    );

    // GET compare: informational diff of a downloaded XML vs the bundled dialect.
    RED.httpAdmin.get(
      `${XML_CATALOG_ROUTE}/compare`,
      RED.auth.needsPermission('mavlink.read'),
      (req, res) => {
        if (!catalogApi) {
          return catalogUnavailable(res);
        }
        try {
          const result = newCatalog().compare({
            file: String(req.query.file || ''),
            snapshot: req.query.snapshot ? String(req.query.snapshot) : undefined,
          });
          res.json({ ok: true, comparison: result });
        } catch (err) {
          const status = err.code === 'XML_CATALOG_FILE_NOT_FOUND' ? 404 : 500;
          res.status(status).json({ ok: false, error: err.message, code: err.code });
        }
      }
    );

    _xmlCatalogRouteRegistered = true;
  }

  /**
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkVehicleNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.vehicleFamily = normalizeFamily(config.vehicleFamily);
    node.firmware = normalizeFirmware(config.firmware);
    node.dialect = (config.dialect || 'ardupilotmega').toLowerCase();
    // `seed` or a catalog snapshot id. Legacy flows may omit this and use
    // dialectSource/customDialectPath — resolveDialect still understands them.
    node.dialectRevision = config.dialectRevision ||
      (config.dialectSource === 'custom' ? '' : 'seed');
    node.dialectSource = config.dialectSource === 'custom' ? 'custom' : 'bundled';
    node.customDialectPath = (config.customDialectPath || '').trim();
    // Optional firmware/custom parameter-definition URL (PX4 / custom stacks).
    node.paramDefsUrl = typeof config.paramDefsUrl === 'string' ? config.paramDefsUrl.trim() : '';

    // Editor validateUint8(0) owns the range; runtime trusts the form.
    node.defaultTargetSystem = Number(config.defaultTargetSystem);
    node.defaultTargetComponent = Number(config.defaultTargetComponent);

    const problems = [];

    /** @type {import('../lib/metadata').DialectBundle|null} */
    node._bundle = null;

    try {
      node._bundle = resolveDialect({
        name: config.name,
        dialect: node.dialect,
        dialectRevision: node.dialectRevision || undefined,
        dialectSource: node.dialectSource,
        customDialectPath: node.customDialectPath,
        customDialectBundle: config.customDialectBundle || null,
        catalogBaseDir: xmlCatalogBaseDir(RED),
      });
    } catch (err) {
      problems.push(err.message.slice(0, 80));
    }

    if (problems.length) {
      const text = problems[0].slice(0, 24);
      node.status({ fill: 'red', shape: 'ring', text });
    } else {
      node.status({ fill: 'grey', shape: 'ring', text: 'idle' });
    }

    /**
     * The compiled DialectBundle for this profile.
     *
     * @returns {import('../lib/metadata').DialectBundle}
     * @throws {Error} when no bundle is loaded (custom dialect without files)
     */
    node.getDialect = () => {
      if (!node._bundle) {
        throw new Error(
          `Vehicle Profile '${config.name || node.id}' has no loaded dialect` +
            ' (custom source requires a compiled bundle).'
        );
      }
      return node._bundle;
    };

    /**
     * Profile defaults consumed by Connection and flow nodes.
     * Contains no local identity fields.
     *
     * @returns {{vehicleFamily: string, firmware: string, dialect: string,
     *            dialectSource: string, defaultTargetSystem: number,
     *            defaultTargetComponent: number}}
     */
    node.getDefaults = () => ({
      vehicleFamily: node.vehicleFamily,
      firmware: node.firmware,
      dialect: node.dialect,
      dialectRevision: node.dialectRevision || 'seed',
      dialectSource: node.dialectSource,
      customDialectPath: node.customDialectPath,
      paramDefsUrl: node.paramDefsUrl,
      defaultTargetSystem: node.defaultTargetSystem,
      defaultTargetComponent: node.defaultTargetComponent,
    });
  }

  RED.nodes.registerType('mavlink-vehicle', MavlinkVehicleNode);
};

/* Expose lists for editor HTML and tests */
module.exports.FIRMWARE_TYPES = vehicleApi ? vehicleApi.FIRMWARE_TYPES : [];
module.exports.VEHICLE_FAMILIES = vehicleApi ? vehicleApi.VEHICLE_FAMILIES : [];
