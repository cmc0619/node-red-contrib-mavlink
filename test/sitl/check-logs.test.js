'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const SCRIPT = path.join(__dirname, '../../sitl/check-logs.sh');

function run(args) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
}

test('check-logs fails when armed service has no flight log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitl-logs-'));
  fs.mkdirSync(path.join(root, 'ap-1'));
  const r = run(['--logs-root', root, '--expect-armed', 'ap-1']);
  assert.notEqual(r.status, 0);
});

test('check-logs rejects empty log files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitl-logs-'));
  const dir = path.join(root, 'ap-1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'empty.BIN'), '');
  const r = run(['--logs-root', root, '--expect-armed', 'ap-1']);
  assert.notEqual(r.status, 0);
});

test('check-logs passes when armed service has non-empty .bin or .ulg', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitl-logs-'));
  const dir = path.join(root, 'ap-1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '00000001.BIN'), 'x');
  const r = run(['--logs-root', root, '--expect-armed', 'ap-1']);
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
});

test('check-logs passes for .ulg under nested path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitl-logs-'));
  const dir = path.join(root, 'px4-11', 'log');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.ulg'), 'x');
  const r = run(['--logs-root', root, '--expect-armed', 'px4-11']);
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
});

test('check-logs --newer-than-marker requires a post-marker log', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitl-logs-'));
  const dir = path.join(root, 'ap-1');
  fs.mkdirSync(dir);
  const oldLog = path.join(dir, 'old.BIN');
  fs.writeFileSync(oldLog, 'old');
  // Ensure marker is newer than old log.
  const marker = path.join(dir, '.arm-marker');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(oldLog, past, past);
  fs.writeFileSync(marker, '');
  let r = run(['--logs-root', root, '--expect-armed', 'ap-1', '--newer-than-marker']);
  assert.notEqual(r.status, 0, 'stale log must not pass');

  // Second-resolution mtime: wait so the new log is strictly newer than marker.
  await sleep(1100);
  fs.writeFileSync(path.join(dir, 'new.BIN'), 'fresh');
  r = run(['--logs-root', root, '--expect-armed', 'ap-1', '--newer-than-marker']);
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
});
