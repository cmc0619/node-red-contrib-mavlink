'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadNodeDefaults } = require('./html-assert');

const htmlPath = path.join(__dirname, '..', '..', 'nodes', 'mavlink-log.html');

test('mavlink-log editor registers the list/download contract', () => {
  const defaults = loadNodeDefaults('mavlink-log');
  assert.equal(defaults.operation.value, 'list');
  assert.equal(defaults.logId.validate.call({ operation: 'list' }, 'not-an-id', {}), true);
  assert.equal(defaults.logId.validate.call({ operation: 'download' }, 7, {}), true);
  assert.match(String(defaults.logId.validate.call({ operation: 'download' }, 1.5, {})), /integer/);
  assert.equal(defaults.targetComponent.value, 1);
  assert.match(String(defaults.targetComponent.validate(0, {})), /between 1 and 255/);
});

test('mavlink-log help and editor expose Buffer delivery and protocol EOF', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /font-awesome\/fa-arrow-down/);
  assert.match(html, /msg\.logId/);
  assert.match(html, /LOG_DATA/);
  assert.match(html, /LOG_REQUEST_END/);
});
