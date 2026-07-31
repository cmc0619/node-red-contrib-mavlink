'use strict';

/**
 * Pins the ArduPilot Compose entrypoint to launch MAVProxy non-interactively.
 * Headless Docker has no TTY; interactive MAVProxy then stops reading TCP 5760,
 * never sees HEARTBEAT, exits after --retries, and the container restart-loops
 * with a silent host UDP 14550.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '../../sitl/scripts/entrypoint-ap.sh');

test('entrypoint launches sim_vehicle with MAVProxy --daemon for headless Docker', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /sim_vehicle\.py/, 'must invoke sim_vehicle.py');
  // sim_vehicle forwards -m/--mavproxy-args to mavproxy.py; --daemon skips the
  // interactive stdin loop that EOFs under Compose.
  assert.match(
    src,
    /--mavproxy-args(?:=|\s+)["']?[^"'\n]*--daemon/,
    'must pass --daemon through --mavproxy-args'
  );
});
