'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { compileXml } = require('./compile');

/**
 * Load dialects from the shipped single-file MAVLink seed.
 *
 * Layout under `seed/`:
 *   active.json                         — pointer `{ file, stamp, commit, … }`
 *   mavlink-YYYY-MM-DD-<shortsha>.seed.gz — the gzipped blob
 *
 * Produced by `scripts/generate-seed.js`. The blob carries the upstream XML,
 * not precompiled bundles: XML is ~10x smaller (every dialect would otherwise
 * embed its own copy of common.xml) and compiling one dialect costs less than
 * parsing all of them. Runtime resolves `active.json`, gunzips once, and
 * compiles the dialects a profile actually asks for.
 *
 * Two caches sit in front of the compiler. The in-process {@link cache} returns
 * the identical bundle object every time — a keystroke must never recompile a
 * dialect (DESIGN.md §6). The on-disk cache survives restarts and is keyed by
 * what was selected, never by content: it does not invalidate itself, so a new
 * seed does not silently change a deployed profile. Rebuilding is explicit.
 */

/** Synthetic entry name for a profile that loads more than one dialect. */
const PROFILE_ENTRY = '_profile.xml';

/**
 * The synthetic {@link PROFILE_ENTRY} XML for a multi-dialect profile: one
 * `<include>` per root, so the include chain resolves exactly as MAVLink
 * defines it — shared files appear once, a later root overrides an earlier
 * one. One owner for the assembly (used here and by lib/vehicle's
 * snapshot-mixing profiles); there is no merge step and no precedence rule of
 * our own.
 *
 * @param {string[]} entries  root entry file names, in selection order
 * @returns {string} the synthetic entry file's XML text
 */
function profileEntry(entries) {
  const includes = entries.map((entry) => `<include>${entry}</include>`).join('');
  return `<?xml version="1.0"?><mavlink>${includes}</mavlink>`;
}

const SEED_DIR = path.join(__dirname, '..', '..', 'seed');
const ACTIVE_FILE = path.join(SEED_DIR, 'active.json');

/** @type {{manifest: object, sources: Object<string, string>, stamp: string, notice: string}|null} */
let packed = null;

/** @type {Map<string, import('./compile').DialectBundle>} */
const cache = new Map();

/** @type {?string} on-disk compiled-bundle cache dir; null = memo only */
let compiledCacheDir = null;

/**
 * Resolve the dated seed blob path via `active.json`.
 *
 * @returns {string}
 */
function resolveSeedFile() {
  const active = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
  return path.join(SEED_DIR, active.file);
}

/**
 * @returns {typeof packed}
 */
function loadPacked() {
  if (packed) return packed;
  const seedFile = resolveSeedFile();
  const raw = zlib.gunzipSync(fs.readFileSync(seedFile));
  packed = JSON.parse(raw.toString('utf8'));
  return packed;
}

/**
 * @returns {object}
 */
function readManifest() {
  return loadPacked().manifest;
}

/**
 * Seed stamp (`YYYY-MM-DD-<shortsha>`).
 *
 * @returns {string}
 */
function seedStamp() {
  return loadPacked().stamp;
}

/**
 * Selectable dialect names from the seed manifest (lowercase keys).
 *
 * @returns {string[]}
 */
function knownDialects() {
  return readManifest().dialects.map((d) => d.name).sort();
}

/**
 * The seed's XML sources, keyed by file name. Callers that need to compile a
 * root against files from elsewhere (a catalog snapshot) build their own map
 * on top of this one.
 *
 * @returns {Object<string, string>}
 */
function seedSources() {
  return loadPacked().sources;
}

/**
 * Entry file for a seeded dialect, e.g. `uAvionix.xml` for `uavionix`.
 *
 * @param {string} name
 * @returns {string}
 */
function seedEntryFor(name) {
  return readManifest().dialects.find((d) => d.name === name).entry;
}

