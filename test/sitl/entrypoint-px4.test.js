'use strict';

/**
 * Pins the PX4 Compose entrypoint so lab MAV_SYS_ID values (11–15, 21) are
 * applied before `commander start`. Commander caches vehicle_status.system_id
 * at start; a later param set leaves HEARTBEATs advertising the lab sysid while
 * COMMAND_* targeted at that sysid are ignored (only target_system 0 works).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../sitl/scripts/entrypoint-px4.sh');

test('entrypoint rewrites early MAV_SYS_ID and asserts before commander start', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(
    src,
    /nrc_lab_params_pre_commander/,
    'must insert a pre-commander MAV_SYS_ID block'
  );
  assert.match(
    src,
    /commander start/,
    'pre-commander insert is keyed on commander start'
  );
  assert.match(
    src,
    /px4_instance/,
    'must rewrite vendor early MAV_SYS_ID $((px4_instance+1)) assignment'
  );
  assert.match(src, /sed -i -E/, 'early rewrite uses sed');
  assert.match(src, /nrc_lab_params_pre_mavlink/, 'must still assert before mavlink');
});

// The entrypoint runs inside the PX4 Linux container: it resolves OUT_HOST via
// `getent` and /proc/net/route, neither of which exists under Git Bash on
// Windows, so it exits FATAL before it ever patches rcS. Running it there
// tests the runner, not the script.
const containerOnly = process.platform === 'win32' && 'Linux-only container entrypoint';

test('fixture rcS gets lab SYSID before commander start', { skip: containerOnly }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrc-px4-rcs-'));
  const prefix = path.join(dir, 'opt', 'px4');
  const posix = path.join(prefix, 'etc', 'init.d-posix');
  fs.mkdirSync(posix, { recursive: true });
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'bin', 'px4'), '#!/bin/true\n', { mode: 0o755 });

  const rcs = path.join(posix, 'rcS');
  fs.writeFileSync(
    rcs,
    [
      '#!/bin/sh',
      'param set MAV_SYS_ID $((px4_instance+1))',
      'commander start',
      '. px4-rc.mavlink',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(posix, 'px4-rc.mavlink'),
    [
      'udp_gcs_port_local=$((18570+px4_instance))',
      'mavlink start -x -u $udp_gcs_port_local -r 4000000 -f -t 127.0.0.1 -o 14550',
      'udp_offboard_port_local=$((14580+px4_instance))',
      'udp_offboard_port_remote=$((14540+px4_instance))',
      'mavlink start -x -u $udp_offboard_port_local -r 4000000 -f -m onboard -o $udp_offboard_port_remote',
      '',
    ].join('\n')
  );

  // Source the patching portion by running the entrypoint with a stub px4 that exits.
  // resolve-out-host needs a resolvable OUT_HOST; use 127.0.0.1.
  const env = {
    ...process.env,
    SYSID: '11',
    INSTANCE: '0',
    OUT_HOST: '127.0.0.1',
    OUT_PORT: '14560',
    PATH: `${path.join(prefix, 'bin')}:${process.env.PATH}`,
  };
  // Entrypoint cds to PX4_PREFIX and execs px4 — point it at our fixture tree by
  // placing the script's expected layout under a temp root and chroot-style env.
  // Easier: run bash -c that sets PX4 paths via copying script logic… Instead,
  // invoke the real script after binding PX4_PREFIX via a wrapper that replaces
  // /opt/px4 with our fixture using a bind — not available. Patch by exporting
  // and running only through sed by invoking script with modified PATH where
  // `dirname` resolve still finds resolve-out-host next to the real script.
  //
  // Soften: copy entrypoint + resolve helper into the temp tree and rewrite the
  // PX4_PREFIX detection to use our fixture.
  const scriptCopy = path.join(dir, 'entrypoint-px4.sh');
  const resolveCopy = path.join(dir, 'resolve-out-host.sh');
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  let body = fs.readFileSync(SCRIPT, 'utf8');
  body = body.replace(
    /if \[\[ -d \/opt\/px4-gazebo \]\]; then\n {2}PX4_PREFIX=\/opt\/px4-gazebo\nelse\n {2}PX4_PREFIX=\/opt\/px4\nfi/,
    `PX4_PREFIX="${prefix}"`
  );
  body = body.replace(/mkdir -p \/logs/, `mkdir -p "${logsDir}"`);
  body = body.replace(
    /ln -sfn \/logs "\$\{PX4_PREFIX\}\/log"/,
    `ln -sfn "${logsDir}" "\${PX4_PREFIX}/log"`
  );
  fs.writeFileSync(scriptCopy, body, { mode: 0o755 });
  fs.copyFileSync(
    path.join(__dirname, '../../sitl/scripts/resolve-out-host.sh'),
    resolveCopy
  );

  const result = spawnSync('bash', [scriptCopy], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, `entrypoint failed: ${result.stderr || result.stdout}`);

  const patched = fs.readFileSync(rcs, 'utf8');
  const commanderAt = patched.indexOf('commander start');
  const preCommanderAt = patched.indexOf('nrc_lab_params_pre_commander');
  assert.ok(preCommanderAt !== -1, 'pre-commander marker present');
  assert.ok(preCommanderAt < commanderAt, 'lab SYSID must precede commander start');
  assert.match(patched, /^param set MAV_SYS_ID 11$/m);
  const earlyLine = patched.split('\n').find((l) => l.startsWith('param set MAV_SYS_ID'));
  assert.equal(earlyLine, 'param set MAV_SYS_ID 11');
});
