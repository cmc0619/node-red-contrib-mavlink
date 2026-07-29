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
 *
 * Dialects are chosen as (name, revision): the shipped seed or a dated catalog
 * snapshot. There is no separate "custom path" mode in the editor — once XML is
 * in the library it is a pulldown entry.
 */

const { knownDialects, loadBundled } = require('../metadata');
const { XmlCatalog, compileXmlFromFile, entryFileForDialect } = require('../metadata/xml-catalog');

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
 * @property {string}  [dialect]            dialect key; default 'ardupilotmega'
 * @property {string}  [dialectRevision]    `'seed'` or a catalog snapshot id
 * @property {string}  [catalogBaseDir]     Node-RED userDir catalog root
 * @property {'bundled'|'custom'} [dialectSource]  legacy; mapped to revision
 * @property {string}  [customDialectPath]  legacy absolute XML path
 * @property {import('../metadata').DialectBundle} [customDialectBundle]
 *   pre-compiled bundle (tests / API); wins over everything else
 */

/**
 * Resolve the dialect bundle for a Vehicle Profile config.
 *
 * Preferred: `dialect` + `dialectRevision` (`seed` or snapshot id).
 * Legacy: `dialectSource === 'custom'` + `customDialectPath` still compiles.
 *
 * @param {VehicleConfig} config
 * @returns {import('../metadata').DialectBundle}
 */
function resolveDialect(config) {
  if (config.customDialectBundle) {
    return config.customDialectBundle;
  }

  const name = (config.dialect || 'ardupilotmega').toLowerCase();
  let revision = config.dialectRevision;
  if (revision === undefined || revision === null || revision === '') {
    // Legacy flows: custom path with no revision → path; else seed.
    if (config.dialectSource === 'custom') {
      revision = 'legacy-path';
    } else {
      revision = 'seed';
    }
  }

  if (revision === 'seed' || revision === 'bundled') {
    return loadBundled(name);
  }

  if (revision === 'legacy-path') {
    const xmlPath = config.customDialectPath && String(config.customDialectPath).trim();
    if (xmlPath) {
      return compileXmlFromFile(xmlPath);
    }
    const label = config.name ? `'${config.name}'` : 'unnamed';
    throw new Error(
      `Vehicle Profile ${label}: dialect revision is missing; pick a dialect and date in the editor.`
    );
  }

  // Dated catalog snapshot.
  const baseDir = config.catalogBaseDir;
  if (!baseDir) {
    throw new Error(
      `Vehicle Profile '${config.name || 'unnamed'}': catalog base dir required to load snapshot '${revision}'.`
    );
  }
  const catalog = new XmlCatalog({ baseDir });
  const manifests = catalog.list();
  const snap = manifests.find((m) => m.snapshotId === revision);
  if (!snap) {
    throw new Error(
      `Vehicle Profile '${config.name || 'unnamed'}': dialect snapshot '${revision}' not found. ` +
        'Update the catalog or pick Seed.'
    );
  }
  const fileNames = (snap.files || []).map((f) => f.name);
  const entry = entryFileForDialect(fileNames, name);
  if (!entry) {
    throw new Error(
      `Vehicle Profile '${config.name || 'unnamed'}': dialect '${name}' is not in snapshot '${revision}'.`
    );
  }
  const xmlPath = catalog.filePath(entry, revision);
  if (!xmlPath) {
    throw new Error(
      `Vehicle Profile '${config.name || 'unnamed'}': missing XML '${entry}' in snapshot '${revision}'.`
    );
  }
  return compileXmlFromFile(xmlPath);
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
