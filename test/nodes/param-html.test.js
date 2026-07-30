'use strict';

/**
 * Param editor: param-def catalog loads from the admin API (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-param.html'),
  'utf8'
);

test('param defs load from the mavlink/param/defs admin route', () => {
  assert.match(html, /function loadParamDefs/, 'param defs loader exists');
  assert.match(
    html,
    /RED\.mavlink\.adminApiUrl\(['"]\/mavlink\/param\/defs['"]\)/,
    'param defs catalog is loaded from admin API'
  );
});

test('admin catalog fetches use adminApiUrl (httpAdminRoot-safe)', () => {
  assert.match(html, /RED\.mavlink\.adminApiUrl\(/, 'admin fetches must use adminApiUrl');
  assert.ok(
    !/\$\.getJSON\(\s*['"]\/mavlink\//.test(html),
    'bare absolute /mavlink getJSON paths must be gone'
  );
});

test('mavlink-param target sysid/compid default to empty (inherit profile) not 1', () => {
  assert.match(html, /targetSystem:\s*\{\s*value:\s*''/, 'sysid default is empty string');
  assert.match(html, /targetComponent:\s*\{\s*value:\s*''/, 'compid default is empty string');
  assert.match(html, /placeholder="[^"]*profile default[^"]*"/, 'sysid has profile default placeholder');
  assert.match(html, /emptyLabel:\s*'[^']*profile default[^']*'/, 'compid empty label names profile default');
});

test('mavlink-param has vehicle and identity defaults', () => {
  assert.match(
    html,
    /vehicle:\s*\{\s*value:\s*''\s*,\s*type:\s*'mavlink-vehicle'/,
    'vehicle default with mavlink-vehicle type'
  );
  assert.match(
    html,
    /identity:\s*\{\s*value:\s*''\s*\}/,
    'identity default exists with empty value'
  );
});

test('mavlink-param calls fillIdentitySelect on connection change', () => {
  assert.match(html, /fillIdentitySelect/, 'fillIdentitySelect helper is called');
  assert.match(html, /node-input-identity/, 'identity select element exists');
});

test('mavlink-param firmware select is gone (§6 hidden is not honored)', () => {
  assert.ok(
    !html.includes('node-input-firmware'),
    'firmware input must not exist in param editor'
  );
  assert.ok(
    !/firmware:\s*\{\s*value:/.test(html),
    'firmware default must be removed from param defaults'
  );
});

test('mavlink-param has refreshVisibility and companion row hiding', () => {
  assert.match(html, /function refreshVisibility/, 'refreshVisibility function present');
  assert.match(html, /isCompanion/, 'companion role detected in visibility logic');
  assert.match(html, /row-targetSystem/, 'row-targetSystem referenced in visibility');
  assert.match(html, /row-targetComponent/, 'row-targetComponent referenced in visibility');
  assert.match(html, /row-vehicle/, 'row-vehicle present for build tier');
  assert.match(html, /row-connection/, 'row-connection present for wire tiers');
  assert.match(html, /row-identity/, 'row-identity present for wire tiers');
});

test('mavlink-param loadParamDefs is tier-aware (build uses vehicle, wire uses connection)', () => {
  // Build tier: reads vehicleId from #node-input-vehicle
  assert.match(html, /node-input-vehicle.*\.val\(\)|\.val\(\).*node-input-vehicle/s,
    'vehicle field used in defs load');
  // Wire tier: reads vehicleId through connection node
  assert.match(html, /connectionNode\.vehicle/, 'defs load reads vehicle through connection node');
  // Delivery-driven branch
  assert.match(html, /delivery.*===.*'build'|'build'.*===.*delivery/,
    'defs load is branched on delivery tier');
});

test('mavlink-param ensureConfigNodePicker called for vehicle', () => {
  assert.match(
    html,
    /ensureConfigNodePicker\(node,\s*'vehicle',\s*'mavlink-vehicle'/,
    'ensureConfigNodePicker invoked for vehicle field'
  );
});
