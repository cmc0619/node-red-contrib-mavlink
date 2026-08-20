'use strict';

const { isBlank } = require('../addressing/resolve');

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
 * Payload-first scalar: prefer a non-blank `payload[key]`, else config.
 * Blank/whitespace on either side is unset — `Number(' ')` is finite 0 (§14.70).
 *
 * @param {object} payload
 * @param {object} config
 * @param {string} key
 * @returns {*}
 */
function valueFrom(payload, config, key) {
  if (!isBlank(payload[key])) return payload[key];
  return isBlank(config[key]) ? undefined : config[key];
}

module.exports = { positionFrom, velocityFrom, accelFrom, valueFrom };
