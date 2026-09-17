'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { XmlCatalog, compileXmlFromFile } = require('../../lib/metadata/xml-catalog');

/**
 * Downloadable XML catalog + on-disk custom compile (DESIGN.md §4). The network
 * is injected so these run offline; snapshots are written to a temp dir. Errors
 * are plain Errors carrying `.code` (this package's style, no MavlinkError).
 */

const XML = (body) => `<?xml version="1.0"?>\n<mavlink>${body}</mavlink>`;

// A standalone downloaded "minimal" dialect: one shared message (HEARTBEAT),
// one download-only message and enum, so a diff against the real bundled
// `minimal` shows adds.
const MINIMAL = XML(
  '<enums>' +
    '<enum name="EXTRA_ENUM"><entry value="0" name="EXTRA_ENUM_A"/></enum>' +
    '</enums>' +
    '<messages>' +
    '<message id="0" name="HEARTBEAT"><field type="uint8_t" name="type">t</field></message>' +
    '<message id="9000" name="EXTRA_MSG"><field type="uint8_t" name="a">a</field></message>' +
    '</messages>'
);

// A dialect with no bundled counterpart (bundledExists === false).
const CUSTOM = XML(
  '<messages><message id="9100" name="MY_MSG"><field type="uint8_t" name="x">x</field></message></messages>'
);

/**
 * In-memory GitHub source stub: pins a fixed commit, lists `roots` (every
 * file of `tree` when omitted) and serves the tree; a file outside it 404s
 * the way the default fetcher does.
 */
function stubSource(tree, roots = Object.keys(tree)) {
  const sha = 'a'.repeat(40);
  const requested = [];
  return {
    sha,
    tree,
    requested,
    resolveCommit: () => Promise.resolve(sha),
    fetchFile: async (_repo, commit, file) => {
      requested.push({ commit, file });
      if (!(file in tree)) {
        throw new Error(`404 ${file}`);
      }
      return tree[file];
    },
    listFiles: () => Promise.resolve(roots),
  };
}

/** @returns {XmlCatalog} a catalog over a temp dir, wired to `src` */
function catalogFor(src, opts = {}) {
  return new XmlCatalog({
    baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mav-xml-cat-')),
    resolveCommit: src.resolveCommit,
    fetchFile: src.fetchFile,
    listFiles: src.listFiles,
    ...opts,
  });
}

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mav-xml-cat-'));
}

/* ---------- helpers ---------- */

test('an update follows real <include>s and ignores commented-out ones', async () => {
  const src = stubSource({
    'root.xml': XML(
      '<!-- <include>ignored.xml</include> --><include> common.xml </include>' +
        '<messages><message id="9000" name="EXTRA_MSG"><field type="uint8_t" name="a">a</field></message></messages>'
    ),
    'common.xml': MINIMAL,
  }, ['root.xml']);
  await catalogFor(src).update();
  assert.deepEqual(src.requested.map((r) => r.file), ['root.xml', 'common.xml'],
    'the real include was fetched, the commented one never asked for');
});

/* ---------- compileXmlFromFile ---------- */

test('compileXmlFromFile compiles an entry and its includes from disk', () => {
  const dir = tmpBase();
  fs.writeFileSync(path.join(dir, 'base.xml'), XML('<messages><message id="0" name="HEARTBEAT"><field type="uint8_t" name="t">t</field></message></messages>'));
  fs.writeFileSync(path.join(dir, 'entry.xml'), XML('<include>base.xml</include><version>3</version><messages><message id="42" name="ENTRY"><field type="uint8_t" name="e">e</field></message></messages>'));

  const bundle = compileXmlFromFile(path.join(dir, 'entry.xml'));
  assert.equal(bundle.dialect, 'entry');
  assert.deepEqual(Object.keys(bundle.messages).sort(), ['ENTRY', 'HEARTBEAT']);
  assert.deepEqual(bundle.files, ['base.xml', 'entry.xml']);
});

test('compileXmlFromFile fails loud on a missing include, naming it and the referrer', () => {
  const dir = tmpBase();
  fs.writeFileSync(path.join(dir, 'entry.xml'), XML('<include>missing.xml</include>'));
  let err;
  try {
    compileXmlFromFile(path.join(dir, 'entry.xml'));
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected a throw');
  assert.equal(err.code, 'XML_DIALECT_READ_FAILED');
  assert.match(err.message, /missing\.xml/);
  assert.match(err.message, /entry\.xml/);
});

test('compileXmlFromFile fails loud on a missing entry file', () => {
  const dir = tmpBase();
  assert.throws(
    () => compileXmlFromFile(path.join(dir, 'nope.xml')),
    (e) => e.code === 'XML_DIALECT_READ_FAILED'
  );
});

/* ---------- XmlCatalog: update ---------- */

test('update pins a commit, writes a snapshot and its manifest, and lists it', async () => {
  const src = stubSource({ 'minimal.xml': MINIMAL, 'custom.xml': CUSTOM });
  const catalog = catalogFor(src, { now: () => 1700000000000 });

  const manifest = await catalog.update();

  assert.equal(manifest.commit, src.sha);
  assert.ok(src.requested.every((r) => r.commit === src.sha), 'every fetch used the pinned commit');
  assert.deepEqual(manifest.files.map((f) => f.name), ['custom.xml', 'minimal.xml']);
  assert.ok(fs.existsSync(catalog.filePath('minimal.xml', manifest.snapshotId)));

  const list = catalog.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].snapshotId, manifest.snapshotId);
});

test('an include that cannot be downloaded fails the update; nothing is written', async () => {
  const withInclude = XML('<include>common.xml</include><messages><message id="1" name="ONLY"><field type="uint8_t" name="a">a</field></message></messages>');
  const src = stubSource({ 'ardupilotmega.xml': withInclude }); // common.xml absent → 404
  const catalog = catalogFor(src);

  await assert.rejects(() => catalog.update(), /404 common\.xml/);
  assert.deepEqual(catalog.list(), []);
});

test('a download matching the newest snapshot file for file is not kept', async () => {
  const src = stubSource({ 'minimal.xml': MINIMAL });
  // A ticking clock: the stub pins one commit, so only the stamp tells two
  // snapshot ids apart.
  let tick = 1700000000000;
  const catalog = catalogFor(src, { now: () => (tick += 1000) });
  const first = await catalog.update();
  assert.ok(first);

  assert.equal(await catalog.update(), null);
  assert.equal(catalog.list().length, 1);

  // A changed file upstream is a new snapshot again.
  src.tree['minimal.xml'] = CUSTOM;
  const second = await catalog.update();
  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.equal(catalog.list().length, 2);
});
