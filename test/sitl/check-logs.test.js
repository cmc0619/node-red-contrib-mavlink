'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../sitl/check-logs.sh');

test('check-logs fails when armed service has no flight log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitl-logs-'));
  fs.mkdirSync(path.join(root, 'ap-1'));
  const r = spawnSync('bash', [SCRIPT, '--logs-root', root, '--expect-armed', 'ap-1'], {
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
});

test('check-logs passes when armed service has .bin or .ulg', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitl-logs-'));
  const dir = path.join(root, 'ap-1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '00000001.BIN'), 'x');
  const r = spawnSync('bash', [SCRIPT, '--logs-root', root, '--expect-armed', 'ap-1'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
});

test('check-logs passes for .ulg under nested path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitl-logs-'));
  const dir = path.join(root, 'px4-11', 'log');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.ulg'), 'x');
  const r = spawnSync('bash', [SCRIPT, '--logs-root', root, '--expect-armed', 'px4-11'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
});
