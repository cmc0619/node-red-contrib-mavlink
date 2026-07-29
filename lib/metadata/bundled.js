'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Load dialects from the shipped single-file MAVLink seed (`seed/mavlink.seed.gz`).
 *
 * The blob is produced by `scripts/generate-seed.js`: pinned upstream commit,
 * real `<include>` walks, every selectable DialectBundle, NOTICE, and a stamp
 * (`YYYY-MM-DD-<shortsha>`). Runtime gunzips once into memory — no tree of
 * XML/JSON files. Catalog updates overlay newer XML under the Node-RED userDir.
 */

const SEED_FILE = path.join(__dirname, '..', '..', 'seed', 'mavlink.seed.gz');

/** @type {{manifest: object, bundles: Object<string, object>, stamp: string, notice: string}|null} */
let packed = null;

/** @type {Map<string, import('./index').DialectBundle>} */
const cache = new Map();

/** @type {string[]|null} */
let dialectNames = null;

/**
 * Absolute path to the shipped seed blob.
 *
 * @returns {string}
 */
function seedRoot() {
  return SEED_FILE;
}

/**
 * @returns {typeof packed}
 */
function loadPacked() {
  if (packed) return packed;
  if (!fs.existsSync(SEED_FILE)) {
    throw new Error(
      `MAVLink dialect seed missing at ${SEED_FILE}. Run: node scripts/generate-seed.js`
    );
  }
  const raw = zlib.gunzipSync(fs.readFileSync(SEED_FILE));
  const parsed = JSON.parse(raw.toString('utf8'));
  if (!parsed || !parsed.manifest || !parsed.bundles) {
    throw new Error(`MAVLink dialect seed at ${SEED_FILE} is malformed.`);
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
  SEED_FILE,
};
