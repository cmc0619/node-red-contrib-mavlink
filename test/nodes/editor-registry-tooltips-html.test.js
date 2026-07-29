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

test('fillEnumSelect applies entry.description as option title', () => {
  const html = readHtml('mavlink-local-identity');
  assert.match(html, /if \(entry\.description\) \$opt\.attr\('title', entry\.description\)/);
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

test('Payload editor loads field tips from /mavlink/payload/field-tips', () => {
  const html = readHtml('mavlink-payload');
  assert.match(html, /\/mavlink\/payload\/field-tips/);
  assert.match(html, /refreshPayloadFieldTips/);
  assert.match(html, /RED\.mavlink\.applyFieldTitle/);
  // Sequence is a tip target — description comes from the dialect join, not HTML.
  assert.match(html, /['"]sequence['"]/);
  assert.match(html, /node-input-sequence/);
});

test('shared applyFieldTitle helper lives on RED.mavlink', () => {
  const html = readHtml('mavlink-local-identity');
  assert.match(html, /RED\.mavlink\.applyFieldTitle\s*=\s*function/);
});

test('Payload catalogQuery unwraps Connection vehicle snapshot id', () => {
  const html = readHtml('mavlink-payload');
  assert.match(html, /RED\.mavlink\.vehicleIdFrom/);
  const shared = readHtml('mavlink-local-identity');
  assert.match(shared, /RED\.mavlink\.vehicleIdFrom\s*=\s*function/);
});

test('Command preset controls render before tip catalog arrives', () => {
  const html = readHtml('mavlink-command');
  // Controls append before loadCommandsCatalog; tips attach afterward.
  assert.match(
    html,
    /container\.append\(rows\[rows\.length - 1\]\.row\);[\s\S]*loadCommandsCatalog\(function/
  );
  assert.match(html, /const seq = \+\+_catalogRequestSeq;/);
});
