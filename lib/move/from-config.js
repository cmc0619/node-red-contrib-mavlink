'use strict';

/**
 * Read Move setpoint fields from a node config object (editor-saved shape).
 * Shared by mavlink-move and mavlink-fanout so both paint the same config keys.
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
 * Acceleration/force vector (Move's Acceleration and Force modes share the
 * `af` fields; the force bit in the mask is what changes the meaning).
 *
 * @param {object} config
 * @returns {{north:*,east:*,up:*}}
 */
function accelFrom(config) {
  return { north: config.aNorth, east: config.aEast, up: config.aUp };
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

module.exports = { positionFrom, velocityFrom, accelFrom, valueFrom };
