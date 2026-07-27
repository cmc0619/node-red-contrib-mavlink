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
 */

const {
  FIRMWARE_TYPES,
  VEHICLE_FAMILIES,
  normalizeFirmware,
  normalizeFamily,
  resolveDialect,
  parseTargetUint8,
  knownDialects,
} = require('../lib/vehicle');

/** Admin endpoint path for dialect list. */
const DIALECTS_ROUTE = '/mavlink/dialects';

/** Whether the admin dialects route has been registered (once per process). */
let _dialectsRouteRegistered = false;

module.exports = function registerMavlinkVehicle(RED) {
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
module.exports.FIRMWARE_TYPES = FIRMWARE_TYPES;
module.exports.VEHICLE_FAMILIES = VEHICLE_FAMILIES;
