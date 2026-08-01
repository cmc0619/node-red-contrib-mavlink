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
const COMPOSE = path.join(__dirname, '../../sitl/docker-compose.yml');

test('entrypoint launches official prebuilt arducopter via udpclient', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /\/usr\/local\/bin\/arducopter/, 'must exec prebuilt arducopter');
  assert.match(
    src,
    /OUT_PORT="\$\{OUT_PORT:-14550\}"/,
    'GCS fleet default OUT_PORT must be 14550 (Node-RED bind)'
  );
  assert.match(
    src,
    /--serial0\s+"udpclient:\$\{OUT_IP\}:\$\{OUT_PORT\}"/,
    'must send telemetry to the Node-RED bind port via udpclient'
  );
  assert.match(
    src,
    /--defaults\s+\/params\/copter\.parm,\/params\/ap-logging\.parm/,
    'must load autotest copter defaults plus lab logging parm'
  );
  assert.doesNotMatch(src, /sim_vehicle\.py/, 'must not require a source tree / sim_vehicle');
  assert.doesNotMatch(src, /mavproxy/i, 'must not require MAVProxy');

  const compose = fs.readFileSync(COMPOSE, 'utf8');
  assert.match(
    compose,
    /OUT_PORT:\s*"14550"/,
    'compose AP GCS default must target host 14550'
  );
  // x-ap anchor sets OUT_PORT 14550; companion overrides to 14540.
  assert.match(compose, /OUT_PORT:\s*"14540"/, 'companion AP uses 14540');
});

test('Dockerfile downloads the pinned Copter-4.7.0 prebuilt binary', () => {
  const src = fs.readFileSync(DOCKERFILE, 'utf8');
  assert.match(
    src,
    /FROM --platform=linux\/amd64 ubuntu:22\.04/,
    'must pin linux/amd64 — official SITL binary is x86_64 only'
  );
  assert.match(
    src,
    /firmware\.ardupilot\.org\/Copter\/stable-4\.7\.0\/SITL_x86_64_linux_gnu\/arducopter/,
    'must fetch the official static SITL binary'
  );
  assert.match(
    src,
    /-o \/usr\/local\/bin\/arducopter/,
    'must install binary at /usr/local/bin/arducopter'
  );
  assert.match(
    src,
    /chmod 0755 \/usr\/local\/bin\/arducopter/,
    'must mark arducopter executable'
  );
  assert.match(
    src,
    /raw\.githubusercontent\.com\/ArduPilot\/ardupilot\/Copter-4\.7\.0\/Tools\/autotest\/default_params\/copter\.parm/,
    'must fetch Copter-4.7.0 autotest default params from the matching tag'
  );
  assert.match(
    src,
    /-o \/params\/copter\.parm/,
    'must place copter.parm under /params'
  );
  assert.match(
    src,
    /COPY params\/ap-logging\.parm \/params\/ap-logging\.parm/,
    'must include lab logging parm'
  );
  // Strip comments, then reject waf invocations.
  const code = src.replace(/#[^\n]*/g, '');
  assert.doesNotMatch(code, /\bwaf\b/, 'must not compile SITL from source');
});
