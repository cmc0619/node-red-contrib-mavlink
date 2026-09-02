'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { knownDialects, loadBundled, readManifest } = require('./bundled');
const { compileXml } = require('./compile');

/**
 * Downloadable MAVLink XML dialect catalog (DESIGN.md §4).
 *
 * Organizes official MAVLink XML snapshots under the Node-RED userDir so a user
 * can refresh past the shipped seed (`seed/mavlink`) when internet is available.
 * Downloaded XML is the same shape the seed uses — pin a commit, follow
 * `<include>`, timestamp, compare against {@link loadBundled}. Compiling a
 * downloaded file yields the same {@link DialectBundle} as a seed load.
 *
 * Layout under the base dir (typically `<userDir>/mavlink/xml`):
 *
 *   manifests/<snapshotId>.json   provenance + file list + per-file hash
 *   snapshots/<snapshotId>/*.xml  the downloaded XML set (includes together)
 *   latest/*.xml                  the most recent snapshot's files (stable path)
 *
 * Downloads go through an injectable fetcher (mirroring `fetch.js`) so the logic
 * is fully testable offline; the default fetcher uses global `fetch` against
 * raw.githubusercontent. Includes are followed at *download* time (so a snapshot
 * is self-contained); the runtime compiler never fetches remote includes.
 *
 * Errors are plain `Error`s carrying a `.code` string (this package has no
 * MavlinkError class) so callers can branch on the code (e.g. 404 vs 500).
 */

// Official MAVLink message definitions live here in the source repo.
const DEFINITIONS_DIR = 'message_definitions/v1.0';

const DEFAULT_SOURCE = { repo: 'mavlink/mavlink', ref: 'master' };

// `<include>foo.xml</include>` (mirrors the runtime include resolver).
const INCLUDE_RE = /<include>\s*([^<]+?)\s*<\/include>/g;

/**
 * Build a plain Error with a machine-readable `.code` and optional extra
 * properties — this package's error style (no MavlinkError class).
 *
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {Error}
 */
function codedError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) {
    Object.assign(err, extra);
  }
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
      `Failed to download ${file} (${res.status} ${res.statusText}).`,
      { file, url, status: res.status }
    );
  }
  return res.text();
}

/**
 * Resolve a ref to its commit via the GitHub commits API, recording when that
 * commit landed upstream. Returns null when unavailable — the commit date is
 * the XML's own version date, distinct from any fetched-at stamp. One owner of
 * the commits-API call (the catalog's resolver below and the seed generator
 * both ride it).
 *
 * @param {string} repo
 * @param {string} ref
 * @returns {Promise<?{commit: string, commitDate: string}>}
 */
async function fetchCommitInfo(repo, ref) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      return null;
    }
    const body = await res.json();
    const sha = body.sha;
    if (!/^[0-9a-f]{40}$/i.test(String(sha))) {
      return null;
    }
    return {
      commit: sha,
      commitDate: body.commit.committer.date,
    };
  } catch {
    return null;
  }
}

/**
 * Commit-sha resolver for a ref. Returns null when unavailable; update()
 * treats that as fatal — every downloaded file must come from one immutable
 * commit, so an unresolvable ref cannot be pinned honestly.
 *
 * @param {string} repo
 * @param {string} ref
 * @returns {Promise<?string>}
 */
async function defaultResolveCommit(repo, ref) {
  const info = await fetchCommitInfo(repo, ref);
  return info ? info.commit : null;
}

/**
 * Discover every XML file in the official definitions dir at a commit, via the
 * GitHub contents API. Returns the file names, or null when the listing is
 * unavailable (update() fails loudly rather than quietly reverting to a partial
 * seed list).
 *
 * @param {string} repo
 * @param {string} commit  resolved commit sha
 * @returns {Promise<?string[]>}
 */
