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

const { loadNodeDefaults } = require('./html-assert');

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

test('Connection editor keeps swarm delivery separate from MAVLink addressing', () => {
  assert.ok(!html.includes('heartbeatInterval'), 'heartbeat interval belongs to Local Identity');
  // The Swarm address is a *delivery* option — where a `target_system = 0`
  // frame is written. It is not what makes a frame a broadcast; the message
  // field is. The form must offer no control for it, while the help text is
  // the right place to say so out loud.
  const [form, help] = html.split(/<script type="text\/html" data-help-name=/);
  assert.ok(help, 'help block is present');
  assert.ok(
    !/target_system\s*[=:]\s*0/.test(form),
    'no form control may present MAVLink broadcast addressing as a Connection setting'
  );
  assert.match(
    help,
    /target_system = 0[\s\S]{0,200}not a setting here/,
    'help must say plainly that addressing is a frame field, not this dialog'
  );
  assert.ok(
    !/SO_BROADCAST/.test(html),
    'the socket flag is an implementation detail of the address, not a user control'
  );
  assert.match(
    html,
    /row-conn-broadcastHost[\s\S]*toggle\(mode === 'udp'\)/,
    'swarm address is UDP-only — TCP has no broadcast at all'
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

test('remote host/port pairing: one without the other reds, both-or-neither passes', () => {
  // These drive the REAL validators — the html script evaluated whole, the
  // real RED.mavlink resource underneath — with no dialog open, which is the
  // state Node-RED validates in on import and on deploy: the saved config is
  // all there is. The runtime trusts this rule (udp.js sends only with both).
  const defaults = loadNodeDefaults('mavlink-connection');
  const reason = /Remote host and port are a pair/;

  // host set + port blank → reason on the host field
  assert.match(
    String(defaults.remoteHost.validate.call(
      { id: 'c1', mode: 'udp', remotePort: '' }, '10.0.0.9', {}
    )),
    reason
  );
  // port set + host blank → reason on the port field
  assert.match(
    String(defaults.remotePort.validate.call(
      { id: 'c1', mode: 'udp', remoteHost: '' }, '14551', {}
    )),
    reason
  );
  // both blank → listen-only, valid on both fields
  assert.equal(
    defaults.remoteHost.validate.call({ id: 'c1', mode: 'udp', remotePort: '' }, '', {}),
    true
  );
  assert.equal(
    defaults.remotePort.validate.call({ id: 'c1', mode: 'udp', remoteHost: '' }, '', {}),
    true
  );
  // both set → valid on both fields
  assert.equal(
    defaults.remoteHost.validate.call(
      { id: 'c1', mode: 'udp', remotePort: '14551' }, '10.0.0.9', {}
    ),
    true
  );
  assert.equal(
    defaults.remotePort.validate.call(
      { id: 'c1', mode: 'udp', remoteHost: '10.0.0.9' }, '14551', {}
    ),
    true
  );
  // serial mode hides the fields, so a stale half-pair must not red a
  // control the operator cannot see (same gate as bindPort).
  assert.equal(
    defaults.remoteHost.validate.call(
      { id: 'c1', mode: 'serial', remotePort: '' }, '10.0.0.9', {}
    ),
    true
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
