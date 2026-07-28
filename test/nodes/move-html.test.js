'use strict';

/**
 * mavlink-move editor: mode/delivery-driven field visibility (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-move.html'),
  'utf8'
);

const ROW_IDS = [
  'row-move-north',
  'row-move-east',
  'row-move-up',
  'row-move-lat',
  'row-move-lon',
  'row-move-alt',
  'row-move-vNorth',
  'row-move-vEast',
  'row-move-vUp',
  'row-move-yaw',
  'row-move-yawRate',
  'row-move-interval',
  'row-move-ttl',
];

test('mavlink-move editor reshapes fields by mode and delivery (§6)', () => {
  assert.match(html, /function refreshVisibility/, 'mode/delivery drive row visibility');
  assert.match(
    html,
    /\$\('#node-input-mode'\)\.on\('change', refreshVisibility\)/,
    'mode change refreshes visibility'
  );
  assert.match(
    html,
    /\$\('#node-input-delivery'\)\.on\('change', refreshVisibility\)/,
    'delivery change refreshes visibility'
  );
  assert.match(html, /refreshVisibility\(\)/, 'visibility is applied on dialog open');

  for (const id of ROW_IDS) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} row must exist`);
  }

  assert.match(html, /mode === 'local-position'/, 'local position fields gated on mode');
  assert.match(html, /mode === 'local-velocity'/, 'local velocity fields gated on mode');
  assert.match(html, /mode === 'global-position'/, 'global position fields gated on mode');
  assert.match(html, /delivery === 'stream'/, 'stream interval and TTL gated on delivery');
});

test('mavlink-move has one labeled row per parameter, not dual local/global rows', () => {
  assert.ok(
    !html.includes('North / Lat'),
    'dual North / Lat label must be gone'
  );
  assert.ok(
    !html.includes('East / Lon'),
    'dual East / Lon label must be gone'
  );
  assert.ok(
    !html.includes('Up / Alt'),
    'dual Up / Alt label must be gone'
  );
  assert.match(html, /Metres north/, 'north has its own label');
  assert.match(html, /Degrees lat/, 'lat has its own label');
  assert.match(html, /North m\/s/, 'vNorth has its own label');

  for (const id of ['node-input-north', 'node-input-lat', 'node-input-vNorth']) {
    const rowPattern = new RegExp(
      `<div class="form-row"[^>]*>[\\s\\S]*?id="${id}"`,
      'm'
    );
    const matches = html.match(new RegExp(rowPattern, 'g')) || [];
    assert.equal(matches.length, 1, `${id} must appear on exactly one form-row`);
  }
});

test('mavlink-move keeps target sysid/compid and MAV_COMPONENT catalog', () => {
  assert.match(html, /id="node-input-targetSystem"/, 'target sysid field remains');
  assert.match(html, /id="node-input-targetComponent"/, 'target compid select remains');
  assert.match(html, /MAV_COMPONENT/, 'compid enum catalog is loaded');
  assert.match(html, /fillCompIdSelect/, 'compid select uses shared helper');
  assert.match(html, /ensureConfigNodePicker/, 'connection picker remains');
});
