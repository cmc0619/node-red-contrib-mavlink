'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ALL_VEHICLES,
  RESTART_SETS,
  containersForRestart,
  px4ContainersIn,
} = require('../../sitl/lib/suite-schedule');

test('restart:none resolves to an empty container list', () => {
  assert.deepEqual(containersForRestart('none'), []);
});

test('restart:ap-1 is only nrc-ap-1', () => {
  assert.deepEqual(containersForRestart('ap-1'), ['nrc-ap-1']);
});

test('restart:ap-fleet is AP 1–5', () => {
  assert.deepEqual(containersForRestart('ap-fleet'), RESTART_SETS['ap-fleet']);
  assert.equal(containersForRestart('ap-fleet').length, 5);
});

test('restart:px4-1 is only nrc-px4-11', () => {
  assert.deepEqual(containersForRestart('px4-1'), ['nrc-px4-11']);
});

test('unknown or omitted restart defaults to full fleet', () => {
  assert.deepEqual(containersForRestart(undefined), ALL_VEHICLES);
  assert.deepEqual(containersForRestart('nope'), ALL_VEHICLES);
});

test('SITL_RESTART=fleet forces full fleet even for none', () => {
  const prev = process.env.SITL_RESTART;
  process.env.SITL_RESTART = 'fleet';
  try {
    assert.deepEqual(containersForRestart('none'), ALL_VEHICLES);
    assert.deepEqual(containersForRestart('ap-1'), ALL_VEHICLES);
  } finally {
    if (prev === undefined) delete process.env.SITL_RESTART;
    else process.env.SITL_RESTART = prev;
  }
});

test('px4ContainersIn filters the restart set', () => {
  assert.deepEqual(px4ContainersIn(['nrc-ap-1', 'nrc-px4-11']), ['nrc-px4-11']);
  assert.deepEqual(px4ContainersIn(['nrc-ap-1']), []);
});

test('example files are numbered 01–N matching suite run order', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '../../examples/sitl');
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+-.*\.json$/.test(f))
    .sort();
  assert.equal(files[0], '01-px4-param-union.json');
  assert.equal(files[files.length - 1], '38-signing.json');
  // Phase boundary: last none/tcp before first ap takeoff
  assert.ok(files.indexOf('19-tcp-connection.json') < files.indexOf('20-completion-takeoff.json'));
  assert.ok(files.indexOf('27-move-reposition-carrier.json') < files.indexOf('28-temporarily-rejected.json'));
  assert.ok(files.indexOf('35-lucy-in-the-sky.json') < files.indexOf('36-mode-tables.json'));
});
