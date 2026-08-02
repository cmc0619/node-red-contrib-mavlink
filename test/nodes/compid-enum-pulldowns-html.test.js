'use strict';

/**
 * MAV_COMPONENT enum pulldowns across palette/config editors (§6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'nodes');

function readHtml(name) {
  return fs.readFileSync(path.join(ROOT, `${name}.html`), 'utf8');
}

const TARGET_COMP_NODES = [
  'mavlink-mission',
  'mavlink-move',
  'mavlink-param',
  'mavlink-payload',
];

for (const name of TARGET_COMP_NODES) {
  test(`${name}: targetComponent is a MAV_COMPONENT select`, () => {
    const html = readHtml(name);
    assert.match(html, /<select id="node-input-targetComponent">/);
    assert.ok(
      !html.includes('type="number" id="node-input-targetComponent"'),
      'numeric targetComponent input must be gone'
    );
    // Build-tier senders use the shared reloadCompIdSelect (pin-safe + sequenced).
    assert.match(html, /reloadCompIdSelect\(/);
    assert.match(html, /node-input-targetComponent/);
  });
}

test('mavlink-vehicle: defaultTargetComponent is a MAV_COMPONENT select', () => {
  const html = readHtml('mavlink-vehicle');
  assert.match(html, /<select id="node-config-input-defaultTargetComponent">/);
  assert.ok(!html.includes('type="number" id="node-config-input-defaultTargetComponent"'));
  assert.match(html, /loadEnumsCatalog\(\['MAV_COMPONENT'\]/);
  assert.match(html, /fillCompIdSelect\(/);
});

test('mavlink-build: target_component field uses a MAV_COMPONENT select (§6)', () => {
  const html = readHtml('mavlink-build');
  assert.match(html, /spec\.name === ['"]target_component['"]/);
  assert.match(
    html,
    /reloadCompIdSelect\(/,
    'Build reuses the shared CompID reload helper'
  );
  assert.doesNotMatch(
    html,
    /loadEnumsCatalog\(\['MAV_COMPONENT'\]/,
    'no parallel local MAV_COMPONENT fetch'
  );
});

test('mavlink-command: static targetCompid is a MAV_COMPONENT select only', () => {
  const html = readHtml('mavlink-command');
  assert.match(html, /<select id="node-input-targetCompid"/);
  assert.ok(!html.includes('type="number" id="node-input-targetCompid"'));
  assert.match(html, /reloadCompIdSelect\([\s\S]*targetCompid/);
});

test('mavlink-state: filter targetComponent allows blank = any', () => {
  const html = readHtml('mavlink-state');
  assert.match(html, /<select id="node-input-targetComponent">/);
  assert.ok(!html.includes('type="number" id="node-input-targetComponent"'));
  assert.match(html, /loadEnumsCatalog\(\['MAV_COMPONENT'\]/);
  assert.match(html, /allowEmpty:\s*true[\s\S]*Any component/);
});

test('mavlink-in: compid filter is a MAV_COMPONENT select', () => {
  const html = readHtml('mavlink-in');
  assert.match(html, /<select id="node-input-compid"/);
  assert.ok(!html.includes('id="node-input-compid" placeholder="blank = all"'));
  assert.match(html, /loadEnumsCatalog\(\['MAV_COMPONENT'\]/);
  assert.match(html, /fillCompIdSelect\([\s\S]*node-input-compid/);
  assert.match(html, /allowEmpty:\s*true[\s\S]*Any component/);
});

test('mavlink-local-identity: HB enums and source CompID use selects; SysID stays numeric', () => {
  const html = readHtml('mavlink-local-identity');
  assert.match(html, /<select id="node-config-input-sourceComponentId">/);
  assert.match(html, /<select id="node-config-input-heartbeatType">/);
  assert.match(html, /<select id="node-config-input-heartbeatAutopilot">/);
  assert.match(html, /type="number" id="node-config-input-sourceSystemId"/);
  assert.match(
    html,
    /loadEnumsCatalog\(\['MAV_TYPE',\s*'MAV_AUTOPILOT',\s*'MAV_COMPONENT'\]/
  );
  assert.match(html, /valueKey:\s*'name'/);
  assert.match(html, /enums\.MAV_TYPE/);
  assert.match(html, /enums\.MAV_AUTOPILOT/);
  assert.match(html, /enums\.MAV_COMPONENT/);
});
