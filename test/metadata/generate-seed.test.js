'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { writeSeed, seedFileName } = require('../../scripts/generate-seed');

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

const BAD_ROOT = `<?xml version="1.0"?>
<mavlink>
  <version>3</version>
  <include>missing.xml</include>
  <messages></messages>
</mavlink>
`;

test('writeSeed emits a stamp-named gzip blob + active.json pointer', () => {
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-seed-ok-'));

  const { stamp, active, seedFile } = writeSeed({
    seedDir,
    repo: 'mavlink/mavlink',
    ref: 'master',
    commit: 'abcdef0123456789',
    fetchedAt: '2026-07-28T12:00:00.000Z',
    quiet: true,
    files: {
      'minimal.xml': GOOD_MINIMAL,
      'icarous.xml': GOOD_ICAROUS,
    },
  });

  assert.equal(stamp, '2026-07-28-abcdef0');
  assert.equal(path.basename(seedFile), seedFileName(stamp));
  assert.ok(fs.existsSync(seedFile));
  assert.ok(fs.existsSync(path.join(seedDir, 'active.json')));
  assert.equal(active.file, seedFileName(stamp));
  assert.equal(active.stamp, stamp);

  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(seedFile)).toString('utf8'));
  assert.equal(payload.stamp, stamp);
  // The blob ships XML; the runtime compiles it. Dialect rows still come from
  // the generator's compile pass, which is what makes a bad root fail the run.
  assert.ok(payload.sources['minimal.xml']);
  assert.ok(payload.sources['icarous.xml']);
  assert.ok(!payload.bundles, 'precompiled bundles are not shipped');
  const names = payload.manifest.dialects.map((d) => d.name);
  assert.ok(names.includes('minimal'));
  assert.ok(names.includes('icarous'));
});

test('writeSeed leaves the previous blob untouched when any selectable root fails', () => {
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-seed-prev-'));

  const first = writeSeed({
    seedDir,
    repo: 'mavlink/mavlink',
    ref: 'master',
    commit: 'aaa1111',
    fetchedAt: '2026-07-01T00:00:00.000Z',
    quiet: true,
    files: {
      'minimal.xml': GOOD_MINIMAL,
      'icarous.xml': GOOD_ICAROUS,
    },
  });
  const beforeBlob = fs.readFileSync(first.seedFile);
  const beforeActive = fs.readFileSync(path.join(seedDir, 'active.json'), 'utf8');

  assert.throws(
    () =>
      writeSeed({
        seedDir,
        repo: 'mavlink/mavlink',
        ref: 'master',
        commit: 'bbb2222',
        fetchedAt: '2026-07-28T00:00:00.000Z',
        quiet: true,
        files: {
          'minimal.xml': GOOD_MINIMAL,
          'icarous.xml': GOOD_ICAROUS,
          'broken.xml': BAD_ROOT,
        },
      }),
    /Seed compile failed.*broken\.xml/s
  );

  assert.deepEqual(fs.readFileSync(first.seedFile), beforeBlob);
  assert.equal(fs.readFileSync(path.join(seedDir, 'active.json'), 'utf8'), beforeActive);
  assert.ok(!fs.existsSync(path.join(seedDir, seedFileName('2026-07-28-bbb2222'))));
});

test('writeSeed removes older stamped blobs when a new one succeeds', () => {
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-seed-rotate-'));

  const first = writeSeed({
    seedDir,
    repo: 'mavlink/mavlink',
    ref: 'master',
    commit: 'aaa1111',
    fetchedAt: '2026-07-01T00:00:00.000Z',
    quiet: true,
    files: { 'minimal.xml': GOOD_MINIMAL },
  });
  assert.ok(fs.existsSync(first.seedFile));

  const second = writeSeed({
    seedDir,
    repo: 'mavlink/mavlink',
    ref: 'master',
    commit: 'bbb2222',
    fetchedAt: '2026-07-28T00:00:00.000Z',
    quiet: true,
    files: { 'minimal.xml': GOOD_MINIMAL },
  });

  assert.ok(fs.existsSync(second.seedFile));
  assert.ok(!fs.existsSync(first.seedFile), 'old stamped blob should be removed');
  const active = JSON.parse(fs.readFileSync(path.join(seedDir, 'active.json'), 'utf8'));
  assert.equal(active.file, path.basename(second.seedFile));
});
