#!/usr/bin/env node
'use strict';

/**
 * Build the shipped dialect seed from upstream MAVLink XML.
 *
 * Output is a **single** gzipped JSON blob named with the stamp:
 *   seed/mavlink-YYYY-MM-DD-<shortsha>.seed.gz
 * plus a tiny pointer `seed/active.json` so the runtime can find it.
 * The blob holds NOTICE, provenance manifest, and the upstream XML sources.
 * Runtime gunzips once and compiles the dialects a profile actually uses —
 * XML is ~10x smaller than the bundles it compiles to, because every dialect
 * embeds its own copy of common.xml.
 *
 * Every selectable root is still compiled here. That is the gate: a root that
 * will not compile fails the run and leaves the previous seed untouched.
 *
 *   node scripts/generate-seed.js
 *   node scripts/generate-seed.js --source-dir /path/to/mavlink
 *   node scripts/generate-seed.js --repo mavlink/mavlink --ref master
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { compileXml } = require('../lib/metadata/compile');

const REPO_ROOT = path.resolve(__dirname, '..');
const SEED_DIR = path.join(REPO_ROOT, 'seed');
/** Pointer the runtime reads to locate the dated blob. */
const ACTIVE_FILE = path.join(SEED_DIR, 'active.json');
const DEFINITIONS_DIR = 'message_definitions/v1.0';

/**
 * @param {string} stamp
 * @returns {string} basename e.g. mavlink-2026-07-29-de1e078.seed.gz
 */
function seedFileName(stamp) {
  return `mavlink-${stamp}.seed.gz`;
}

/** Dialects we do not ship as selectable roots (generator tests / meta). */
const SKIP_ROOTS = new Set([
  'all.xml',
  'python_array_test.xml',
  'test.xml',
]);

const MIT_NOTICE = `MAVLink message definition XML files
Source: https://github.com/mavlink/mavlink
License: MIT (see https://mavlink.io/en/#license and the upstream COPYING
exception covering message definitions / generator output).

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
`;

/**
 * @param {string[]} argv
 * @returns {{sourceDir: ?string, repo: string, ref: string}}
 */
function parseArgs(argv) {
  const out = { sourceDir: null, repo: 'mavlink/mavlink', ref: 'master' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source-dir') out.sourceDir = path.resolve(argv[++i]);
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--ref') out.ref = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/generate-seed.js [--source-dir DIR] [--repo OWNER/REPO] [--ref REF]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
}

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Pin a ref to its commit, and record when that commit landed upstream. The
 * commit date is the XML's own version date — distinct from `fetchedAt`, which
 * is only when this generator ran.
 *
 * @param {string} repo
 * @param {string} ref
 * @returns {Promise<{commit: string, commitDate: ?string}>}
 */
async function resolveCommit(repo, ref) {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    throw new Error(`Cannot resolve ${repo}@${ref} (${res.status})`);
  }
  const body = await res.json();
  return { commit: body.sha, commitDate: body.commit.committer.date };
}

/**
 * @param {string} repo
 * @param {string} commit
 * @returns {Promise<string[]>}
 */
async function listRemoteXml(repo, commit) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${DEFINITIONS_DIR}?ref=${commit}`,
    { headers: { Accept: 'application/vnd.github+json' } }
  );
  if (!res.ok) {
    throw new Error(`Cannot list ${DEFINITIONS_DIR} at ${repo}@${commit.slice(0, 7)} (${res.status})`);
  }
  const entries = await res.json();
  return entries.filter((e) => e.type === 'file' && e.name.endsWith('.xml')).map((e) => e.name);
}

/**
 * @param {string} repo
 * @param {string} commit
 * @param {string} file
 * @returns {Promise<string>}
 */
async function fetchRemoteFile(repo, commit, file) {
  const url = `https://raw.githubusercontent.com/${repo}/${commit}/${DEFINITIONS_DIR}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${file} (${res.status})`);
  return res.text();
}

/**
 * @param {string} sourceDir
 * @returns {{commit: string, files: Object<string, string>}}
 */
