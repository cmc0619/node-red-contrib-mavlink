'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { XmlCatalog, compileXmlFromFile } = require('../../lib/metadata');

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

/** In-memory GitHub source stub: pins a fixed commit and serves a file tree. */
function stubSource(tree, sha = 'a'.repeat(40)) {
  const requested = [];
  return {
    sha,
    requested,
    resolveCommit: async () => sha,
    fetchFile: async (_repo, commit, file) => {
      requested.push({ commit, file });
      if (!(file in tree)) {
        throw new Error(`404 ${file}`);
      }
      return tree[file];
    },
    listFiles: async () => Object.keys(tree),
  };
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
  });
  const catalog = new XmlCatalog({
    baseDir: tmpBase(), resolveCommit: src.resolveCommit, fetchFile: src.fetchFile, listFiles: src.listFiles,
  });
  await catalog.update({ repo: 'mavlink/mavlink', ref: 'master', files: ['root.xml'] });
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
  assert.equal(bundle.version, 3);
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

test('update pins a commit, writes a snapshot/manifest/latest, and lists it', async () => {
  const baseDir = tmpBase();
  const src = stubSource({ 'minimal.xml': MINIMAL, 'custom.xml': CUSTOM });
  const catalog = new XmlCatalog({
    baseDir,
    resolveCommit: src.resolveCommit,
    fetchFile: src.fetchFile,
    listFiles: src.listFiles,
    now: () => 1700000000000,
  });

  const manifest = await catalog.update({ repo: 'mavlink/mavlink', ref: 'master', files: ['minimal.xml', 'custom.xml'] });

  assert.equal(manifest.commit, src.sha);
  assert.ok(src.requested.every((r) => r.commit === src.sha), 'every fetch used the pinned commit');
  assert.deepEqual(manifest.usable.sort(), ['custom.xml', 'minimal.xml']);
  assert.deepEqual(manifest.missing, []);
  assert.deepEqual(manifest.unusable, []);

  // Files were written to the snapshot and to latest/.
  const snapFile = path.join(catalog.snapshotsDir(), manifest.snapshotId, 'minimal.xml');
  assert.ok(fs.existsSync(snapFile));
  assert.ok(fs.existsSync(path.join(catalog.latestDir(), 'minimal.xml')));

  const list = catalog.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].snapshotId, manifest.snapshotId);
});

test('update refuses when the ref cannot be pinned to a commit', async () => {
  const baseDir = tmpBase();
  const catalog = new XmlCatalog({ baseDir, resolveCommit: async () => null, fetchFile: async () => MINIMAL });
  await assert.rejects(
    () => catalog.update({ repo: 'mavlink/mavlink', ref: 'nope', files: ['minimal.xml'] }),
    (e) => e.code === 'XML_CATALOG_COMMIT_UNRESOLVED'
  );
});

test('a root missing a required include is recorded as unusable, not published', async () => {
  const baseDir = tmpBase();
  const withInclude = XML('<include>common.xml</include><messages><message id="1" name="ONLY"><field type="uint8_t" name="a">a</field></message></messages>');
  const src = stubSource({ 'ardupilotmega.xml': withInclude }); // common.xml absent → 404
  const catalog = new XmlCatalog({ baseDir, resolveCommit: src.resolveCommit, fetchFile: src.fetchFile });

  const manifest = await catalog.update({ files: ['ardupilotmega.xml'] });
  assert.deepEqual(manifest.usable, []);
  assert.equal(manifest.unusable.length, 1);
  assert.equal(manifest.unusable[0].file, 'ardupilotmega.xml');
  assert.deepEqual(manifest.unusable[0].missingIncludes, ['common.xml']);
});

/* ---------- XmlCatalog: filePath ---------- */

test('filePath rejects unsafe file and snapshot ids', async () => {
  const baseDir = tmpBase();
  const src = stubSource({ 'minimal.xml': MINIMAL });
  const catalog = new XmlCatalog({ baseDir, resolveCommit: src.resolveCommit, fetchFile: src.fetchFile });
  const manifest = await catalog.update({ files: ['minimal.xml'] });

  assert.ok(catalog.filePath('minimal.xml', manifest.snapshotId));
  assert.equal(catalog.filePath('minimal.xml', '../escape'), null);
});

/* ---------- XmlCatalog: compare ---------- */

test('compare against a bundled dialect reports added messages/enums', async () => {
  const baseDir = tmpBase();
  const src = stubSource({ 'minimal.xml': MINIMAL });
  const catalog = new XmlCatalog({ baseDir, resolveCommit: src.resolveCommit, fetchFile: src.fetchFile });
  const manifest = await catalog.update({ files: ['minimal.xml'] });

  const result = catalog.compare({ file: 'minimal.xml', snapshot: manifest.snapshotId });
  assert.equal(result.bundledExists, true);
  assert.equal(result.comparable, true);
  assert.ok(result.diff.addedMessages.includes('EXTRA_MSG'));
  assert.ok(result.diff.addedEnums.includes('EXTRA_ENUM'));
  assert.ok(result.downloaded.messageCount >= 2);
  assert.ok(result.bundled.messageCount >= 1);
});

test('compare of a non-bundled dialect reports bundledExists=false, not comparable', async () => {
  const baseDir = tmpBase();
  const src = stubSource({ 'custom.xml': CUSTOM });
  const catalog = new XmlCatalog({ baseDir, resolveCommit: src.resolveCommit, fetchFile: src.fetchFile });
  const manifest = await catalog.update({ files: ['custom.xml'] });

  const result = catalog.compare({ file: 'custom.xml', snapshot: manifest.snapshotId });
  assert.equal(result.bundledExists, false);
  assert.equal(result.comparable, false);
  assert.ok(result.downloaded.messageCount >= 1);
});

test('compare of a file not in the catalog throws XML_CATALOG_FILE_NOT_FOUND', () => {
  const baseDir = tmpBase();
  const catalog = new XmlCatalog({ baseDir });
  assert.throws(
    () => catalog.compare({ file: 'minimal.xml' }),
    (e) => e.code === 'XML_CATALOG_FILE_NOT_FOUND'
  );
});
