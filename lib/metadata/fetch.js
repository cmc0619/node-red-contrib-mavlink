'use strict';

const { compileXml } = require('./compile');

/**
 * Remote fetch of official dialect XML for the *custom* path and for comparing
 * a downloaded snapshot against the installed registry dialect (DESIGN.md §4).
 * Never a substitute for the bundled path.
 *
 * The network is fully injectable — `resolveCommit`, `fetchFile`, and the
 * optional `listFiles` are supplied by the caller (the config node in
 * production, stubs in tests), so this module has no transport dependency and
 * runs offline in CI. The ref is pinned to a commit *before* any file is
 * downloaded and every include is followed at that commit, so a snapshot is
 * self-contained and reproducible. The source is selectable between the two
 * byte-identical upstreams (§14); neither is privileged.
 *
 * Being async, every rejection from an injected call propagates to the caller's
 * promise rather than being swallowed (§2).
 */

/** Selectable upstreams; byte-identical for `ardupilotmega.xml` today (§14). */
const REMOTE_SOURCES = ['mavlink/mavlink', 'ArduPilot/mavlink'];

/**
 * Extract `<include>` file names from raw dialect XML for the fetch-time
 * include walk. Full validation is compileXml's job; this only needs the
 * edges of the graph.
 *
 * @param {string} xml
 * @returns {string[]}
 */
function extractIncludes(xml) {
  const includes = [];
  const re = /<include>\s*([^<]+?)\s*<\/include>/g;
  let m;
  while ((m = re.exec(String(xml))) !== null) {
    includes.push(m[1].trim());
  }
  return includes;
}

/**
 * Fetch a custom dialect and its include closure from a GitHub source, pinned
 * to a commit, and compile it to a {@link DialectBundle} with fetch provenance.
 *
 * @param {object} opts
 * @param {string} opts.repo  one of {@link REMOTE_SOURCES}
 * @param {string} [opts.ref=master]  git ref to pin
 * @param {string|string[]} opts.files  entry dialect file name (first, if an
 *   array); the include closure is discovered and fetched automatically
 * @param {(repo: string, commit: string, file: string) => Promise<string>} opts.fetchFile
 *   fetch one file's XML at the pinned commit
 * @param {(repo: string, ref: string) => Promise<string>} opts.resolveCommit
 *   pin a ref to a commit SHA
 * @param {(repo: string, commit: string) => Promise<string[]>} [opts.listFiles]
 *   list available dialect file names at the commit; when provided, the entry
 *   is validated against it
 * @returns {Promise<import('./index').DialectBundle>}
 */
async function fetchDialect(opts) {
  const { repo, ref = 'master', files, fetchFile, resolveCommit, listFiles } = opts || {};

  if (!REMOTE_SOURCES.includes(repo)) {
    throw new Error(
      `Unknown remote source '${repo}'. Choose one of: ${REMOTE_SOURCES.join(', ')}.`
    );
  }
  if (typeof resolveCommit !== 'function' || typeof fetchFile !== 'function') {
    throw new Error('fetchDialect requires injected resolveCommit and fetchFile functions.');
  }

  const entry = Array.isArray(files) ? files[0] : files;
  if (!entry || typeof entry !== 'string') {
    throw new Error('fetchDialect requires an entry dialect file name in `files`.');
  }

  // Pin the commit first so the whole download is a consistent snapshot (§4).
  const commit = await resolveCommit(repo, ref);
  if (!commit || typeof commit !== 'string') {
    throw new Error(`Could not resolve ${repo}@${ref} to a commit.`);
  }

  if (typeof listFiles === 'function') {
    const available = await listFiles(repo, commit);
    if (Array.isArray(available) && available.length && !available.includes(entry)) {
      throw new Error(
        `Dialect file '${entry}' is not among the files at ${repo}@${commit}.`
      );
    }
  }

  // Follow includes at the pinned commit so the snapshot is self-contained.
  const fetched = {};
  const queue = [entry];
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const xml = await fetchFile(repo, commit, file);
    if (typeof xml !== 'string') {
      throw new Error(`Fetch of '${file}' from ${repo}@${commit} returned no content.`);
    }
    fetched[file] = xml;
    for (const inc of extractIncludes(xml)) {
      if (!seen.has(inc)) {
        queue.push(inc);
      }
    }
  }

  const bundle = compileXml(fetched, entry);
  bundle.fetched = { repo, commit, fetchedAt: new Date().toISOString() };
  return bundle;
}

module.exports = { REMOTE_SOURCES, fetchDialect, extractIncludes };
