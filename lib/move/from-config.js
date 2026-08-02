'use strict';

/**
 * Read Move setpoint fields from a node config object (editor-saved shape).
 * Shared by mavlink-move and mavlink-swarm so both paint the same config keys.
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
 * Payload-first scalar: prefer `payload[key]`, else config, treating `''` as unset.
 *
 * @param {object} payload
 * @param {object} config
 * @param {string} key
 * @returns {*}
 */
function valueFrom(payload, config, key) {
  if (payload[key] !== undefined) return payload[key];
  return config[key] === '' ? undefined : config[key];
}

module.exports = { positionFrom, velocityFrom, valueFrom };
