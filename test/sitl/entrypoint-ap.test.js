'use strict';

/**
 * Pins the ArduPilot Compose entrypoint to the official prebuilt SITL binary
 * with udpclient → Node-RED bind port (DESIGN.md §14 / sitl/README.md).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '../../sitl/scripts/entrypoint-ap.sh');
const DOCKERFILE = path.join(__dirname, '../../sitl/Dockerfile.ardupilot');

test('entrypoint launches official prebuilt arducopter via udpclient', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /\/usr\/local\/bin\/arducopter/, 'must exec prebuilt arducopter');
  assert.match(
    src,
    /--serial0\s+"udpclient:\$\{OUT_IP\}:\$\{OUT_PORT\}"/,
    'must send telemetry to the Node-RED bind port via udpclient'
  );
  assert.doesNotMatch(src, /sim_vehicle\.py/, 'must not require a source tree / sim_vehicle');
  assert.doesNotMatch(src, /mavproxy/i, 'must not require MAVProxy');
});

test('Dockerfile downloads the pinned Copter-4.7.0 prebuilt binary', () => {
  const src = fs.readFileSync(DOCKERFILE, 'utf8');
  assert.match(
    src,
    /firmware\.ardupilot\.org\/Copter\/stable-4\.7\.0\/SITL_x86_64_linux_gnu\/arducopter/,
    'must fetch the official static SITL binary'
  );
  assert.doesNotMatch(src, /\.\/waf\s+copter/, 'must not compile SITL from source');
});
