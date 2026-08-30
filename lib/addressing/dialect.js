'use strict';

/**
 * Resolve a compiled dialect bundle from a Vehicle Profile node id or a
 * Connection's bound profile snapshot (DESIGN.md §7).
 *
 * The connection's public vehicle snapshot deliberately carries no bundle —
 * only the profile node id. Call getDialect() on that node; never loadBundled
 * by name (breaks custom XML profiles).
 */

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

module.exports = { dialectFromVehicleId, dialectFromConnection };