async function defaultListFiles(repo, commit) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${DEFINITIONS_DIR}?ref=${commit}`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) {
      return null;
    }
    const entries = await res.json();
    if (!Array.isArray(entries)) {
      return null;
    }
    return entries
      .filter((e) => e.type === 'file' && /\.xml$/i.test(e.name))
      .map((e) => e.name);
  } catch {
    return null;
  }
}

class XmlCatalog {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir  cache root (e.g. `<userDir>/mavlink/xml`)
   * @param {function} [opts.fetchFile]      (repo, ref, file) -> Promise<string>
   * @param {function} [opts.resolveCommit]  (repo, ref) -> Promise<?string>
   * @param {function} [opts.listFiles]      (repo, commit) -> Promise<?string[]>
   * @param {function} [opts.now]            clock override (tests)
   */
  constructor(opts = {}) {
    if (!opts.baseDir) {
      throw codedError('XML_CATALOG_NO_DIR', 'XmlCatalog requires a baseDir.');
    }
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

  /** @returns {string} */
  latestDir() {
    return path.join(this.baseDir, 'latest');
  }

  /**
   * Download a MAVLink XML set into a new snapshot, following `<include>`
   * dependencies so the snapshot is self-contained. Records provenance in a
   * manifest and refreshes the `latest/` copy.
   *
   * Provenance/integrity:
   *
   *  - the requested ref is resolved to an immutable commit sha FIRST, and
   *    every file is fetched from that commit — never the mutable ref;
   *  - by default the complete upstream `message_definitions/v1.0` file list at
   *    that commit is discovered and downloaded (an explicit `files` list
   *    narrows the roots; includes are still followed);
   *  - a root that does not exist at the commit is recorded in `missing`
   *    (optional root); a root that downloaded but whose required include
   *    closure is incomplete is recorded in `unusable` with the missing
   *    includes — it is never published as a usable dialect.
   *
   * @param {object} [opts]
   * @param {string} [opts.repo]   default mavlink/mavlink
   * @param {string} [opts.ref]    default master
   * @param {string[]} [opts.files]  root dialect files (includes are followed);
   *   omitted = discover the full upstream set
   * @returns {Promise<object>} the written manifest
   */
  async update(opts = {}) {
    const repo = opts.repo || DEFAULT_SOURCE.repo;
    const ref = opts.ref || DEFAULT_SOURCE.ref;

    // 1. Pin the ref to a commit before anything is downloaded.
    const commit = await this.resolveCommit(repo, ref);
    if (!commit) {
      throw codedError(
        'XML_CATALOG_COMMIT_UNRESOLVED',
        `Cannot resolve '${ref}' in ${repo} to a commit; refusing to download from a mutable ref.`,
        { repo, ref }
      );
    }

    // 2. Determine the root dialect files: explicit list, or full discovery.
    let roots;
    if (Array.isArray(opts.files) && opts.files.length) {
      roots = opts.files;
    } else {
      const listed = await this.listFiles(repo, commit);
      if (!Array.isArray(listed) || listed.length === 0) {
        throw codedError(
          'XML_CATALOG_LIST_FAILED',
          `Cannot list ${DEFINITIONS_DIR} at ${repo}@${commit.slice(0, 7)}; refusing to fall back to a partial seed list.`,
          { repo, ref, commit }
        );
      }
      roots = listed;
    }

    // 3. BFS over the include graph, downloading each file once — always from
    //    the pinned commit. Track each file's includes so per-root closure can
    //    be checked afterwards.
    const fetched = new Map(); // file -> text
    const includesOf = new Map(); // file -> [include file names]
    const failed = new Set(); // files that could not be downloaded
    const queue = roots.slice();
    while (queue.length) {
      const file = queue.shift();
      if (fetched.has(file) || failed.has(file)) {
        continue;
      }
      let text;
      try {
        text = await this.fetchFile(repo, commit, file);
      } catch {
        // A root may not exist at every commit (e.g. development.xml on old
        // tags). Whether that is benign or fatal is decided per root below.
        failed.add(file);
        continue;
      }
      fetched.set(file, text);
      const incs = extractIncludes(text);
      includesOf.set(file, incs);
      for (const incFile of incs) {
        if (!fetched.has(incFile) && !failed.has(incFile)) {
          queue.push(incFile);
        }
      }
    }

    if (fetched.size === 0) {
      throw codedError('XML_CATALOG_EMPTY', `No XML files could be downloaded from ${repo}@${commit}.`, {
        repo,
        ref,
        commit,
        missing: [...failed],
      });
    }

    // 4. Per-root include closure: a missing root is optional; a downloaded
    //    root missing any required include cannot compile and is unusable.
    const missing = [...failed].sort();
    const unusable = [];
    for (const root of new Set(roots)) {
      if (!fetched.has(root)) {
        continue; // recorded in `missing`
      }
      const missingIncludes = this._missingInClosure(root, includesOf, failed);
      if (missingIncludes.length) {
        unusable.push({ file: root, missingIncludes });
      }
    }
    unusable.sort((a, b) => a.file.localeCompare(b.file));

    const downloadedAt = this.now();
    const snapshotId = makeSnapshotId(repo, ref, commit, downloadedAt);
    const snapDir = path.join(this.snapshotsDir(), snapshotId);
    fs.mkdirSync(snapDir, { recursive: true });

    const files = [];
    for (const [file, text] of fetched) {
      fs.writeFileSync(path.join(snapDir, file), text);
      files.push({ name: file, sha256: sha256(text), bytes: Buffer.byteLength(text) });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));

    const unusableNames = new Set(unusable.map((u) => u.file));
    const manifest = {
      snapshotId,
      repo,
      ref,
      commit,
      sourceUrlBase: `https://raw.githubusercontent.com/${repo}/${commit}/${DEFINITIONS_DIR}`,
      downloadedAt,
      files,
      missing,
      unusable,
      // Roots whose whole include closure downloaded — safe to select.
      usable: [...new Set(roots)].filter((r) => fetched.has(r) && !unusableNames.has(r)).sort(),
    };

    fs.mkdirSync(this.manifestsDir(), { recursive: true });
    fs.writeFileSync(path.join(this.manifestsDir(), `${snapshotId}.json`), JSON.stringify(manifest, null, 2));

    // Refresh latest/ as a stable path pointing at the newest set.
    this._writeLatest(snapDir, files);

    return manifest;
  }

  /**
   * Walk one root's include closure and collect every required include that
   * failed to download.
   *
   * @param {string} root
   * @param {Map<string, string[]>} includesOf  file -> its includes
   * @param {Set<string>} failed  files that could not be downloaded
   * @returns {string[]} missing include file names, sorted
   */
  _missingInClosure(root, includesOf, failed) {
    const missing = new Set();
    const seen = new Set([root]);
    const stack = [root];
    while (stack.length) {
      const file = stack.pop();
      for (const inc of includesOf.get(file) || []) {
        if (failed.has(inc)) {
          missing.add(inc);
        } else if (!seen.has(inc)) {
          seen.add(inc);
          stack.push(inc);
        }
      }
    }
    return [...missing].sort();
  }

  /**
   * Copy a snapshot's files into latest/ (replacing what's there), so a profile
   * can reference a stable path that always resolves to the most recent set.
   *
   * @param {string} snapDir
   * @param {object[]} files
   * @returns {void}
   */
  _writeLatest(snapDir, files) {
    const latest = this.latestDir();
    fs.rmSync(latest, { recursive: true, force: true });
    fs.mkdirSync(latest, { recursive: true });
    for (const f of files) {
      fs.copyFileSync(path.join(snapDir, f.name), path.join(latest, f.name));
    }
  }

  /**
   * List downloaded snapshots (newest first).
   *
   * @returns {object[]} manifests
   */
  list() {
    const dir = this.manifestsDir();
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      return []; // nothing downloaded yet
    }
    const manifests = [];
    for (const name of names) {
      try {
        manifests.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      } catch {
        // Skip a corrupt manifest rather than break the whole listing.
      }
    }
    return manifests.sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0));
  }

  /**
   * Absolute path to a downloaded XML file (in a specific snapshot, or latest/).
   *
   * @param {string} file  e.g. "common.xml"
   * @param {string} [snapshotId]  a snapshot id, or omitted for latest/
   * @returns {?string} the path, or null if it doesn't exist
   */
  filePath(file, snapshotId) {
    let p;
    if (snapshotId) {
      const snap = normalizeSnapshotId(snapshotId);
      if (!snap) {
        return null; // reject traversal / absolute / empty snapshot ids
      }
      p = path.join(this.snapshotsDir(), snap, file);
    } else {
      p = path.join(this.latestDir(), file);
    }
    return fileExists(p) ? p : null;
  }

  /**
   * Compare a downloaded XML dialect against the installed bundled dialect of
   * the same basename. Informational only — this never changes what the runtime
   * loads. When both compile, reports message/enum differences.
   *
   * @param {object} opts
   * @param {string} opts.file  e.g. "common.xml"
   * @param {string} [opts.snapshot]  snapshot id, or omitted for latest/
   * @returns {object} comparison result
   */
  compare(opts = {}) {
    const file = opts.file;
    const dialectName = path.basename(file, '.xml').toLowerCase();
    const downloadedPath = this.filePath(file, opts.snapshot);
    if (!downloadedPath) {
      throw codedError('XML_CATALOG_FILE_NOT_FOUND', `Downloaded XML '${file}' not found in the catalog.`, {
        file,
        snapshot: opts.snapshot || 'latest',
      });
    }

    const bundledExists = knownDialects().includes(dialectName);
    const result = {
      file,
      dialect: dialectName,
      snapshot: opts.snapshot || 'latest',
      bundledExists,
      comparable: false,
    };

    // Compile the downloaded XML (resolving its includes from the same snapshot
    // directory) for a deeper diff. A malformed download reports its error
    // rather than throwing the whole comparison away.
    let downloaded;
    try {
      downloaded = compileXmlFromFile(downloadedPath);
    } catch (err) {
      result.error = err.message;
      return result;
    }
    result.downloaded = summarizeBundle(downloaded);
    if (!bundledExists) {
      // Nothing bundled to diff against; the message/enum summary still helps.
      return result;
    }

    const bundled = loadBundled(dialectName);
    result.bundled = summarizeBundle(bundled);
    result.comparable = true;
    result.diff = diffBundles(bundled, downloaded);
    return result;
  }
}

