'use strict';

const crypto = require('crypto');
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

/** @type {string|null} */
let resolvedSeedFile = null;

/** @type {Map<string, import('./index').DialectBundle>} */
const cache = new Map();

/** @type {string[]|null} */
let dialectNames = null;

/** @type {?string} on-disk compiled-bundle cache dir; null = memo only */
let compiledCacheDir = null;

/**
 * Compiler stamp: a short hash of the compiler's own source, part of every
 * cache entry's file name. An entry written by a different compiler is a
 * different name, so it is never read again and the dialect recompiles — the
 * bundle's shape moves with the compiler (the enum `byName` index arrived
 * that way, and the entries built without it crashed the Connection node on
 * its first read). Seed changes still invalidate nothing; the operator
 * rebuilds, and the rebuild also sweeps the orphaned names.
 */
const COMPILER_STAMP = crypto.createHash('sha1')
  .update(fs.readFileSync(path.join(__dirname, 'compile.js')))
  .digest('hex')
  .slice(0, 8);

/**
 * @param {string} key
 * @returns {string} the cache entry's path for this compiler
 */
function compiledCacheFile(key) {
  return path.join(compiledCacheDir, `${key}@seed-${COMPILER_STAMP}.json`);
}

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
  const seedFile = path.join(SEED_DIR, active.file);
  if (!fs.existsSync(seedFile)) {
    throw new Error(
      `MAVLink dialect seed missing at ${seedFile} (active.json → ${active.file}). Run: node scripts/generate-seed.js`
    );
  }
  resolvedSeedFile = seedFile;
  return seedFile;
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
  if (!dialectNames) {
    const manifest = readManifest();
    dialectNames = manifest.dialects.map((d) => d.name).sort();
  }
  return dialectNames.slice();
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
 * A cache entry is never invalidated by a newer seed — it records the stamp it
 * was built from so the editor can show drift, and is replaced only when the
 * operator rebuilds.
 *
 * @param {string} key
 * @returns {?import('./index').DialectBundle}
 */
function readCompiledCache(key) {
  if (!compiledCacheDir) return null;
  const file = compiledCacheFile(key);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).bundle;
  } catch {
    // A cache is never load-bearing. The write is a plain sync write on a
    // companion computer that can lose power mid-file, and a truncated entry
    // must read as a miss — not as a deploy that fails on every restart until
    // someone finds this file by hand. Drop it so the recompile rewrites it.
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return null;
  }
}

/**
 * @param {string} key
 * @param {import('./index').DialectBundle} bundle
 * @returns {void}
 */
function writeCompiledCache(key, bundle) {
  if (!compiledCacheDir) return;
  fs.mkdirSync(compiledCacheDir, { recursive: true });
  const file = compiledCacheFile(key);
  // Which XML this was compiled from: `stamp` is fetch-date + short commit,
  // `commitDate` is when that commit actually landed upstream. Recorded, never
  // acted on — comparing them to the live seed is what shows an operator the
  // entry is built from older definitions.
  const manifest = readManifest();
  fs.writeFileSync(
    file,
    JSON.stringify({ stamp: seedStamp(), commit: manifest.commit, commitDate: manifest.commitDate, bundle })
  );
}

/**
 * Drop every compiled dialect, in memory and on disk — including the memoized
 * seed blob, resolved seed path, and dialect list — so the next load re-reads
 * and recompiles from the current seed. The only way a cache entry is
 * replaced — nothing invalidates itself.
 *
 * @returns {number} entries removed from disk
 */
function clearCompiledCache() {
  cache.clear();
  packed = null;
  resolvedSeedFile = null;
  dialectNames = null;
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
 * @returns {import('./index').DialectBundle}
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
 * @returns {import('./index').DialectBundle}
 */
function loadBundledSet(names) {
  const keys = names.map((n) => n.toLowerCase());
  const key = keys.join('+');
  if (cache.has(key)) {
    return cache.get(key);
  }
  const manifest = readManifest();
  const rows = keys.map((k) => manifest.dialects.find((d) => d.name === k));

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