/**
 * Point the on-disk compiled cache at a directory (`<userDir>/mavlink/compiled`).
 * `lib/metadata` never sees `RED`, so the node that knows the Node-RED user dir
 * sets it once at registration. Unset means memo-only.
 *
 * @param {?string} dir
 * @returns {void}
 */
function setCompiledCacheDir(dir) {
  compiledCacheDir = dir;
}

/**
 * Read a previously compiled bundle for `key`, or null when there is none.
 * A cache entry is never invalidated by a newer seed; it is replaced only
 * when the operator rebuilds.
 *
 * @param {string} key
 * @returns {?import('./compile').DialectBundle}
 */
function readCompiledCache(key) {
  if (!compiledCacheDir) return null;
  const file = path.join(compiledCacheDir, `${key}@seed.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {string} key
 * @param {import('./compile').DialectBundle} bundle
 * @returns {void}
 */
function writeCompiledCache(key, bundle) {
  if (!compiledCacheDir) return;
  fs.mkdirSync(compiledCacheDir, { recursive: true });
  fs.writeFileSync(path.join(compiledCacheDir, `${key}@seed.json`), JSON.stringify(bundle));
}

/**
 * Drop every compiled dialect, in memory and on disk — including the memoized
 * seed blob — so the next load re-reads and recompiles from the current seed.
 * The only way a cache entry is replaced — nothing invalidates itself.
 *
 * @returns {number} entries removed from disk
 */
function clearCompiledCache() {
  cache.clear();
  packed = null;
  if (!compiledCacheDir || !fs.existsSync(compiledCacheDir)) return 0;
  const stale = fs.readdirSync(compiledCacheDir).filter((f) => f.endsWith('.json'));
  for (const f of stale) fs.unlinkSync(path.join(compiledCacheDir, f));
  return stale.length;
}

/**
 * Compile a seeded dialect into a {@link DialectBundle}. Memoized in process,
 * then cached on disk. An unknown name craters at the manifest lookup — no
 * silent fallback to `common`.
 *
 * @param {string} name  dialect key (e.g. `ardupilotmega`, `icarous`)
 * @returns {import('./compile').DialectBundle}
 */
function loadBundled(name) {
  return loadBundledSet([name]);
}

/**
 * Compile one or more seeded dialects into a single {@link DialectBundle}.
 *
 * Several roots are compiled together through a synthetic entry that includes
 * each in turn, so the include chain resolves exactly as MAVLink defines it:
 * shared files appear once, and a later root overrides an earlier one. There is
 * no merge step and no precedence rule of our own.
 *
 * @param {string[]} names  dialect keys; the first is the profile's primary
 * @returns {import('./compile').DialectBundle}
 */
function loadBundledSet(names) {
  // The key is spelled by the manifest, not the caller: a name the seed does
  // not carry craters here, before it can shape a cache path.
  const manifest = readManifest();
  const rows = names.map((n) => manifest.dialects.find((d) => d.name === n.toLowerCase()));
  const key = rows.map((r) => r.name).join('+');
  if (cache.has(key)) return cache.get(key);

  let bundle = readCompiledCache(key);
  if (!bundle) {
    const sources = loadPacked().sources;
    let entry = rows[0].entry;
    let files = sources;
    if (rows.length > 1) {
      entry = PROFILE_ENTRY;
      files = { ...sources, [PROFILE_ENTRY]: profileEntry(rows.map((r) => r.entry)),};
    }
    // compileXml names the bundle after the entry file (`uAvionix`, or the
    // synthetic one); the seed's key is ours.
    bundle = { ...compileXml(files, entry), dialect: keys.join('+') };
    writeCompiledCache(key, bundle);
  }
  cache.set(key, bundle);
  return bundle;
}

module.exports = {
  knownDialects,
  loadBundled,
  loadBundledSet,
  seedSources,
  seedEntryFor,
  PROFILE_ENTRY,
  profileEntry,
  readManifest,
  seedStamp,
    setCompiledCacheDir,
  clearCompiledCache,
};
