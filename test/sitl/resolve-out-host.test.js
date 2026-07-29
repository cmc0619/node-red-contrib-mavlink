'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../sitl/scripts/resolve-out-host.sh');

function resolve(host) {
  const r = spawnSync(
    'bash',
    ['-c', `. "${SCRIPT}"; resolve_out_host_ip "$1"`, 'bash', host],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('unresolved custom OUT_HOST returns empty (no gateway invent)', () => {
  assert.equal(resolve('definitely-not-a-real-host.invalid'), '');
});

test('host.docker.internal resolves to an IPv4 address when a default route exists', () => {
  const ip = resolve('host.docker.internal');
  // In CI/containers without a usable route this may be empty; when present it
  // must look like dotted-quad (compose bridge gateway or host-gateway).
  if (ip === '') return;
  assert.match(ip, /^\d{1,3}(?:\.\d{1,3}){3}$/);
});
