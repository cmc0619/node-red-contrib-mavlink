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

/** Whether the admin dialects route has been registered (once per process). */
let _dialectsRouteRegistered = false;

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
      this.getDefaults = () => ({
        vehicleFamily: config.vehicleFamily || 'generic',
        firmware: config.firmware || 'ardupilot',
        dialect: config.dialect || 'ardupilotmega',
        dialectSource: config.dialectSource || 'bundled',
        defaultTargetSystem: 1,
        defaultTargetComponent: 1,
      });
    }
    RED.nodes.registerType('mavlink-vehicle', BrokenVehicleNode);
    return;
  }

  const {
    normalizeFirmware,
    normalizeFamily,
    resolveDialect,
    parseTargetUint8,
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
   * @param {object} config  Node-RED node config from the editor
   */
  function MavlinkVehicleNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.vehicleFamily = normalizeFamily(config.vehicleFamily);
    node.firmware = normalizeFirmware(config.firmware);
    node.dialectSource = config.dialectSource === 'custom' ? 'custom' : 'bundled';
    node.dialect = config.dialect || 'ardupilotmega';

    const problems = [];

    const sysResult = parseTargetUint8(config.defaultTargetSystem, 'Default target system', 1);
    const cmpResult = parseTargetUint8(config.defaultTargetComponent, 'Default target component', 1);
    if (sysResult.error) problems.push(sysResult.error);
    if (cmpResult.error) problems.push(cmpResult.error);
    node.defaultTargetSystem = sysResult.value;
    node.defaultTargetComponent = cmpResult.value;

    /** @type {import('../lib/metadata').DialectBundle|null} */
    node._bundle = null;

    /**
     * Load the dialect. For bundled this is synchronous and always succeeds
     * when the editor validated the name. For custom without a bundle, marks
     * the node invalid.
     */
    try {
      node._bundle = resolveDialect({
        name: config.name,
        dialectSource: node.dialectSource,
        dialect: node.dialect,
        customDialectBundle: config.customDialectBundle || null,
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
      dialectSource: node.dialectSource,
      defaultTargetSystem: node.defaultTargetSystem,
      defaultTargetComponent: node.defaultTargetComponent,
    });
  }

  RED.nodes.registerType('mavlink-vehicle', MavlinkVehicleNode);
};

/* Expose lists for editor HTML and tests */
module.exports.FIRMWARE_TYPES = vehicleApi ? vehicleApi.FIRMWARE_TYPES : [];
module.exports.VEHICLE_FAMILIES = vehicleApi ? vehicleApi.VEHICLE_FAMILIES : [];
