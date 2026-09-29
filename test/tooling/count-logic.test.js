'use strict';

/**
 * scripts/count-logic.js is the AGENTS.md §2 diff-report counter. Run against a
 * scratch repository: a rename nets to the lines that changed, and only
 * `lib/**` + `nodes/*.js` count as runtime.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'count-logic.js');

test('a rename counts as delete plus add, and sitl/ is tooling, not runtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'count-logic-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  fs.mkdirSync(path.join(dir, 'lib'));
  const body = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n');
  fs.writeFileSync(path.join(dir, 'lib', 'old.js'), `${body}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  git('mv', 'lib/old.js', 'lib/new.js');
  fs.appendFileSync(path.join(dir, 'lib', 'new.js'), 'const extra = 1;\n');
  fs.mkdirSync(path.join(dir, 'sitl'));
  fs.writeFileSync(path.join(dir, 'sitl', 'probe.js'), 'const probe = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');

  const out = execFileSync(process.execPath, [SCRIPT, 'HEAD~1', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  const row = (group) => out.split('\n').find((line) => line.startsWith(group)).trim().split(/\s+/);
  assert.deepEqual(row('runtime'), ['runtime', '40', '41', '+1', '41', '40']);
  assert.deepEqual(row('tooling'), ['tooling', '0', '1', '+1', '1', '0']);
});
