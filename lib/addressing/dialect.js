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
 * @param {string|null|undefined} vehicleId  Vehicle Profile node id
 * @param {{ rethrow?: boolean }} [opts]  when true, getDialect failures propagate
 * @returns {object|null} compiled DialectBundle, or null when the node is absent
 */
function dialectFromVehicleId(RED, vehicleId, opts = {}) {
  if (!vehicleId) return null;
  const profileNode = RED.nodes.getNode(vehicleId);
  if (!profileNode) return null;
  try {
    return profileNode.getDialect();
  } catch (err) {
    if (opts.rethrow) throw err;
    return null;
  }
}

/**
 * @param {object} RED
 * @param {{ vehicle?: { id?: string } }|null|undefined} connectionNode
 * @param {{ rethrow?: boolean }} [opts]
 * @returns {object|null}
 */
function dialectFromConnection(RED, connectionNode, opts = {}) {
  const id = connectionNode && connectionNode.vehicle && connectionNode.vehicle.id;
  return dialectFromVehicleId(RED, id, opts);
}

module.exports = { dialectFromVehicleId, dialectFromConnection };
