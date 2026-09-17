'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('node:crypto');
const { readManifest } = require('./bundled');
const { compileXml, parseFile } = require('./compile');

/**
 * Downloadable MAVLink XML dialect catalog (DESIGN.md §4).
 *
 * Organizes official MAVLink XML snapshots under the Node-RED userDir so a user
 * can refresh past the shipped seed (`seed/mavlink`) when internet is available.
 * Downloaded XML is the same shape the seed uses — pin a commit, follow
 * `<include>`, timestamp. Compiling a downloaded file yields the same
 * {@link DialectBundle} as a seed load. A download that matches, file for
 * file, what is already newest on disk (or the shipped seed when nothing is)
 * is not kept: a snapshot exists to carry a difference.
 *
 * Layout under the base dir (typically `<userDir>/mavlink/xml`):
 *
 *   manifests/<snapshotId>.json   provenance + file list + per-file hash
 *   snapshots/<snapshotId>/*.xml  the downloaded XML set (includes together)
 *
 * Downloads go through an injectable fetcher (mirroring `fetch.js`) so the logic
 * is fully testable offline; the default fetcher uses global `fetch` against
 * raw.githubusercontent. Includes are followed at *download* time (so a snapshot
 * is self-contained); the runtime compiler never fetches remote includes.
 *
 * Errors are plain `Error`s carrying a `.code` string (this package has no
 * MavlinkError class) so callers can branch on the code (e.g. 404 vs 500).
 *
 * The source is the official repo at its default branch: the editor's Update
 * button is the only caller and it names nothing else (§3).
 */

// Official MAVLink message definitions live here in the source repo.
const DEFINITIONS_DIR = 'message_definitions/v1.0';

const REPO = 'mavlink/mavlink';
const REF = 'master';

/**
 * Build a plain Error with a machine-readable `.code` and optional extra
 * properties — this package's error style (no MavlinkError class).
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Default network fetcher for one definitions file. Uses global fetch (Node
 * 18+), so no new dependency. Rejects non-2xx loudly.
 *
 * @param {string} repo  e.g. "mavlink/mavlink"
 * @param {string} ref   branch/tag/sha
 * @param {string} file  file name within the definitions dir, e.g. "common.xml"
 * @returns {Promise<string>} the file text
 */
async function defaultFetchFile(repo, ref, file) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${DEFINITIONS_DIR}/${file}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw codedError(
      'XML_CATALOG_FETCH_FAILED',
      `Failed to download ${file} (${res.status} ${res.statusText}).`
    );
  }
  return res.text();
}

/**
 * One GitHub REST call, decoded. Rejects non-2xx loudly with the given code:
 * every downloaded file must come from one immutable commit, so a ref that
 * cannot be pinned or a definitions dir that cannot be listed ends the update
 * rather than degrading to a partial set.
 *
 * @param {string} url
 * @param {string} code  `.code` for the thrown Error on a non-2xx answer
 * @returns {Promise<*>} the JSON body
 */
async function githubJson(url, code) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) {
    throw codedError(code, `GitHub answered ${res.status} ${res.statusText} for ${url}.`);
  }
  return res.json();
}

/**
 * Resolve a ref to its commit via the GitHub commits API, recording when that
 * commit landed upstream — the XML's own version date, distinct from any
 * fetched-at stamp. One owner of the commits-API call (the catalog's resolver
 * below and the seed generator both ride it).
 *
 * @param {string} repo
 * @param {string} ref
 * @returns {Promise<{commit: string, commitDate: string}>}
 */
async function fetchCommitInfo(repo, ref) {
  const body = await githubJson(
    `https://api.github.com/repos/${repo}/commits/${ref}`,
    'XML_CATALOG_COMMIT_UNRESOLVED'
  );
  return { commit: body.sha, commitDate: body.commit.committer.date };
}

/**
 * @param {string} repo
 * @param {string} ref
 * @returns {Promise<string>} the commit sha
 */
async function defaultResolveCommit(repo, ref) {
  return (await fetchCommitInfo(repo, ref)).commit;
}

/**
 * Discover every XML file in the official definitions dir at a commit, via the
 * GitHub contents API.
 *
 * @param {string} repo
 * @param {string} commit  resolved commit sha
 * @returns {Promise<string[]>}
 */
async function defaultListFiles(repo, commit) {
  const entries = await githubJson(
    `https://api.github.com/repos/${repo}/contents/${DEFINITIONS_DIR}?ref=${commit}`,
    'XML_CATALOG_LIST_FAILED'
  );
  return entries
    .filter((e) => e.type === 'file' && /\.xml$/i.test(e.name))
    .map((e) => e.name);
}

