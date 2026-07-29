'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

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

const BAD_ROOT = `<?xml version="1.0"?>
<mavlink>
  <version>3</version>
  <include>missing.xml</include>
  <messages></messages>
</mavlink>
`;

test('writeSeed emits one gzipped blob with stamp and every bundle', () => {
  const seedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mav-seed-ok-')), 'mavlink.seed.gz');

  const { stamp, manifest } = writeSeed({
    seedFile,
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
  assert.ok(fs.existsSync(seedFile));
  assert.equal(manifest.dialects.length, 2);

  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(seedFile)).toString('utf8'));
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.stamp, stamp);
  assert.ok(payload.bundles.minimal);
  assert.ok(payload.bundles.icarous);
  assert.ok(payload.notice.includes('MIT'));
});

test('writeSeed leaves the previous blob untouched when any selectable root fails', () => {
  const seedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mav-seed-prev-')), 'mavlink.seed.gz');

  writeSeed({
    seedFile,
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
  const before = fs.readFileSync(seedFile);

  assert.throws(
    () =>
      writeSeed({
        seedFile,
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

  assert.deepEqual(fs.readFileSync(seedFile), before);
  const payload = JSON.parse(zlib.gunzipSync(before).toString('utf8'));
  assert.equal(payload.stamp, '2026-07-01-aaa1111');
  assert.ok(payload.bundles.icarous);
  assert.equal(payload.bundles.broken, undefined);
});