// --- runtime file compilation ----------------------------------------------

/**
 * Read a dialect XML file from disk and compile it (with its `<include>`
 * closure) into a {@link DialectBundle}. Includes are resolved from the entry
 * file's own directory first, then any `extraDirs` (e.g. a catalog snapshot),
 * so a self-contained downloaded snapshot compiles without any network access.
 * The runtime compiler never fetches remote includes (DESIGN.md §4).
 *
 * Fails loud — a missing/unreadable file or include throws naming it — so a
 * custom profile never silently falls back to a bundled dialect.
 *
 * @param {string} entryPath  absolute or cwd-relative path to the entry XML
 * @param {object} [opts]
 * @param {string[]} [opts.extraDirs]  additional directories to search for includes
 * @returns {import('./index').DialectBundle}
 */
function compileXmlFromFile(entryPath, opts = {}) {
  const abs = path.resolve(entryPath);
  const entryName = path.basename(abs);
  const searchDirs = [path.dirname(abs), ...(opts.extraDirs || [])];

  const files = {};
  const seen = new Set();
  const queue = [{ name: entryName, referrer: null }];
  while (queue.length) {
    const { name, referrer } = queue.shift();
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const found = findFile(name, searchDirs, referrer === null ? abs : null);
    if (!found) {
      const from = referrer ? ` (included by '${referrer}')` : '';
      throw codedError(
        'XML_DIALECT_READ_FAILED',
        `Custom dialect file '${name}'${from} could not be read from ${searchDirs.join(', ')}.`,
        { file: name, referrer: referrer || null }
      );
    }
    let text;
    try {
      text = fs.readFileSync(found, 'utf8');
    } catch (err) {
      throw codedError('XML_DIALECT_READ_FAILED', `Custom dialect file '${found}' could not be read: ${err.message}.`, {
        file: found,
      });
    }
    files[name] = text;
    for (const inc of extractIncludes(text)) {
      const incName = path.basename(inc.trim());
      if (incName && !seen.has(incName)) {
        queue.push({ name: incName, referrer: name });
      }
    }
  }

  return compileXml(files, entryName);
}

