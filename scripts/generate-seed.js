#!/usr/bin/env node
'use strict';

/**
 * Build the shipped dialect seed from upstream MAVLink XML.
 *
 * Downloads (or copies) `message_definitions/v1.0/*.xml` from a pinned
 * mavlink/mavlink commit, writes them under `seed/mavlink/xml/`, compiles every
 * dialect root into a persisted {@link DialectBundle} JSON under
 * `seed/mavlink/bundles/`, and records provenance in `seed/mavlink/manifest.json`.
 *
 * The XML definitions are MIT-licensed per https://mavlink.io/en/#license —
 * NOTICE carries that text. Re-run whenever dialects should move forward:
 *
 *   node scripts/generate-seed.js
 *   node scripts/generate-seed.js --source-dir /path/to/mavlink
 *   node scripts/generate-seed.js --repo mavlink/mavlink --ref master
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { compileXml } = require('../lib/metadata/compile');

const REPO_ROOT = path.resolve(__dirname, '..');
const SEED_DIR = path.join(REPO_ROOT, 'seed', 'mavlink');
const DEFINITIONS_DIR = 'message_definitions/v1.0';

/** Dialects we do not ship as selectable roots (generator tests / meta). */
const SKIP_ROOTS = new Set([
  'all.xml', // umbrella include of everything — not a real vehicle dialect
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
 * @param {string} repo
 * @param {string} ref
 * @returns {Promise<string>}
 */
async function resolveCommit(repo, ref) {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
    headers: { Accept: 'application/vnd.github.sha' },
  });
  if (!res.ok) {
    throw new Error(`Cannot resolve ${repo}@${ref} (${res.status})`);
  }
  return (await res.text()).trim();
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
 * @param {string} sourceDir  mavlink repo root
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
    // plain checkout without .git — commit stays unknown; caller should prefer --ref fetch
  }
  const files = {};
  for (const name of fs.readdirSync(defDir).filter((f) => f.endsWith('.xml'))) {
    files[name] = fs.readFileSync(path.join(defDir, name), 'utf8');
  }
  return { commit, files };
}

/**
 * @param {object} opts
 * @returns {Promise<{repo: string, ref: string, commit: string, files: Object<string, string>}>}
 */
async function collectXml(opts) {
  if (opts.sourceDir) {
    const { commit, files } = loadFromSourceDir(opts.sourceDir);
    return { repo: opts.repo, ref: opts.ref, commit, files };
  }
  const commit = await resolveCommit(opts.repo, opts.ref);
  const names = await listRemoteXml(opts.repo, commit);
  const files = {};
  for (const name of names) {
    files[name] = await fetchRemoteFile(opts.repo, commit, name);
  }
  return { repo: opts.repo, ref: opts.ref, commit, files };
}

/**
 * @param {string} fileName
 * @returns {string}
 */
function dialectKey(fileName) {
  return fileName.replace(/\.xml$/i, '').toLowerCase();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { repo, ref, commit, files } = await collectXml(opts);
  const fetchedAt = new Date().toISOString();

  const xmlDir = path.join(SEED_DIR, 'xml');
  const bundlesDir = path.join(SEED_DIR, 'bundles');
  fs.rmSync(SEED_DIR, { recursive: true, force: true });
  fs.mkdirSync(xmlDir, { recursive: true });
  fs.mkdirSync(bundlesDir, { recursive: true });

  const fileMeta = [];
  for (const [name, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    fs.writeFileSync(path.join(xmlDir, name), text);
    fileMeta.push({ name, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') });
  }

  const dialects = [];
  const compileErrors = [];
  for (const name of Object.keys(files).sort()) {
    if (SKIP_ROOTS.has(name)) continue;
    const key = dialectKey(name);
    try {
      const bundle = compileXml(files, name);
      // Stable API key is lowercase; keep compiler's dialect/files as-is for provenance.
      const persisted = Object.assign({}, bundle, {
        dialect: key,
        fetched: { repo, commit, fetchedAt },
      });
      fs.writeFileSync(path.join(bundlesDir, `${key}.json`), `${JSON.stringify(persisted)}\n`);
      dialects.push({
        name: key,
        entry: name,
        files: persisted.files,
        messageCount: Object.keys(persisted.messages).length,
        enumCount: Object.keys(persisted.enums).length,
      });
      console.log(`compiled ${key} (${persisted.files.length} files, ${dialects[dialects.length - 1].messageCount} messages)`);
    } catch (err) {
      compileErrors.push({ entry: name, error: err.message });
      console.error(`FAIL ${name}: ${err.message}`);
    }
  }

  if (dialects.length === 0) {
    throw new Error('No dialects compiled into the seed');
  }

  fs.writeFileSync(path.join(SEED_DIR, 'NOTICE'), MIT_NOTICE);
  const manifest = {
    schemaVersion: 1,
    repo,
    ref,
    commit,
    fetchedAt,
    license: 'MIT',
    licenseNote: 'MAVLink message definition XML — see NOTICE and https://mavlink.io/en/#license',
    xmlDir: 'xml',
    bundlesDir: 'bundles',
    files: fileMeta,
    dialects,
    compileErrors,
  };
  fs.writeFileSync(path.join(SEED_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nSeed written to ${SEED_DIR}`);
  console.log(`commit ${commit} — ${dialects.length} dialects, ${fileMeta.length} xml files`);
  if (compileErrors.length) {
    console.log(`${compileErrors.length} root(s) failed to compile (recorded in manifest)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
