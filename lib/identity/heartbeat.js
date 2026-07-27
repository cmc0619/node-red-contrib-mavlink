'use strict';

/**
 * Local Identity heartbeat content (DESIGN.md §7 Heartbeat).
 *
 * Local Identity owns the *content* — type, autopilot field, system status,
 * source IDs. Connection owns the *emission* — one scheduler per bound identity
 * per link. This module provides the pure data, nothing else.
 *
 * Both roles use MAV_AUTOPILOT_INVALID: the autopilot field is only meaningful
 * for flight controllers, not for GCS or companion computers (§7).
 *
 * HEARTBEAT.mavlink_version must be 3: node-mavlink leaves it 0, which then
 * gets truncated and makes heartbeats advertise version 0. The current common
 * message set is version 3 regardless of v1/v2 framing.
 */

/**
 * @typedef {object} HeartbeatFields
 * @property {string} type         MAV_TYPE_* screaming name
 * @property {string} autopilot    MAV_AUTOPILOT_* screaming name
 * @property {number} base_mode   bitmask; 0 for a non-flight-controller
 * @property {number} custom_mode  firmware-specific; 0 when unused
 * @property {string} system_status MAV_STATE_* screaming name
 * @property {number} mavlink_version  always 3
 */

/**
 * Build the HEARTBEAT field object for a Local Identity.
 *
 * @param {{heartbeatType: string, heartbeatAutopilot: string}} identity
 * @returns {HeartbeatFields}
 */
function heartbeatFields(identity) {
  return {
    type: identity.heartbeatType,
    autopilot: identity.heartbeatAutopilot,
    base_mode: 0,
    custom_mode: 0,
    system_status: 'MAV_STATE_ACTIVE',
    mavlink_version: 3,
  };
}

module.exports = { heartbeatFields };
