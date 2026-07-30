'use strict';

/**
 * Swarm editor: vehicleType is a MAV_TYPE enum <select> (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-swarm.html'),
  'utf8'
);

test('vehicleType is a MAV_TYPE select, not a free-form number (§6)', () => {
  assert.match(
    html,
    /<select id="node-input-vehicleType">/,
    'Type filter must be a select dropdown'
  );
  assert.ok(
    !html.includes('type="number" id="node-input-vehicleType"'),
    'the free-form numeric type filter must be gone'
  );
});

test('vehicleType loads MAV_TYPE entries from the build/messages catalog', () => {
  assert.match(html, /RED\.mavlink\.adminApiUrl\(['"]\/mavlink\/build\/messages['"]\)/, 'dialect enum catalog is loaded from admin API');
  assert.match(html, /enums\.MAV_TYPE/, 'MAV_TYPE table is read from the catalog');
  assert.match(html, /function buildVehicleTypeDropdown/, 'dropdown is rebuilt from catalog entries');
  assert.match(html, /entry\.label/, 'option labels come from the catalog (value in parentheses)');
  assert.match(html, /Any type/, 'empty selection means any vehicle type');
});

test('vehicleType preserves the saved numeric value after async catalog load', () => {
  assert.match(html, /node\.vehicleType/, 'saved vehicleType is re-applied');
  assert.match(html, /const prefer = current \|\| saved|var prefer = current \|\| saved/, 'in-progress selection wins over saved');
  assert.match(html, /not in dialect/, 'unknown saved values remain selectable');
  assert.match(html, /_msgRequestSeq/, 'stale catalog responses are ignored');
  // Cache hits must bump the seq before returning so in-flight requests cannot overwrite.
  assert.match(
    html,
    /var seq = \+\+_msgRequestSeq;\s*if \(_msgCatalogByKey\[target\.key\]\)/,
    'cached catalog path invalidates pending requests'
  );
});

test('firmware filter is already a small select (ArduPilot/PX4/custom)', () => {
  assert.match(html, /<select id="node-input-firmwareFilter">/);
  assert.match(html, /<option value="ardupilot">ArduPilot<\/option>/);
  assert.match(html, /<option value="px4">PX4<\/option>/);
  assert.match(html, /<option value="custom">Custom<\/option>/);
});

test('commandId is a MAV_CMD <select>, not a free-form number (§6)', () => {
  assert.match(
    html,
    /<select id="node-input-commandId"/,
    'Command id must be a select dropdown'
  );
  assert.ok(
    !html.includes('type="number" id="node-input-commandId"'),
    'the free-form numeric command field must be gone'
  );
});

test('commandId loads MAV_CMD entries from command/commands catalog', () => {
  assert.match(html, /RED\.mavlink\.adminApiUrl\(['"]\/mavlink\/command\/commands['"]\)/, 'dialect MAV_CMD catalog is loaded from admin API');
  assert.match(html, /function buildCommandDropdown/, 'dropdown is rebuilt from catalog entries');
  assert.match(html, /entry\.label/, 'option labels come from the catalog (MAV_CMD_… (n))');
  assert.match(html, /entry\.value/, 'option values are numeric command ids');
  assert.match(html, /_cmdRequestSeq/, 'stale command catalog responses are ignored');
});

test('commandId preserves the saved numeric value after async catalog load', () => {
  assert.match(html, /node\.commandId/, 'saved commandId is re-applied');
  assert.match(html, /not in dialect/, 'unknown saved values remain selectable');
});

test('admin catalog fetches use adminApiUrl (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.adminApiUrl\(/, 'admin fetches must use adminApiUrl');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});

test('identity defaults to empty string and fillIdentitySelect is called with gcs+custom filter (§6)', () => {
  assert.match(
    html,
    /identity:\s*\{\s*value:\s*''\s*\}/,
    'identity property defaults to empty string'
  );
  assert.match(
    html,
    /RED\.mavlink\.fillIdentitySelect\(/,
    'fillIdentitySelect is called to populate the Send-as dropdown'
  );
  assert.match(
    html,
    /rolesAllowed.*\[.*['"]gcs['"].*,.*['"]custom['"]/,
    "rolesAllowed filters to ['gcs','custom'] (gcs-paradigm by nature, §6)"
  );
  assert.match(
    html,
    /<select id="node-input-identity"/,
    'Send-as identity field is a plain <select>'
  );
  assert.match(
    html,
    /node\.identity/,
    'saved identity is passed to fillIdentitySelect as the saved option'
  );
});

test('connection row hidden only for build+list; identity row hidden for build delivery (§6 exception)', () => {
  assert.match(
    html,
    /d === 'build' && sel === 'list'/,
    'build+list condition governs connection-row visibility'
  );
  assert.match(html, /row-swarm-connection/, 'connection row has an id for visibility toggling');
  assert.match(html, /row-swarm-identity/, 'identity row has an id for visibility toggling');
  assert.match(
    html,
    /d !== 'build'/,
    'identity row is hidden when delivery is build (source ids stamped at the wire)'
  );
});

test('identity is re-filled when connection selection changes', () => {
  assert.match(
    html,
    /refreshIdentitySelect/,
    'refreshIdentitySelect helper is defined'
  );
  assert.match(
    html,
    /#node-input-connection.*change|change.*#node-input-connection/,
    'connection change event handler is wired'
  );
  // The connection change handler must call refreshIdentitySelect.
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

test('refreshVisibility is wired to both delivery and selectionMode changes', () => {
  assert.match(
    html,
    /function refreshVisibility/,
    'refreshVisibility function is defined'
  );
  assert.match(
    html,
    /#node-input-delivery.*change.*refreshVisibility|refreshVisibility.*#node-input-delivery.*change/,
    'delivery change is wired to refreshVisibility'
  );
  assert.match(
    html,
    /#node-input-selectionMode.*change.*refreshVisibility|refreshVisibility.*#node-input-selectionMode.*change/,
    'selectionMode change is wired to refreshVisibility'
  );
});
