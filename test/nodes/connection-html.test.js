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
// Shared RED.mavlink.* helpers now live in the stock resource file, loaded by
// every node dialog (DESIGN.md §6). Assert their source there, not in the LI HTML.
const resourceScript = fs.readFileSync(
  path.join(__dirname, '..', '..', 'resources', 'mavlink-editor.js'),
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
    resourceScript,
    /ensureConfigNodePicker/,
    'helper is defined in the shared editor resource'
  );
  assert.match(
    resourceScript,
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

test('additionalIdentities has an editor row (issue #94 — feature must be reachable)', () => {
  // The runtime consumes config.additionalIdentities and the shared editor
  // helper reads conn.additionalIdentities for send-as selects; without this
  // list the feature is only reachable by hand-editing flow JSON.
  assert.match(
    html,
    /additionalIdentities:\s*\{\s*value:\s*\[\]\s*\}/,
    'defaults.additionalIdentities stays declared'
  );
  assert.match(
    html,
    /id="mav-conn-additional-identities"/,
    'template carries the editableList container'
  );
  assert.match(
    html,
    /editableList\(\{/,
    'oneditprepare builds the list with Node-RED\'s stock editableList'
  );
  assert.match(
    html,
    /this\.additionalIdentities\s*=\s*RED\.mavlink\.normalizeIdentityIds\(raw,\s*primary\)/,
    'oneditsave routes through the shared, unit-tested normalizer — the '
      + 'blank/duplicate/primary rules are behaviorally covered in '
      + 'mavlink-editor-resource.test.js, not re-derived here'
  );
});

test('Connection editor does not expose heartbeat interval or UDP broadcast controls', () => {
  assert.ok(!html.includes('heartbeatInterval'), 'heartbeat interval belongs to Local Identity');
  assert.ok(!html.includes('node-config-input-broadcast'), 'SO_BROADCAST is not a Connection option');
  assert.ok(
    !/target_system\s*[=:]\s*0/.test(html),
    'UDP broadcast must not be conflated with MAVLink broadcast'
  );
});

test('Connection editor offers UDP, TCP, and serial without “not yet” stubs', () => {
  assert.match(html, /<option value="udp">UDP<\/option>/);
  assert.match(html, /<option value="tcp">TCP<\/option>/);
  assert.match(html, /<option value="serial">Serial<\/option>/);
  assert.ok(!html.includes('(not yet)'), 'transport options must not be stubbed');
  assert.match(html, /function refreshTransportRows/, 'mode toggles transport field rows');
  assert.match(html, /node-config-input-serialPath/, 'serial path field is present');
  assert.match(html, /node-config-input-baudRate/, 'baud field is present');
  assert.match(
    html,
    /serialPath:[\s\S]*validate:[\s\S]*mode !== 'serial'[\s\S]*trim\(\)\.length > 0/,
    'serial path is required in serial mode'
  );
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