class XmlCatalog {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir  cache root (e.g. `<userDir>/mavlink/xml`)
   * @param {function} [opts.fetchFile]      (repo, ref, file) -> Promise<string>
   * @param {function} [opts.resolveCommit]  (repo, ref) -> Promise<string>
   * @param {function} [opts.listFiles]      (repo, commit) -> Promise<string[]>
   * @param {function} [opts.now]            clock override (tests)
   */
  constructor(opts = {}) {
    this.baseDir = opts.baseDir;
    this.fetchFile = opts.fetchFile || defaultFetchFile;
    this.resolveCommit = opts.resolveCommit || defaultResolveCommit;
    this.listFiles = opts.listFiles || defaultListFiles;
    this.now = opts.now || Date.now;
  }

  /** @returns {string} */
  manifestsDir() {
    return path.join(this.baseDir, 'manifests');
  }

  /** @returns {string} */
  snapshotsDir() {
    return path.join(this.baseDir, 'snapshots');
  }

  /**
   * Download the upstream XML set into a new snapshot, following `<include>`
   * dependencies so the snapshot is self-contained, and record provenance in
   * a manifest. The ref is pinned to an immutable commit first and every file
   * is fetched from that commit, never the mutable ref. Any file that fails
   * to download ends the update: a snapshot is the whole definitions dir at
   * one commit or it is nothing.
   *
   * @returns {Promise<?object>} the written manifest, or null when the
   *   download matched the newest snapshot (or the seed) file for file and
   *   nothing was kept
   */
  async update() {
    const commit = await this.resolveCommit(REPO, REF);
    const fetched = new Map(); // file -> text
    const queue = [...await this.listFiles(REPO, commit)];
    while (queue.length) {
      const file = queue.shift();
      if (fetched.has(file)) continue;
      const text = await this.fetchFile(REPO, commit, file);
      fetched.set(file, text);
      queue.push(...parseFile(file, text).includes);
    }
    const files = [...fetched]
      .map(([name, text]) => ({ name, sha256: sha256(text) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Same names, same hashes as what is already newest: nothing to keep.
    const newest = this.list()[0] || readManifest();
    if (fileList(newest.files) === fileList(files)) return null;

    const downloadedAt = this.now();
    const snapshotId = makeSnapshotId(commit, downloadedAt);
    const snapDir = path.join(this.snapshotsDir(), snapshotId);
    fs.mkdirSync(snapDir, { recursive: true });
    for (const [name, text] of fetched) fs.writeFileSync(path.join(snapDir, name), text);

    const manifest = { snapshotId, repo: REPO, ref: REF, commit, downloadedAt, files };
    fs.mkdirSync(this.manifestsDir(), { recursive: true });
    fs.writeFileSync(path.join(this.manifestsDir(), `${snapshotId}.json`), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  /**
   * List downloaded snapshots (newest first).
   *
   * @returns {object[]} manifests
   */
  list() {
    const dir = this.manifestsDir();
    if (!fs.existsSync(dir)) return []; // nothing downloaded yet
    return fs.readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
      .sort((a, b) => b.downloadedAt - a.downloadedAt);
  }

  /**
   * Absolute path of a file inside a snapshot. Snapshot ids come from this
   * catalog's own manifests (the editor's Version pulldown, a saved profile),
   * so the path is joined, not checked; a file that is not there craters at
   * the read that wanted it.
   *
   * @param {string} file  e.g. "common.xml"
   * @param {string} snapshotId
   * @returns {string}
   */
  filePath(file, snapshotId) {
    return path.join(this.snapshotsDir(), snapshotId, file);
  }
}

// --- runtime file compilation ----------------------------------------------

/**
 * Read a dialect XML file from disk and compile it (with its `<include>`
 * closure) into a {@link DialectBundle}. Includes are flat basenames read from
 * the entry file's own directory — a snapshot is self-contained — so this
 * compiles without any network access; the runtime compiler never fetches
 * remote includes (DESIGN.md §4).
 *
 * Fails loud — a missing/unreadable file or include throws naming it and its
 * referrer — so a custom profile never silently falls back to a bundled
 * dialect.
 *
 * @param {string} entryPath  absolute or cwd-relative path to the entry XML
 * @returns {import('./compile').DialectBundle}
 */
function compileXmlFromFile(entryPath) {
  const abs = path.resolve(entryPath);
  const dir = path.dirname(abs);
  const entryName = path.basename(abs);

  const files = {};
  const queue = [{ name: entryName, referrer: null }];
  while (queue.length) {
    const { name, referrer } = queue.shift();
    if (files[name] !== undefined) continue;
    try {
      files[name] = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (err) {
      const from = referrer ? ` (included by '${referrer}')` : '';
      throw codedError(
        'XML_DIALECT_READ_FAILED',
        `Custom dialect file '${name}'${from} could not be read from ${dir}: ${err.message}.`
      );
    }
    for (const inc of parseFile(name, files[name]).includes) {
      queue.push({ name: inc, referrer: name });
    }
  }

  return compileXml(files, entryName);
}

// --- helpers ----------------------------------------------------------------

/**
 * Build a filesystem-safe, roughly-sortable snapshot id from provenance.
 *
 * @param {string} commit
 * @param {number} downloadedAt
 * @returns {string}
 */
function makeSnapshotId(commit, downloadedAt) {
  const stamp = new Date(downloadedAt).toISOString().replace(/[:.]/g, '-');
  return `${REPO.replace('/', '_')}-${REF}-${commit.slice(0, 7)}-${stamp}`;
}

/**
 * @param {string} text
 * @returns {string} hex sha256
 */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * One comparable string for a manifest's file list: every name with its
 * hash, in name order. Seed and snapshot manifests share the shape.
 *
 * @param {{name: string, sha256: string}[]} files
 * @returns {string}
 */
function fileList(files) {
  return files
    .map((f) => `${f.name}=${f.sha256}`)
    .sort()
    .join('\n');
}

/**
 * Find the XML entry filename for a dialect key inside a file-name list
 * (case-insensitive basename match).
 *
 * @param {string[]} fileNames
 * @param {string} dialectKey
 * @returns {?string}
 */
function entryFileForDialect(fileNames, dialectKey) {
  const want = `${dialectKey.toLowerCase()}.xml`;
  for (const name of fileNames) {
    if (name.toLowerCase() === want) return name;
  }
  return null;
}

/**
 * Build the editor dialect library: one row per dialect name, versions =
 * shipped seed (when present) plus every downloaded snapshot that contains a
 * usable copy of that dialect. Deduped by dialect key.
 *
 * @param {XmlCatalog} catalog
 * @returns {{dialects: Array<{name: string, versions: object[]}>}}
 */
function dialectLibrary(catalog) {
  /** @type {Map<string, object[]>} */
  const byName = new Map();

  const ensure = (name) => {
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    return byName.get(key);
  };

  /** @type {Map<string, string[]>} include chain per dialect, from the seed */
  const chains = new Map();
  /** @type {Map<string, string>} entry file per dialect, from the seed */
  const entries = new Map();

  // Seed first — offline baseline.
  const manifest = readManifest();
  const dateLabel = new Date(manifest.fetchedAt).toISOString().slice(0, 10);
  for (const d of manifest.dialects) {
    const name = String(d.name).toLowerCase();
    chains.set(name, d.files);
    entries.set(name, d.entry);
    ensure(name).push({ id: 'seed', kind: 'seed', label: `Seed (${dateLabel})`, entryFile: d.entry });
  }

  for (const m of catalog.list()) {
    const when = new Date(m.downloadedAt).toISOString().slice(0, 10);
    const short = String(m.commit).slice(0, 7);
    // Every XML file is a potential dialect root (same as seed generation).
    for (const { name: fileName } of m.files) {
      const dialect = path.basename(fileName, '.xml').toLowerCase();
      // Skip generator-test / umbrella roots if they somehow appear.
      if (dialect === 'all' || dialect === 'test' || dialect === 'python_array_test') continue;
      ensure(dialect).push({
        id: m.snapshotId,
        kind: 'snapshot',
        label: `${when} · ${m.repo}@${m.ref} (${short})`,
        entryFile: fileName,
      });
    }
  }

  // `entry` + `files` let the editor hide dialects a profile already contains:
  // ardupilotmega pulls in uAvionix, icarous, loweheiser, cubepilot and
  // csAirLink, and storm32 pulls in ardupilotmega. Offering those as additions
  // would be offering something already loaded. Chains come from the seed —
  // a snapshot of the same dialect includes the same files.
  const dialects = [...byName.keys()].sort().map((name) => ({
    name,
    entry: entries.get(name) || `${name}.xml`,
    files: chains.get(name),
    versions: byName.get(name),
  }));
  return { dialects };
}

module.exports = {
  XmlCatalog,
  compileXmlFromFile,
  entryFileForDialect,
  dialectLibrary,
  // GitHub fetch surface, shared with scripts/generate-seed.js — one owner
  // for the definitions-dir constant and the three upstream calls.
  DEFINITIONS_DIR,
  fetchCommitInfo,
  defaultListFiles,
  defaultFetchFile,
  sha256,
};
