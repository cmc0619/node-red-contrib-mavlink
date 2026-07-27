'use strict';

/**
 * Connection editor: Vehicle and Identity must use Node-RED's standard
 * config-node select with edit/add buttons (DESIGN.md §6), not free-form ids
 * and not a buttonless <select> fallback.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-connection.html'),
  'utf8'
);
const identityHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-local-identity.html'),
  'utf8'
);

test('Vehicle default declares type mavlink-vehicle (config-node picker)', () => {
  assert.match(
    html,
    /vehicle:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-vehicle'/,
    'defaults.vehicle.type must be mavlink-vehicle'
  );
});

test('Identity default declares type mavlink-local-identity', () => {
  assert.match(
    html,
    /localIdentity:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-local-identity'/,
    'defaults.localIdentity.type must be mavlink-local-identity'
  );
});

test('shared ensureConfigNodePicker uses RED.editor.prepareConfigNodeSelect (edit/add)', () => {
  assert.match(
    identityHtml,
    /ensureConfigNodePicker/,
    'helper is defined on the first-loaded identity editor'
  );
  assert.match(
    identityHtml,
    /prepareConfigNodeSelect/,
    'helper must call Node-RED\'s standard config select builder'
  );
  assert.match(
    html,
    /ensureConfigNodePicker\(this,\s*'vehicle'/,
    'Connection oneditprepare asks for the Vehicle picker'
  );
  assert.match(
    html,
    /ensureConfigNodePicker\(\s*this,\s*'localIdentity'/,
    'Connection oneditprepare asks for the Identity picker'
  );
  assert.ok(
    !html.includes('ensureConfigSelect'),
    'buttonless select fallback must be gone'
  );
});

test('Connection editor does not expose heartbeat interval or UDP broadcast controls', () => {
  assert.ok(!html.includes('heartbeatInterval'), 'heartbeat interval belongs to Local Identity');
  assert.ok(!html.includes('node-config-input-broadcast'), 'SO_BROADCAST is not a Connection option');
  assert.ok(!html.includes('target_system = 0'), 'UDP broadcast must not be conflated with MAVLink broadcast');
});

test('Local Identity editor exposes heartbeatIntervalMs', () => {
  assert.match(
    identityHtml,
    /heartbeatIntervalMs:\s*\{\s*value:\s*1000/,
    'identity defaults own the 1 Hz heartbeat interval'
  );
  assert.match(
    identityHtml,
    /node-config-input-heartbeatIntervalMs/,
    'identity template must render the heartbeat interval control'
  );
});
