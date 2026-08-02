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
 * snapshot. XML in the library is a pulldown entry like any other.
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
 * @property {string}  [name]            node name for error messages
 * @property {string}  [dialect]         dialect key; default 'ardupilotmega'
 * @property {string}  [dialectRevision] `'seed'` or a catalog snapshot id
 * @property {string}  [catalogBaseDir]  Node-RED userDir catalog root
 */

/**
 * Resolve the dialect bundle for a Vehicle Profile config.
 *
 * A profile is a library pick: `dialect` + `dialectRevision`. `seed` is the
 * shipped bundle; anything else is a dated snapshot id in the userDir XML
 * catalog, which is also how custom XML becomes selectable.
 *
 * @param {VehicleConfig} config
 * @returns {import('../metadata').DialectBundle}
 */
function resolveDialect(config) {
  const name = (config.dialect || 'ardupilotmega').toLowerCase();
  // The editor writes 'seed' by default; absent means the same thing.
  const revision = config.dialectRevision || 'seed';

  if (revision === 'seed') {
    return loadBundled(name);
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

const { autopilotForFirmware, firmwareForAutopilot } = require('./firmware-autopilot');

module.exports = {
  FIRMWARE_TYPES,
  VEHICLE_FAMILIES,
  normalizeFirmware,
  normalizeFamily,
  resolveDialect,
  knownDialects,
  autopilotForFirmware,
  firmwareForAutopilot,
};
