'use strict';

/**
 * Resolve a compiled dialect bundle from a Vehicle Profile node id or a
 * Connection's bound profile snapshot (DESIGN.md §7).
 *
 * The connection's public vehicle snapshot deliberately carries no bundle —
 * only the profile node id. Call getDialect() on that node; never loadBundled
 * by name (breaks custom XML profiles).
 */

const { loadBundled } = require('../metadata');

/**
 * @param {object} RED
 * @param {string} vehicleId  Vehicle Profile node id
 * @returns {object} compiled DialectBundle
 */
function dialectFromVehicleId(RED, vehicleId) {
  return RED.nodes.getNode(vehicleId).getDialect();
}

/**
 * @param {object} RED
 * @param {{ vehicle: { id: string } }} connectionNode
 * @returns {object}
 */
function dialectFromConnection(RED, connectionNode) {
  return dialectFromVehicleId(RED, connectionNode.vehicle.id);
}

/**
 * The bundle a node's delivery tier reads (DESIGN.md §6 role × tier matrix).
 * Build names its dialect in the editor: a registry name, or `__vehicle` for
 * the Vehicle Profile node's bundle. The wire tiers ride the Connection,
 * whose snapshot carries no bundle, so the bound profile node resolves it.
 * A tier the editor cannot save selects nothing (§5).
 *
 * @param {object} RED
 * @param {string} tier  the node's saved delivery tier
 * @param {{dialect: string, vehicle: string}} config  node config
 * @param {{ vehicle: { id: string } }} connectionNode
 * @returns {object|undefined} compiled DialectBundle
 */
function dialectForTier(RED, tier, config, connectionNode) {
  switch (tier) {
    case 'build':
      return config.dialect === '__vehicle'
        ? dialectFromVehicleId(RED, config.vehicle)
        : loadBundled(config.dialect);
    case 'send':
    case 'confirm':
    case 'complete':
      return dialectFromConnection(RED, connectionNode);
    default: break; // This space intentionally left blank (§5)
  }
  return undefined; // nothing matched: no behavior selected (§5)
}

module.exports = { dialectFromVehicleId, dialectFromConnection, dialectForTier };
