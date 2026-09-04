'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { knownDialects } = require('../../lib/metadata/bundled');
const { XmlCatalog, dialectLibrary } = require('../../lib/metadata/xml-catalog');
const { entryFileForDialect } = require('../../lib/metadata/xml-catalog');

test('entryFileForDialect matches case-insensitively', () => {
  assert.equal(entryFileForDialect(['ASLUAV.xml', 'common.xml'], 'asluav'), 'ASLUAV.xml');
  assert.equal(entryFileForDialect(['uAvionix.xml'], 'uavionix'), 'uAvionix.xml');
  assert.equal(entryFileForDialect(['common.xml'], 'icarous'), null);
});

test('dialectLibrary always includes seed versions for known dialects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-lib-'));
  const catalog = new XmlCatalog({ baseDir: dir });
  const { dialects } = dialectLibrary(catalog);
  const names = dialects.map((d) => d.name);
  for (const name of knownDialects()) {
    assert.ok(names.includes(name), `missing ${name}`);
    const row = dialects.find((d) => d.name === name);
    assert.ok(row.versions.some((v) => v.id === 'seed' && v.kind === 'seed'));
  }
});

test('dialectLibrary appends dated snapshot versions without duplicating dialect rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-lib-'));
  const catalog = new XmlCatalog({
    baseDir: dir,
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    resolveCommit: async () => 'abcdef0123456789abcdef0123456789abcdef01',
    listFiles: async () => ['minimal.xml', 'icarous.xml'],
    fetchFile: async (_repo, _commit, file) => {
      if (file === 'minimal.xml') {
        return `<?xml version="1.0"?><mavlink><version>3</version><messages>
          <message id="0" name="HEARTBEAT"><field type="uint8_t" name="t">t</field></message>
        </messages></mavlink>`;
      }
      return `<?xml version="1.0"?><mavlink><version>3</version><messages>
        <message id="42000" name="ICAROUS_HEARTBEAT"><field type="uint8_t" name="status">s</field></message>
      </messages></mavlink>`;
    },
  });
  await catalog.update({ files: ['minimal.xml', 'icarous.xml'] });

  const { dialects } = dialectLibrary(catalog);
  const icarous = dialects.find((d) => d.name === 'icarous');
  assert.ok(icarous);
  assert.equal(icarous.versions.filter((v) => v.kind === 'seed').length, 1);
  assert.ok(icarous.versions.some((v) => v.kind === 'snapshot' && v.path));
  // One row per dialect name — not one row per (dialect,date).
  assert.equal(dialects.filter((d) => d.name === 'icarous').length, 1);
});
