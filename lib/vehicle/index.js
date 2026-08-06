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

const fs = require('fs');

const {
  knownDialects,
  loadBundled,
  loadBundledSet,
  seedSources,
  seedEntryFor,
  compileXml,
} = require('../metadata');
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
 * Valid vehicle family identifiers, and the fallback for anything else.
 *
 * `'unknown'` is the honest name: the field answers "which parameter document
 * describes this vehicle", and this is the case where nothing does. It gets
 * the union of every document's *names* and none of their bounds or
 * enumerations, because the documents disagree and there is no basis to pick
 * (`lib/param/seed.js` `unionSafe`, DESIGN.md §14). Custom stacks land here
 * too, which is why the editor labels it "Unknown / custom".
 *
 * One family per ArduPilot document. `blimp` is ArduPilot's `Blimp` — MAVLink
 * calls the vehicle `MAV_TYPE_AIRSHIP`, and the document name wins here
 * because the document is what this field selects.
 *
 * @type {string[]}
 */
const VEHICLE_FAMILIES = [
  'copter',
  'plane',
  'rover',
  'boat',
  'sub',
  'blimp',
  'antenna-tracker',
  'unknown',
];

/**
 * Display names for the two identifiers, as the Vehicle Profile dialog spells
 * them. They existed only as `<option>` text there, so anything else naming a
 * firmware or a family had to spell it again and could drift — which is how
 * "Unknown / custom" and "unknown" end up looking like different things.
 *
 * @type {Object<string,string>}
 */
const FIRMWARE_LABEL = {
  ardupilot: 'ArduPilot',
  px4: 'PX4',
  custom: 'Custom',
};

/** @type {Object<string,string>} */
const VEHICLE_FAMILY_LABEL = {
  copter: 'Copter',
  plane: 'Plane',
  rover: 'Rover',
  boat: 'Boat',
  sub: 'Sub',
  blimp: 'Blimp',
  'antenna-tracker': 'Antenna Tracker',
  unknown: 'Unknown / custom',
};

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
  return VEHICLE_FAMILIES.includes(family) ? family : 'unknown';
}

/** Synthetic entry for a profile that loads more than one dialect. */
const PROFILE_ENTRY = '_profile.xml';

/**
 * Parse the editor's `additionalDialects` field — a comma-joined list of
 * `dialect@revision` — into picks. The primary pick leads.
 *
 * @param {VehicleConfig} config
 * @returns {{dialect: string, revision: string}[]}
 */
function dialectPicks(config) {
  const picks = [
    {
      dialect: (config.dialect || 'ardupilotmega').toLowerCase(),
      // The editor writes 'seed' by default; absent means the same thing.
      revision: config.dialectRevision || 'seed',
    },
  ];
  for (const token of String(config.additionalDialects || '').split(',')) {
    const raw = token.trim();
    if (!raw) continue;
    const at = raw.lastIndexOf('@');
    picks.push({
      dialect: raw.slice(0, at).toLowerCase(),
      revision: raw.slice(at + 1),
    });
  }
  return picks;
}

/**
 * @typedef {object} VehicleConfig
 * @property {string}  [name]            node name for error messages
 * @property {string}  [dialect]         dialect key; default 'ardupilotmega'
 * @property {string}  [dialectRevision] `'seed'` or a catalog snapshot id
 * @property {string}  [additionalDialects]  comma-joined `dialect@revision`
 * @property {string}  [catalogBaseDir]  Node-RED userDir catalog root
 */

/**
 * Resolve the dialect bundle for a Vehicle Profile config.
 *
 * A profile is a library pick: `dialect` + `dialectRevision`. `seed` is the
 * shipped bundle; anything else is a dated snapshot id in the userDir XML
 * catalog, which is also how custom XML becomes selectable.
 *
 * A profile may load further dialects for the components on the vehicle. They
 * compile together through one synthetic entry, so the include chain resolves
 * as MAVLink defines it — shared files appear once, a later root wins — rather
 * than by any merge rule of ours. Each carries its own revision, so a newly
 * fitted component can sit on a newer snapshot than the airframe.
 *
 * @param {VehicleConfig} config
 * @returns {import('../metadata').DialectBundle}
 */
function resolveDialect(config) {
  const picks = dialectPicks(config);
  if (picks.length > 1) {
    return resolveDialectSet(config, picks);
  }
  const name = picks[0].dialect;
  const revision = picks[0].revision;

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

/**
 * Resolve a profile that loads several dialects.
 *
 * All-seed sets go through {@link loadBundledSet}, which caches them. A set
 * with any snapshot pick is assembled here: seed XML underneath, each
 * snapshot's files layered on in selection order, then one synthetic entry
 * including every root.
 *
 * @param {VehicleConfig} config
 * @param {{dialect: string, revision: string}[]} picks
 * @returns {import('../metadata').DialectBundle}
 */
function resolveDialectSet(config, picks) {
  if (picks.every((p) => p.revision === 'seed')) {
    return loadBundledSet(picks.map((p) => p.dialect));
  }

  const label = config.name || 'unnamed';
  const files = Object.assign({}, seedSources());
  const entries = [];
  for (const pick of picks) {
    if (pick.revision === 'seed') {
      entries.push(seedEntryFor(pick.dialect));
      continue;
    }
    const snapshot = snapshotFiles(config, pick, label);
    Object.assign(files, snapshot.files);
    entries.push(snapshot.entry);
  }

  const includes = entries.map((e) => `<include>${e}</include>`).join('');
  files[PROFILE_ENTRY] = `<?xml version="1.0"?><mavlink>${includes}</mavlink>`;
  return Object.assign({}, compileXml(files, PROFILE_ENTRY), {
    dialect: picks.map((p) => p.dialect).join('+'),
  });
}

/**
 * Read one catalog snapshot's XML for a dialect pick.
 *
 * @param {VehicleConfig} config
 * @param {{dialect: string, revision: string}} pick
 * @param {string} label
 * @returns {{entry: string, files: Object<string, string>}}
 */
function snapshotFiles(config, pick, label) {
  const baseDir = config.catalogBaseDir;
  if (!baseDir) {
    throw new Error(
      `Vehicle Profile '${label}': catalog base dir required to load snapshot '${pick.revision}'.`
    );
  }
  const catalog = new XmlCatalog({ baseDir });
  const snap = catalog.list().find((m) => m.snapshotId === pick.revision);
  if (!snap) {
    throw new Error(
      `Vehicle Profile '${label}': dialect snapshot '${pick.revision}' not found. ` +
        'Update the catalog or pick Seed.'
    );
  }
  const names = (snap.files || []).map((f) => f.name);
  const entry = entryFileForDialect(names, pick.dialect);
  if (!entry) {
    throw new Error(
      `Vehicle Profile '${label}': dialect '${pick.dialect}' is not in snapshot '${pick.revision}'.`
    );
  }
  const files = {};
  for (const name of names) {
    const abs = catalog.filePath(name, pick.revision);
    if (abs) files[name] = fs.readFileSync(abs, 'utf8');
  }
  return { entry, files };
}

const { autopilotForFirmware, firmwareForAutopilot } = require('./firmware-autopilot');

module.exports = {
  FIRMWARE_TYPES,
  VEHICLE_FAMILIES,
  FIRMWARE_LABEL,
  VEHICLE_FAMILY_LABEL,
  normalizeFirmware,
  normalizeFamily,
  resolveDialect,
  knownDialects,
  autopilotForFirmware,
  firmwareForAutopilot,
};
