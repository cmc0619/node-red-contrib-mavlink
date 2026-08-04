'use strict';

/**
 * Fan-out editor: replicator controls only — no embedded action editor (§10).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-fanout.html'),
  'utf8'
);

test('fan-out is a replicator: the embedded action editor is gone (§10)', () => {
  // Message construction lives in the action nodes' Build tiers; none of the
  // per-action config may survive here.
  for (const gone of [
    'node-input-actionType',
    'node-input-commandId',
    'node-input-preset',
    'node-input-params',
    'node-input-carrier',
    'node-input-frame',
    'node-input-moveMode',
    'node-input-moveFrame',
    'node-input-north',
    'node-input-lat',
    'node-input-vNorth',
    'node-input-aNorth',
    'node-input-topic',
    'node-input-verb',
    'node-input-paramId',
    'node-input-paramType',
  ]) {
    assert.ok(!html.includes(gone), `${gone} must be gone from the replicator editor`);
  }
  // No Build+list dialect picker either: with no catalogs to serve, the
  // dialect/vehicle rows have no reason to exist.
  assert.ok(!html.includes('node-input-dialect'), 'dialect picker is gone');
  assert.ok(!html.includes('row-fanout-vehicle'), 'vehicle row is gone');
  assert.match(html, /Build-tier|built/i, 'help text names the built-message contract');
});

test('vehicleType is a MAV_TYPE select loaded from the shared catalog (§6)', () => {
  assert.match(
    html,
    /<select id="node-input-vehicleType">/,
    'Type filter must be a select dropdown'
  );
  assert.match(
    html,
    /RED\.mavlink\.loadCatalog\(\s*['"]\/mavlink\/build\/messages['"]/,
    'dialect enum catalog uses shared loadCatalog'
  );
  assert.match(html, /enums\.MAV_TYPE/, 'MAV_TYPE table is read from the catalog');
  assert.match(html, /RED\.mavlink\.fillEnumSelect\(/, 'options are built via shared fillEnumSelect');
  assert.match(html, /Any type/, 'empty selection means any vehicle type');
  assert.match(html, /var prefer = sel\.val\(\)/, 'in-progress selection wins over saved');
  assert.match(html, /saved:\s*prefer/, 'prefer is passed to fillEnumSelect');
});

test('firmware filter is a small select (ArduPilot/PX4/custom)', () => {
  assert.match(html, /<select id="node-input-firmwareFilter">/);
  assert.match(html, /<option value="ardupilot">ArduPilot<\/option>/);
  assert.match(html, /<option value="px4">PX4<\/option>/);
  assert.match(html, /<option value="custom">Custom<\/option>/);
});

test('admin catalog fetches go through shared loadCatalog (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.loadCatalog\(/, 'catalog fetches use shared loadCatalog');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});

test('identity defaults to empty string and refreshIdentitySelect uses gcs+custom filter (§6)', () => {
  assert.match(
    html,
    /identity:\s*\{\s*value:\s*''\s*\}/,
    'identity property defaults to empty string'
  );
  assert.match(
    html,
    /RED\.mavlink\.refreshIdentitySelect\(node,\s*\{\s*rolesAllowed:\s*\[\s*['"]gcs['"]\s*,\s*['"]custom['"]\s*\]\s*\}\)/,
    'shared refreshIdentitySelect is called with gcs+custom filter'
  );
  assert.match(
    html,
    /<select id="node-input-identity"/,
    'Send-as identity field is a plain <select>'
  );
  assert.doesNotMatch(html, /function refreshIdentitySelect/, 'no local identity-refresh copy');
});

test('identity is re-filled when connection selection changes', () => {
  const changeHandlerMatch = html.match(
    /#node-input-connection['"]\)\.on\(['"]change['"][^)]*\)\s*\{([\s\S]*?)\}/
  );
  assert.ok(
    changeHandlerMatch && /refreshIdentitySelect/.test(changeHandlerMatch[0]),
    'refreshIdentitySelect is called inside the connection change handler'
  );
});

test('sysids field validates each token as a MAVLink sysid (1..255)', () => {
  assert.match(
    html,
    /sysids:\s*\{[\s\S]*?validate:\s*function/,
    'sysids declares an editor validate function'
  );
  assert.match(html, /n >= 1 && n <= 255/, 'validator bounds each token to 1..255');
});

test('concurrency is a bounded integer with a strictly-sequential default of 1', () => {
  assert.match(html, /concurrency:\s*\{[\s\S]*?value:\s*1/, 'concurrency defaults to 1');
  assert.match(html, /Number\.isInteger\(n\) && n >= 1/, 'validator requires an integer ≥ 1');
  assert.match(html, /id="node-input-concurrency"/, 'concurrency field exists in the template');
});

test('rows reshape by selection, execution, and delivery (§6)', () => {
  assert.match(html, /function refreshVisibility/, 'refreshVisibility drives the reshape');
  assert.match(html, /\$\('#row-fanout-sysids'\)\.toggle\(sel === 'list'\)/, 'sysids only for list selection');
  assert.match(html, /\$\('#row-fanout-typeFilter'\)\.toggle\(sel === 'filter'\)/, 'type filter only for filter selection');
  assert.match(html, /\$\('#row-fanout-interval'\)\.toggle\(exec === 'sequential'\)/, 'interval only for sequential');
  assert.match(
    html,
    /\$\('#row-fanout-concurrency'\)\.toggle\(exec === 'sequential' && d === 'confirm'\)/,
    'concurrency only where confirm waits can overlap'
  );
  assert.match(html, /\$\('#row-fanout-timeout'\)\.toggle\(d === 'confirm'\)/, 'timeout only for confirm tier');
  assert.match(html, /\$\('#row-fanout-retries'\)\.toggle\(d === 'confirm'\)/, 'retries only for confirm tier');
  assert.match(
    html,
    /\$\('#row-fanout-identity'\)\.toggle\(d !== 'build'\)/,
    'identity row is hidden when delivery is build (source ids stamped at the wire)'
  );
  for (const handler of ['delivery', 'selectionMode', 'executionMode']) {
    assert.match(
      html,
      new RegExp(`#node-input-${handler}['"]\\)\\.on\\(['"]change['"],\\s*refreshVisibility\\)`),
      `${handler} change refreshes visibility`
    );
  }
});

test('delivery offers build, send, and send-and-confirm', () => {
  assert.match(html, /<option value="build">Build<\/option>/);
  assert.match(html, /<option value="send">Send<\/option>/);
  assert.match(html, /<option value="confirm">Send and confirm<\/option>/);
});

test('help documents targets patches as wire units and the mavlink-out handoff', () => {
  assert.match(html, /wire units/i, 'raw-surface unit rule is stated');
  assert.match(html, /mavlink-out/, 'Build handoff to mavlink-out is documented');
  assert.match(html, /\{message, targets/, 'wrapper shape is documented');
});