function loadFromSourceDir(sourceDir) {
  const defDir = path.join(sourceDir, DEFINITIONS_DIR);
  if (!fs.existsSync(defDir)) {
    throw new Error(`No ${DEFINITIONS_DIR} under ${sourceDir}`);
  }
  let commit = 'unknown';
  try {
    const head = fs.readFileSync(path.join(sourceDir, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref:')) {
      const ref = head.slice(5).trim();
      commit = fs.readFileSync(path.join(sourceDir, '.git', ref), 'utf8').trim();
    } else {
      commit = head;
    }
  } catch {
    // plain checkout without .git
  }
  const files = {};
  for (const name of fs.readdirSync(defDir).filter((f) => f.endsWith('.xml'))) {
    files[name] = fs.readFileSync(path.join(defDir, name), 'utf8');
  }
  let commitDate = null;
  try {
    commitDate = require('child_process')
      .execFileSync('git', ['-C', sourceDir, 'log', '-1', '--format=%cI', commit], { encoding: 'utf8' })
      .trim();
  } catch {
    // plain checkout without .git, or a commit this clone does not have
  }
  return { commit, commitDate, files };
}

/**
 * @param {object} opts
 * @returns {Promise<{repo: string, ref: string, commit: string, files: Object<string, string>}>}
 */
async function collectXml(opts) {
  if (opts.sourceDir) {
    const { commit, commitDate, files } = loadFromSourceDir(opts.sourceDir);
    return { repo: opts.repo, ref: opts.ref, commit, commitDate, files };
  }
  const { commit, commitDate } = await resolveCommit(opts.repo, opts.ref);
  const names = await listRemoteXml(opts.repo, commit);
  const files = {};
  for (const name of names) {
    files[name] = await fetchRemoteFile(opts.repo, commit, name);
  }
  return { repo: opts.repo, ref: opts.ref, commit, commitDate, files };
}

/**
 * @param {string} fileName
 * @returns {string}
 */
function dialectKey(fileName) {
  return fileName.replace(/\.xml$/i, '').toLowerCase();
}

/**
 * Human + machine stamp: UTC date + short commit.
 *
 * @param {string} fetchedAt  ISO timestamp
 * @param {string} commit
 * @returns {string}
 */
function makeStamp(fetchedAt, commit) {
  const day = new Date(fetchedAt).toISOString().slice(0, 10);
  const short = String(commit || 'unknown').slice(0, 7);
  return `${day}-${short}`;
}

/**
 * Compile every selectable root into one gzipped seed blob.
 * Compiles fully before touching the live file; a partial failure leaves the
 * previous seed untouched and throws.
 *
 * @param {object} opts
 * @param {Object<string, string>} opts.files
 * @param {string} opts.repo
 * @param {string} opts.ref
 * @param {string} opts.commit
 * @param {string} [opts.fetchedAt]
 * @param {string} [opts.seedDir]  directory for the blob + active.json
 * @param {boolean} [opts.quiet]
 * @returns {{payload: object, seedFile: string, stamp: string, active: object}}
 */
function writeSeed(opts) {
  const seedDir = opts.seedDir || SEED_DIR;
  const repo = opts.repo;
  const ref = opts.ref;
  const commit = opts.commit;
  const commitDate = opts.commitDate || null;
  const fetchedAt = opts.fetchedAt || new Date().toISOString();
  const stamp = makeStamp(fetchedAt, commit);
  const baseName = seedFileName(stamp);
  const seedFile = path.join(seedDir, baseName);
  const activeFile = path.join(seedDir, 'active.json');
  const files = opts.files;
  const log = opts.quiet ? () => {} : console.log.bind(console);
  const errLog = opts.quiet ? () => {} : console.error.bind(console);

  const dialects = [];
  const compileErrors = [];

  // The blob ships XML, not bundles — runtime compiles per profile. This loop
  // stays as the gate: every selectable root must compile here, or the seed is
  // not written at all. It also yields the per-dialect manifest rows the editor
  // dialect library reads.
  for (const name of Object.keys(files).sort()) {
    if (SKIP_ROOTS.has(name)) continue;
    const key = dialectKey(name);
    try {
      const bundle = compileXml(files, name);
      dialects.push({
        name: key,
        entry: name,
        files: bundle.files,
        messageCount: Object.keys(bundle.messages).length,
        enumCount: Object.keys(bundle.enums).length,
      });
      log(`compiled ${key} (${bundle.files.length} files, ${dialects[dialects.length - 1].messageCount} messages)`);
    } catch (err) {
      compileErrors.push({ entry: name, error: err.message });
      errLog(`FAIL ${name}: ${err.message}`);
    }
  }

  if (compileErrors.length) {
    const detail = compileErrors.map((e) => `${e.entry}: ${e.error}`).join('; ');
    throw new Error(
      `Seed compile failed for ${compileErrors.length} selectable root(s); ` +
        `previous seed left untouched. ${detail}`
    );
  }
  if (dialects.length === 0) {
    throw new Error('No dialects compiled into the seed');
  }

  const fileMeta = Object.keys(files)
    .sort()
    .map((name) => ({
      name,
      sha256: sha256(files[name]),
      bytes: Buffer.byteLength(files[name], 'utf8'),
    }));

  const payload = {
    schemaVersion: 3,
    stamp,
    notice: MIT_NOTICE,
    manifest: {
      schemaVersion: 3,
      stamp,
      repo,
      ref,
      commit,
      commitDate,
      fetchedAt,
      license: 'MIT',
      licenseNote: 'MAVLink message definition XML — see NOTICE and https://mavlink.io/en/#license',
      files: fileMeta,
      dialects,
      compileErrors: [],
    },
    sources: files,
  };

  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
  fs.mkdirSync(seedDir, { recursive: true });

  // Write blob + pointer only after a full compile success (above). Staging
  // the gz avoids a truncated live file if the process dies mid-write.
  const staging = `${seedFile}.staging-${process.pid}`;
  fs.writeFileSync(staging, gz);
  fs.renameSync(staging, seedFile);

  const active = {
    file: baseName,
    stamp,
    repo,
    ref,
    commit,
    commitDate,
    fetchedAt,
  };
  const activeStaging = `${activeFile}.staging-${process.pid}`;
  fs.writeFileSync(activeStaging, `${JSON.stringify(active, null, 2)}\n`);
  fs.renameSync(activeStaging, activeFile);

  // Drop older stamped blobs so git stays at one seed file.
  for (const name of fs.readdirSync(seedDir)) {
    if (/^mavlink-.+\.seed\.gz$/.test(name) && name !== baseName) {
      fs.unlinkSync(path.join(seedDir, name));
    }
  }

  log(`\nSeed written to ${seedFile}`);
  log(`stamp ${stamp} — ${dialects.length} dialects, ${fileMeta.length} xml sources, ${gz.length} bytes gzipped`);
  return { payload, seedFile, stamp, active, manifest: payload.manifest };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { repo, ref, commit, commitDate, files } = await collectXml(opts);
  writeSeed({ files, repo, ref, commit, commitDate });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  writeSeed,
  dialectKey,
  makeStamp,
  seedFileName,
  SKIP_ROOTS,
  SEED_DIR,
  ACTIVE_FILE,
};
