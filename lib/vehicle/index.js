'use strict';

/**
 * Vehicle Profile logic (DESIGN.md §3, §7, §11, §12.3).
 *
 * A Vehicle Profile describes the vehicle being *addressed*: dialect, firmware,
 * target default ids, and vehicle family for mode tables and parameter metadata.
 * It owns nothing about who this Node-RED runtime is on the wire — that is the
 * Local Identity. Selecting a different Vehicle Profile can never change the
 * source sysid/compid stamped into outbound frames.
 *
 * One connection, one Vehicle Profile. Everything on a connection is decoded
 * against its profile — one dialect, one firmware, no per-packet lookup (§7).
 */

const { knownDialects, loadBundled, compileXmlFromFile } = require('../metadata');

/**
 * Valid firmware identifiers. `'custom'` disables firmware-specific behaviour
 * (mode tables, parameter encoding, mission type gating) — the dialect is used
 * as-is.
 *
 * @type {string[]}
 */
const FIRMWARE_TYPES = ['ardupilot', 'px4', 'custom'];

/**
 * Valid vehicle family identifiers. `'generic'` applies no vehicle-specific
 * metadata — useful for unknown or custom stacks.
 *
 * @type {string[]}
 */
const VEHICLE_FAMILIES = [
  'copter',
  'plane',
  'rover',
  'boat',
  'sub',
  'antenna-tracker',
  'generic',
];

/**
 * Normalise a firmware string to one of the known values.
 *
 * @param {string} firmware
 * @returns {string}
 */
function normalizeFirmware(firmware) {
  return FIRMWARE_TYPES.includes(firmware) ? firmware : 'custom';
}

/**
 * Normalise a vehicle family string to one of the known values.
 *
 * @param {string} family
 * @returns {string}
 */
function normalizeFamily(family) {
  return VEHICLE_FAMILIES.includes(family) ? family : 'generic';
}

/**
 * @typedef {object} VehicleConfig
 * @property {string}  [name]               node name for error messages
 * @property {'bundled'|'custom'} [dialectSource]  default 'bundled'
 * @property {string}  [dialect]            bundled dialect name; default 'ardupilotmega'
 * @property {string}  [customDialectPath]  path to a MAVLink XML file the
 *   Node-RED process can read; compiled at runtime for the custom source
 * @property {import('../metadata').DialectBundle} [customDialectBundle]
 *   pre-compiled bundle for custom source; takes precedence over the path when
 *   both are given (e.g. an API-created flow that supplies a compiled bundle)
 */

/**
 * Resolve the dialect bundle for a Vehicle Profile config.
 *
 * - `dialectSource === 'bundled'` (default): loads from the `mavlink-mappings`
 *   registry by name. Throws for unknown names (editor validation should catch
 *   this first).
 * - `dialectSource === 'custom'`: compiles the XML at `customDialectPath`,
 *   resolving its `<include>` graph from the file's own directory (a downloaded
 *   catalog snapshot is self-contained). A pre-compiled `customDialectBundle`,
 *   when supplied, is used verbatim. Throws when neither is available, and lets
 *   a bad/missing XML compile error propagate — a custom profile never silently
 *   falls back to a bundled dialect (DESIGN.md §4).
 *
 * @param {VehicleConfig} config
 * @returns {import('../metadata').DialectBundle}
 * @throws {Error} unknown bundled dialect name, custom without path/bundle, or
 *   a custom XML that cannot be read/compiled
 */
function resolveDialect(config) {
  const source = config.dialectSource || 'bundled';

  if (source === 'bundled') {
    const name = config.dialect || 'ardupilotmega';
    return loadBundled(name);
  }

  if (config.customDialectBundle) {
    return config.customDialectBundle;
  }

  const xmlPath = config.customDialectPath && String(config.customDialectPath).trim();
  if (xmlPath) {
    return compileXmlFromFile(xmlPath);
  }

  const label = config.name ? `'${config.name}'` : 'unnamed';
  throw new Error(
    `Vehicle Profile ${label}: custom dialect requires an XML path the Node-RED process can read; ` +
      'set the XML path (or pick a downloaded catalog file) first.'
  );
}

/**
 * Validate a MAVLink uint8 target field value, returning the resolved number
 * and an error string (null when valid).
 *
 * Target ids allow 0 (broadcast / all) — unlike source ids which disallow it.
 *
 * @param {*}      value
 * @param {string} field     readable field name for error messages
 * @param {number} fallback  value to return when blank
 * @returns {{value: number, error: string|null}}
 */
function parseTargetUint8(value, field, fallback) {
  if (value === undefined || value === null || value === '') {
    return { value: fallback, error: null };
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    return {
      value: fallback,
      error: `${field} must be an integer in [0, 255] (got ${JSON.stringify(value)})`,
    };
  }
  return { value: n, error: null };
}

module.exports = {
  FIRMWARE_TYPES,
  VEHICLE_FAMILIES,
  normalizeFirmware,
  normalizeFamily,
  resolveDialect,
  parseTargetUint8,
  knownDialects,
};