/**
 * Locate a dialect file by name across the search directories. The entry file
 * may live at an exact path (used verbatim); includes are flat basenames looked
 * up in each directory in order.
 *
 * @param {string} name  file basename
 * @param {string[]} searchDirs
 * @param {?string} exactPath  the entry file's own resolved path, when known
 * @returns {?string} the resolved path, or null
 */
function findFile(name, searchDirs, exactPath) {
  if (exactPath && fileExists(exactPath)) {
    return exactPath;
  }
  for (const dir of searchDirs) {
    const candidate = path.join(dir, name);
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

// --- helpers ----------------------------------------------------------------

/**
 * Extract `<include>` file names from XML text (comments stripped).
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractIncludes(text) {
  const uncommented = String(text).replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  let m;
  INCLUDE_RE.lastIndex = 0;
  while ((m = INCLUDE_RE.exec(uncommented)) !== null) {
    const name = m[1].trim();
    if (name) {
      out.push(name);
    }
  }
  return out;
}

/**
 * Validate a snapshot id before it is joined into a filesystem path. Generated
 * ids only ever contain `[\w.-]` (see `makeSnapshotId`/`sanitize`), so anything
 * with a path separator, a `..` segment, or a leading dot is rejected here as
 * an attempted escape from `snapshots/`.
 *
 * @param {string} id
 * @returns {?string} the id if safe, else null
 */
function normalizeSnapshotId(id) {
  const s = String(id).trim();
  if (!s || s === '.' || s === '..' || s.includes('..') || !/^[\w.-]+$/.test(s)) {
    return null;
  }
  if (path.basename(s) !== s) {
    return null;
  }
  return s;
}

/**
 * Build a filesystem-safe, roughly-sortable snapshot id from provenance.
 *
 * @param {string} repo
 * @param {string} ref
 * @param {?string} commit
 * @param {number} downloadedAt
 * @returns {string}
 */
function makeSnapshotId(repo, ref, commit, downloadedAt) {
  const stamp = new Date(downloadedAt).toISOString().replace(/[:.]/g, '-');
  const shortCommit = commit ? commit.slice(0, 7) : 'nocommit';
  return `${sanitize(repo)}-${sanitize(ref)}-${shortCommit}-${stamp}`;
}

/**
 * @param {string} s
 * @returns {string}
 */
function sanitize(s) {
  return String(s).replace(/[^\w.-]+/g, '_');
}

/**
 * @param {string} text
 * @returns {string} hex sha256
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Summarize a compiled bundle for the comparison output.
 *
 * @param {import('./index').DialectBundle} bundle
 * @returns {{valid: boolean, messageCount: number, enumCount: number}}
 */
function summarizeBundle(bundle) {
  return {
    valid: true,
    messageCount: Object.keys(bundle.messages).length,
    enumCount: Object.keys(bundle.enums).length,
  };
}

/**
 * A stable per-message field signature (name/type/array/extension), used to
 * detect field-level changes since this bundle shape carries no CRC/magic.
 *
 * @param {import('./index').Message} msg
 * @returns {string}
 */
function fieldSignature(msg) {
  return (msg.fields || [])
    .map((f) => `${f.name}:${f.type}${f.arrayLength != null ? `[${f.arrayLength}]` : ''}${f.extension ? '+' : ''}`)
    .join(',');
}

/**
 * Diff two compiled bundles by message name/id/field-signature and enum names.
 *
 * @param {import('./index').DialectBundle} bundled  installed bundled dialect
 * @param {import('./index').DialectBundle} downloaded  compiled downloaded XML
 * @returns {object}
 */
function diffBundles(bundled, downloaded) {
  const bMsgs = bundled.messages;
  const dMsgs = downloaded.messages;

  const addedMessages = []; // in downloaded, not bundled
  const removedMessages = []; // in bundled, not downloaded
  const changedMessages = []; // same name, different id or field signature

  for (const [name, d] of Object.entries(dMsgs)) {
    const b = bMsgs[name];
    if (!b) {
      addedMessages.push(name);
    } else if (b.id !== d.id || fieldSignature(b) !== fieldSignature(d)) {
      changedMessages.push({
        name,
        bundled: { id: b.id },
        downloaded: { id: d.id },
      });
    }
  }
  for (const name of Object.keys(bMsgs)) {
    if (!dMsgs[name]) {
      removedMessages.push(name);
    }
  }

  // Enum keys are already the SCREAMING XML names in both bundles.
  const bEnums = new Set(Object.keys(bundled.enums));
  const dEnums = new Set(Object.keys(downloaded.enums));
  const addedEnums = [...dEnums].filter((e) => !bEnums.has(e));
  const removedEnums = [...bEnums].filter((e) => !dEnums.has(e));

  return {
    addedMessages: addedMessages.sort(),
    removedMessages: removedMessages.sort(),
    changedMessages: changedMessages.sort((a, b) => a.name.localeCompare(b.name)),
    addedEnums: addedEnums.sort(),
    removedEnums: removedEnums.sort(),
  };
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
  const want = `${String(dialectKey).toLowerCase()}.xml`;
  for (const name of fileNames) {
    if (String(name).toLowerCase() === want) return name;
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
    const key = String(name).toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    return byName.get(key);
  };

  /** @type {Map<string, string[]>} include chain per dialect, from the seed */
  const chains = new Map();
  /** @type {Map<string, string>} entry file per dialect, from the seed */
  const entries = new Map();

  // Seed first — offline baseline.
  try {
    const manifest = readManifest();
    const fetchedAt = manifest.fetchedAt || null;
    const dateLabel = fetchedAt ? new Date(fetchedAt).toISOString().slice(0, 10) : 'shipped';
    for (const d of manifest.dialects || []) {
      const name = String(d.name).toLowerCase();
      chains.set(name, d.files || []);
      entries.set(name, d.entry || `${name}.xml`);
      ensure(name).push({
        id: 'seed',
        kind: 'seed',
        label: `Seed (${dateLabel})`,
        downloadedAt: fetchedAt,
        commit: manifest.commit || null,
        repo: manifest.repo || 'mavlink/mavlink',
        ref: manifest.ref || null,
        entryFile: d.entry || `${name}.xml`,
        path: null,
      });
    }
  } catch {
    // Seed missing in a broken checkout — downloaded snapshots can still serve.
  }

  const unusableFiles = (m) => new Set((m.unusable || []).map((u) => u.file));

  for (const m of catalog.list()) {
    const banned = unusableFiles(m);
    const names = (m.files || []).map((f) => f.name);
    const when = m.downloadedAt ? new Date(m.downloadedAt).toISOString().slice(0, 10) : '';
    const short = (m.commit && String(m.commit).slice(0, 7)) || m.ref || '';
    // Every XML file is a potential dialect root (same as seed generation).
    for (const fileName of names) {
      if (banned.has(fileName)) continue;
      const dialect = path.basename(fileName, '.xml').toLowerCase();
      // Skip generator-test / umbrella roots if they somehow appear.
      if (dialect === 'all' || dialect === 'test' || dialect === 'python_array_test') continue;
      const abs = catalog.filePath(fileName, m.snapshotId);
      if (!abs) continue;
      ensure(dialect).push({
        id: m.snapshotId,
        kind: 'snapshot',
        label: `${when} · ${m.repo}@${m.ref} (${short})`,
        downloadedAt: m.downloadedAt || null,
        commit: m.commit || null,
        repo: m.repo || null,
        ref: m.ref || null,
        entryFile: fileName,
        path: abs,
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
    files: chains.get(name) || null,
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
