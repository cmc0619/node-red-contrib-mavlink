'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Load dialects from the shipped single-file MAVLink seed.
 *
 * Layout under `seed/`:
 *   active.json                         — pointer `{ file, stamp, commit, … }`
 *   mavlink-YYYY-MM-DD-<shortsha>.seed.gz — the gzipped blob
 *
 * Produced by `scripts/generate-seed.js`. Runtime resolves `active.json`,
 * gunzips once into memory — no tree of XML/JSON dialect files.
 */

const SEED_DIR = path.join(__dirname, '..', '..', 'seed');
const ACTIVE_FILE = path.join(SEED_DIR, 'active.json');

/** @type {{manifest: object, bundles: Object<string, object>, stamp: string, notice: string}|null} */
let packed = null;

/** @type {string|null} */
let resolvedSeedFile = null;

/** @type {Map<string, import('./index').DialectBundle>} */
const cache = new Map();

/** @type {string[]|null} */
let dialectNames = null;

/**
 * Resolve the dated seed blob path via `active.json`.
 *
 * @returns {string}
 */
function resolveSeedFile() {
  if (resolvedSeedFile) return resolvedSeedFile;
  if (!fs.existsSync(ACTIVE_FILE)) {
    throw new Error(
      `MAVLink dialect seed pointer missing at ${ACTIVE_FILE}. Run: node scripts/generate-seed.js`
    );
  }
  let active;
  try {
    active = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
  } catch (err) {
    throw new Error(
      `MAVLink dialect seed pointer at ${ACTIVE_FILE} is malformed: ${err.message}`,
      { cause: err },
    );
  }
  if (!active || typeof active.file !== 'string' || !active.file.endsWith('.seed.gz')) {
    throw new Error(`MAVLink dialect seed pointer at ${ACTIVE_FILE} has no seed file name.`);
  }
  // Basename only — never follow a path escape from active.json.
  const base = path.basename(active.file);
  const seedFile = path.join(SEED_DIR, base);
  if (!fs.existsSync(seedFile)) {
    throw new Error(
      `MAVLink dialect seed missing at ${seedFile} (active.json → ${base}). Run: node scripts/generate-seed.js`
    );
  }
  resolvedSeedFile = seedFile;
  return seedFile;
}

/**
 * Absolute path to the active dated seed blob.
 *
 * @returns {string}
 */
function seedRoot() {
  return resolveSeedFile();
}

/**
 * @returns {typeof packed}
 */
function loadPacked() {
  if (packed) return packed;
  const seedFile = resolveSeedFile();
  const raw = zlib.gunzipSync(fs.readFileSync(seedFile));
  const parsed = JSON.parse(raw.toString('utf8'));
  if (!parsed || !parsed.manifest || !parsed.bundles) {
    throw new Error(`MAVLink dialect seed at ${seedFile} is malformed.`);
  }
  packed = parsed;
  return packed;
}

/**
 * @returns {object}
 */
function readManifest() {
  return loadPacked().manifest;
}

/**
 * Seed stamp (`YYYY-MM-DD-<shortsha>`), or null when unavailable.
 *
 * @returns {?string}
 */
function seedStamp() {
  const p = loadPacked();
  return p.stamp || (p.manifest && p.manifest.stamp) || null;
}

/**
 * Selectable dialect names from the seed manifest (lowercase keys).
 *
 * @returns {string[]}
 */
function knownDialects() {
  if (!dialectNames) {
    const manifest = readManifest();
    dialectNames = (manifest.dialects || []).map((d) => d.name).sort();
  }
  return dialectNames.slice();
}

/**
 * Load a seeded dialect as a {@link DialectBundle}. Memoized. Unknown names
 * fail loud naming the available set — no silent fallback to `common`.
 *
 * @param {string} name  dialect key (e.g. `ardupilotmega`, `icarous`)
 * @returns {import('./index').DialectBundle}
 */
function loadBundled(name) {
  const key = String(name || '').toLowerCase();
  if (cache.has(key)) {
    return cache.get(key);
  }
  const bundle = loadPacked().bundles[key];
  if (!bundle) {
    throw new Error(
      `Unknown bundled dialect '${name}'. Available: ${knownDialects().join(', ')}.`
    );
  }
  cache.set(key, bundle);
  return bundle;
}

module.exports = {
  knownDialects,
  loadBundled,
  seedRoot,
  readManifest,
  seedStamp,
  resolveSeedFile,
  SEED_DIR,
  ACTIVE_FILE,
};
