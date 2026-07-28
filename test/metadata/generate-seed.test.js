'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeSeed } = require('../../scripts/generate-seed');

const GOOD_MINIMAL = `<?xml version="1.0"?>
<mavlink>
  <version>3</version>
  <messages>
    <message id="0" name="HEARTBEAT">
      <field type="uint8_t" name="type">t</field>
    </message>
  </messages>
</mavlink>
`;

const GOOD_ICAROUS = `<?xml version="1.0"?>
<mavlink>
  <version>3</version>
  <messages>
    <message id="42000" name="ICAROUS_HEARTBEAT">
      <field type="uint8_t" name="status">s</field>
    </message>
  </messages>
</mavlink>
`;

/** Broken: missing include — compileXml fails loud. */
const BAD_ROOT = `<?xml version="1.0"?>
<mavlink>
  <version>3</version>
  <include>missing.xml</include>
  <messages></messages>
</mavlink>
`;

test('writeSeed replaces the seed only when every selectable root compiles', () => {
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-seed-ok-'));
  fs.rmSync(seedDir, { recursive: true, force: true });

  const { manifest } = writeSeed({
    seedDir,
    repo: 'mavlink/mavlink',
    ref: 'master',
    commit: 'abc123',
    quiet: true,
    files: {
      'minimal.xml': GOOD_MINIMAL,
      'icarous.xml': GOOD_ICAROUS,
    },
  });

  assert.equal(manifest.dialects.length, 2);
  assert.ok(fs.existsSync(path.join(seedDir, 'bundles', 'minimal.json')));
  assert.ok(fs.existsSync(path.join(seedDir, 'bundles', 'icarous.json')));
  assert.deepEqual(manifest.compileErrors, []);
});

test('writeSeed leaves the previous seed untouched when any selectable root fails', () => {
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-seed-prev-'));
  fs.rmSync(seedDir, { recursive: true, force: true });

  writeSeed({
    seedDir,
    repo: 'mavlink/mavlink',
    ref: 'master',
    commit: 'aaa111',
    quiet: true,
    files: {
      'minimal.xml': GOOD_MINIMAL,
      'icarous.xml': GOOD_ICAROUS,
    },
  });
  const before = fs.readFileSync(path.join(seedDir, 'manifest.json'), 'utf8');
  assert.ok(fs.existsSync(path.join(seedDir, 'bundles', 'icarous.json')));

  assert.throws(
    () =>
      writeSeed({
        seedDir,
        repo: 'mavlink/mavlink',
        ref: 'master',
        commit: 'bbb222',
        quiet: true,
        files: {
          'minimal.xml': GOOD_MINIMAL,
          'icarous.xml': GOOD_ICAROUS,
          'broken.xml': BAD_ROOT,
        },
      }),
    /Seed compile failed.*broken\.xml/s
  );

  // Previous seed must still be the live tree — icarous must not disappear.
  assert.equal(fs.readFileSync(path.join(seedDir, 'manifest.json'), 'utf8'), before);
  assert.ok(fs.existsSync(path.join(seedDir, 'bundles', 'icarous.json')));
  assert.ok(!fs.existsSync(path.join(seedDir, 'bundles', 'broken.json')));
  const manifest = JSON.parse(before);
  assert.equal(manifest.commit, 'aaa111');
});
