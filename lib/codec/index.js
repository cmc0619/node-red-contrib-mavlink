'use strict';

/**
 * Wire-value helpers shared by the send path (DESIGN.md §5, §11): the MAVLink
 * scalar type table and the PX4 parameter int/float union. Imports nothing
 * above itself — no `node-mavlink`, no `lib/metadata`, nothing Node-RED.
 *
 * Public surface:
 *   - {@link paramValueToWire}/{@link paramValueFromWire} — PX4 int/float union
 *   - {@link PARAM_TYPES} — the MAV_PARAM_TYPE subset that fits the float slot
 */

const { paramValueToWire, paramValueFromWire, PARAM_TYPES } = require('./param-union');

module.exports = {
  paramValueToWire,
  paramValueFromWire,
  PARAM_TYPES,
};
