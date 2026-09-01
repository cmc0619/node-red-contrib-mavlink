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
  PROFILE_ENTRY,
  profileEntry,
  compileXml,
} = require('../metadata');
const { XmlCatalog, compileXmlFromFile, entryFileForDialect } = require('../metadata/xml-catalog');

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
 * Parse the editor's `additionalDialects` field — a comma-joined list of
 * `dialect@revision` — into picks. The primary pick leads.
 *
 * @param {VehicleConfig} config
 * @returns {{dialect: string, revision: string}[]}
 */
function dialectPicks(config) {
  const picks = [
    {
      dialect: String(config.dialect).toLowerCase(),
      revision: config.dialectRevision,
    },
  ];
  for (const token of String(config.additionalDialects || '').split(',')) {
    const raw = token.trim();
    if (!raw) continue;
    const at = raw.lastIndexOf('@');
    picks.push({
      dialect: (at === -1 ? raw : raw.slice(0, at)).toLowerCase(),
      revision: at === -1 ? '' : raw.slice(at + 1),
    });
  }
  return picks;
}

/**
 * @typedef {object} VehicleConfig
 * @property {string}  [name]            node name for error messages
 * @property {string}  dialect           dialect key; required (no code default)
 * @property {string}  dialectRevision   `'seed'` or a catalog snapshot id; required
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
  const { catalog, entry } = catalogLookup(config, picks[0], config.name || 'unnamed');
  const xmlPath = catalog.filePath(entry, revision);
  if (!xmlPath) {
    // eslint-disable-next-line no-restricted-syntax -- §0 rule 1: the XML file is genuinely missing from the snapshot
    throw new Error(
      `Vehicle Profile '${config.name || 'unnamed'}': missing XML '${entry}' in snapshot '${revision}'.`
    );
  }
  return compileXmlFromFile(xmlPath);
}

/**
 * Resolve one dialect pick against the userDir XML catalog: refuse a missing
 * catalog base dir, find the pick's snapshot manifest, and locate the
 * dialect's entry file inside it. The one owner of the three refusals both
 * snapshot paths (single-dialect and multi-dialect profiles) share.
 *
 * @param {VehicleConfig} config
 * @param {{dialect: string, revision: string}} pick
 * @param {string} label  profile name for error messages
 * @returns {{catalog: XmlCatalog, snap: object, entry: string, names: string[]}}
 */
function catalogLookup(config, pick, label) {
  const baseDir = config.catalogBaseDir;
  if (!baseDir) {
    // eslint-disable-next-line no-restricted-syntax -- §0 rule 1: the catalog directory is genuinely absent
    throw new Error(
      `Vehicle Profile '${label}': catalog base dir required to load snapshot '${pick.revision}'.`
    );
  }
  const catalog = new XmlCatalog({ baseDir });
  const snap = catalog.list().find((m) => m.snapshotId === pick.revision);
  if (!snap) {
    // eslint-disable-next-line no-restricted-syntax -- §0 rule 1: the snapshot is genuinely not on disk
    throw new Error(
      `Vehicle Profile '${label}': dialect snapshot '${pick.revision}' not found. ` +
        'Update the catalog or pick Seed.'
    );
  }
  const names = (snap.files || []).map((f) => f.name);
  const entry = entryFileForDialect(names, pick.dialect);
  if (!entry) {
    // eslint-disable-next-line no-restricted-syntax -- §0 rule 1: the dialect is genuinely not in the snapshot
    throw new Error(
      `Vehicle Profile '${label}': dialect '${pick.dialect}' is not in snapshot '${pick.revision}'.`
    );
  }
  return { catalog, snap, entry, names };
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

  files[PROFILE_ENTRY] = profileEntry(entries);
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
  const { catalog, names, entry } = catalogLookup(config, pick, label);
  const files = {};
  for (const name of names) {
    const abs = catalog.filePath(name, pick.revision);
    if (abs) files[name] = fs.readFileSync(abs, 'utf8');
  }
  return { entry, files };
}

const { firmwareForAutopilot } = require('./firmware-autopilot');

module.exports = {
      FIRMWARE_LABEL,
  VEHICLE_FAMILY_LABEL,
  resolveDialect,
  knownDialects,
  firmwareForAutopilot,
};
