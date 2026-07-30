'use strict';

/**
 * DESIGN.md §6 — descriptions ride as tooltips, sourced from the dialect
 * registry / admin catalogs. No baked description strings in editor HTML.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'nodes');

function readHtml(name) {
  return fs.readFileSync(path.join(ROOT, `${name}.html`), 'utf8');
}

// Shared RED.mavlink.* helpers now live in the stock resource file (DESIGN.md §6).
const resourceScript = fs.readFileSync(
  path.join(__dirname, '..', '..', 'resources', 'mavlink-editor.js'),
  'utf8'
);

test('fillEnumSelect applies entry.description as option title', () => {
  assert.match(resourceScript, /if \(entry\.description\) \$opt\.attr\('title', entry\.description\)/);
});

test('Build message and MAV_CMD selects title from catalog descriptions', () => {
  const html = readHtml('mavlink-build');
  assert.match(html, /if \(m\.description\) \$opt\.attr\('title', m\.description\)/);
  assert.match(html, /if \(c\.description\) \$opt\.attr\('title', c\.description\)/);
  assert.match(html, /function syncMsgTitle/);
  assert.match(html, /function syncCmdTitle/);
  // Field controls already use spec.description (pre-existing).
  assert.match(html, /\.attr\('title',\s*(?:multi \? bitmaskTitle\(spec\.description\) : \(spec\.description \|\| ''\))/);
});

test('Command Advanced MAV_CMD select and enum options use catalog descriptions', () => {
  const html = readHtml('mavlink-command');
  assert.match(html, /if \(c\.description\) \$opt\.attr\('title', c\.description\)/);
  assert.match(html, /function syncAdvancedTitle/);
  assert.match(html, /if \(entry\.description\) \$opt\.attr\('title', entry\.description\)/);
  assert.match(html, /catalogParamByIndex/);
  assert.match(html, /catParam\.description/);
});

test('In / Swarm message and command selects use catalog descriptions', () => {
  const inn = readHtml('mavlink-in');
  assert.match(inn, /if \(entry\.description\) \$opt\.attr\('title', entry\.description\)/);
  assert.match(inn, /function syncMessageTitle/);

  const swarm = readHtml('mavlink-swarm');
  assert.match(swarm, /if \(entry\.description\) \$opt\.attr\('title', entry\.description\)/);
  assert.match(swarm, /function syncCmdTitle/);
  assert.match(swarm, /function syncTypeTitle/);
});

test('Param node titles come from loaded param defs, not baked HTML', () => {
  const html = readHtml('mavlink-param');
  assert.match(html, /#node-input-paramId'\)\.attr\('title', def\.description\)/);
  assert.match(html, /#node-input-value'\)\.attr\('title', def\.description\)/);
  assert.ok(
    !/<input[^>]*id="node-input-paramId"[^>]*title="/.test(html),
    'paramId must not bake a static title into the template'
  );
});

test('Payload template has no baked MAVLink description titles', () => {
  const html = readHtml('mavlink-payload');
  const template = html.split('data-template-name="mavlink-payload"')[1] || '';
  const titles = [...template.matchAll(/\btitle="([^"]*)"/g)].map((m) => m[1]);
  for (const tip of titles) {
    assert.ok(
      !/Capture sequence|IMAGE_START|GIMBAL_MANAGER|metres north|NED frame/i.test(tip),
      `unexpected baked protocol tooltip: ${tip}`
    );
  }
});

test('Payload template does not bake protocol unit suffixes on value fields', () => {
  const html = readHtml('mavlink-payload');
  const template = html.split('data-template-name="mavlink-payload"')[1] || '';
  // Dialect units are applied via applyFieldUnits; keep only Node-RED config units
  // like ACK timeout "ms" if present outside tip fields.
  assert.ok(
    !/node-input-interval"[^>]*>\s*s\b/.test(template),
    'interval must not bake trailing "s"'
  );
  assert.ok(
    !/node-input-distance"[^>]*>\s*m\b/.test(template),
    'distance must not bake trailing "m"'
  );
  assert.ok(
    !/node-input-pitch"[^>]*>\s*deg\b/.test(template),
    'pitch must not bake trailing "deg"'
  );
});

test('Payload editor loads field tips from /mavlink/payload/field-tips', () => {
  const html = readHtml('mavlink-payload');
  assert.match(html, /\/mavlink\/payload\/field-tips/);
  assert.match(html, /refreshPayloadFieldTips/);
  assert.match(html, /RED\.mavlink\.applyFieldMeta/);
  // Sequence is a tip target — description comes from the dialect join, not HTML.
  assert.match(html, /['"]sequence['"]/);
  assert.match(html, /node-input-sequence/);
});

test('shared applyFieldTitle / applyFieldUnits / applyFieldMeta helpers live on RED.mavlink', () => {
  assert.match(resourceScript, /RED\.mavlink\.applyFieldTitle\s*=\s*function/);
  assert.match(resourceScript, /RED\.mavlink\.applyFieldUnits\s*=\s*function/);
  assert.match(resourceScript, /RED\.mavlink\.applyFieldMeta\s*=\s*function/);
});

test('Payload catalogQuery reuses shared currentCatalogQuery', () => {
  const html = readHtml('mavlink-payload');
  assert.match(html, /RED\.mavlink\.currentCatalogQuery/);
  assert.match(resourceScript, /RED\.mavlink\.currentCatalogQuery\s*=\s*currentEnumQuery/);
  assert.match(resourceScript, /RED\.mavlink\.vehicleIdFrom\s*=\s*function/);
});

test('Payload TIP_FIELDS excludes enum selects driven by fillEnumSelect', () => {
  const html = readHtml('mavlink-payload');
  const tipBlock = html.match(/var TIP_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(tipBlock, 'TIP_FIELDS declaration');
  assert.ok(!/['"]modeValue['"]/.test(tipBlock[1]), 'modeValue stays on fillEnumSelect');
  assert.ok(!/['"]actionValue['"]/.test(tipBlock[1]), 'actionValue stays on fillEnumSelect');
  assert.match(tipBlock[1], /['"]sequence['"]/);
});

test('Command preset controls render before tip catalog arrives', () => {
  const html = readHtml('mavlink-command');
  // Controls append before loadCommandsCatalog; tips attach afterward.
  assert.match(
    html,
    /container\.append\(rows\[rows\.length - 1\]\.row\);[\s\S]*loadCommandsCatalog\(function/
  );
  assert.match(html, /\+\+_catalogRequestSeq;/);
});

test('Command catalog loads coalesce waiters per target key', () => {
  const html = readHtml('mavlink-command');
  assert.match(html, /_catalogInflight/);
  // Second consumer for the same key joins the in-flight queue (no second HTTP).
  assert.match(html, /_catalogInflight\[requestedKey\]\.push\(cb\)/);
  // Both waiters receive the resolved catalog (CodeRabbit #36 concurrent consumers).
  assert.match(
    html,
    /for \(let i = 0; i < waiters\.length; i\+\+\) waiters\[i\]\(catalog\)/
  );
  assert.match(html, /resolveCatalogTarget\(\)\.key !== requestedKey/);
});

test('Command reapplies preset option tips when Connection / Vehicle changes', () => {
  const html = readHtml('mavlink-command');
  assert.match(html, /function applyPresetOptionTips/);
  assert.match(html, /function refreshPresetTipsAndParams/);
  // One catalog load paints tips then refreshParamFields (cache hit) — no race.
  assert.match(
    html,
    /loadCommandsCatalog\(function \(catalog\) \{[\s\S]*applyPresetOptionTips\(null, catalog\);[\s\S]*refreshParamFields\(\);/
  );
  assert.match(
    html,
    /#node-input-connection'\)\.on\('change'[\s\S]*refreshPresetTipsAndParams\(\)/
  );
});
