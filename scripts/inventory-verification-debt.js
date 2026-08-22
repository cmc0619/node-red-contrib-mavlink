'use strict';

/**
 * Parse DESIGN.md §14 status tags and print the verification-debt summary.
 * Exit 1 on unexpected drift from docs/verification-debt.md headline counts.
 */

const fs = require('node:fs');
const path = require('node:path');

const designPath = path.join(__dirname, '..', 'DESIGN.md');
const text = fs.readFileSync(designPath, 'utf8');
const entries = [...text.matchAll(/^\*\*14\.(\d+)\s+(.+?)\*\*\s*(.*)$/gm)].map((m) => ({
  num: +m[1],
  title: m[2].trim(),
  tags: m[3].trim(),
  hasCheck: /✔/.test(m[3]),
  hasTest: /🧪/.test(m[3]),
  hasRead: /📖/.test(m[3]),
}));

const rigTagged = entries.filter((e) => e.hasTest && !e.hasCheck);
const rigImplicit = entries.filter(
  (e) => e.num >= 116 && e.num <= 130 && !e.hasCheck && !e.hasTest && !e.hasRead
);
const readHeaders = entries.filter((e) => e.hasRead && !e.hasCheck);

const OPEN_SUBCLAIMS = 5;
const expected = {
  rig: rigTagged.length + rigImplicit.length,
  readHeaders: readHeaders.length,
  readReported: readHeaders.length + OPEN_SUBCLAIMS,
};

console.log('Verification debt (parsed from DESIGN.md §14)');
console.log('  rig-only (🧪, no ✔):', expected.rig, `(${rigTagged.length} tagged + ${rigImplicit.length} lab ops)`);
console.log('  source-read headers (📖, no ✔):', expected.readHeaders);
console.log('  open subclaims (fixed inventory):', OPEN_SUBCLAIMS);
console.log('  source-read reported total:', expected.readReported);

const want = { rig: 30, readHeaders: 14, readReported: 19 };
let failed = false;
for (const [key, value] of Object.entries(want)) {
  if (expected[key] !== value) {
    console.error(`DRIFT: expected ${key}=${value}, got ${expected[key]}`);
    failed = true;
  }
}

if (failed) {
  console.error('Update docs/verification-debt.md and the want map in this script.');
  process.exit(1);
}
