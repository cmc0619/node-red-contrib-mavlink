'use strict';

/**
 * Read Move setpoint fields from a node config object (editor-saved shape).
 */

/**
 * @param {object} config
 * @returns {{north:*,east:*,up:*,lat:*,lon:*,alt:*}}
 */
function positionFrom(config) {
  return {
    north: config.north,
    east: config.east,
    up: config.up,
    lat: config.lat,
    lon: config.lon,
    alt: config.alt,
  };
}

/**
 * @param {object} config
 * @returns {{north:*,east:*,up:*}}
 */
function velocityFrom(config) {
  return { north: config.vNorth, east: config.vEast, up: config.vUp };
}

/**
 * Acceleration vector (the `af` fields).
 *
 * @param {object} config
 * @returns {{north:*,east:*,up:*}}
 */
function accelFrom(config) {
  return { north: config.aNorth, east: config.aEast, up: config.aUp };
}

/**
 * Payload-first scalar. Only absence selects the configured value; an explicit
 * payload value rides unchanged.
 *
 * @param {object} payload
 * @param {object} config
 * @param {string} key
 * @returns {*}
 */
function valueFrom(payload, config, key) {
  return payload[key] === undefined ? config[key] : payload[key];
}

module.exports = { positionFrom, velocityFrom, accelFrom, valueFrom };
