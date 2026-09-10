'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { assertChangeHandlerContains, loadNodeDefaults } = require('./html-assert');

const htmlPath = path.join(__dirname, '..', '..', 'nodes', 'mavlink-system.html');
const html = fs.readFileSync(htmlPath, 'utf8');

test('mavlink-system editor registers closed service and operation selectors', () => {
  const defaults = loadNodeDefaults('mavlink-system');
  assert.equal(defaults.service.value, 'logs');
  assert.equal(defaults.service.required, true);
  assert.equal(defaults.operation.value, 'list');
  assert.equal(defaults.operation.required, true);
  assert.equal(defaults.operation.validate.call({ service: 'logs' }, 'download', {}), true);
  assert.match(String(defaults.operation.validate.call({ service: 'logs' }, 'backup', {})), /one of/);
  assert.equal(defaults.operation.validate.call({ service: 'files' }, 'upload', {}), true);
  assert.match(String(defaults.operation.validate.call({ service: 'files' }, 'backup', {})), /one of/);
  assert.equal(defaults.operation.validate.call({ service: 'backup' }, 'backup', {}), true);
  assert.equal(defaults.operation.validate.call({ service: 'backup' }, 'restore', {}), true);
  assert.match(String(defaults.operation.validate.call({ service: 'backup' }, 'list', {})), /one of/);
  assert.equal(defaults.targetComponent.value, 1);
  assert.match(String(defaults.targetComponent.validate(0, {})), /between 1 and 255/);
});

test('mavlink-system conditionally validates log id, FTP path, and parameter encoding', () => {
  const defaults = loadNodeDefaults('mavlink-system', {
    connection: { vehicle: 'vehicle' },
    vehicle: { firmware: 'custom' },
  });
  assert.equal(defaults.logId.validate.call({ service: 'logs', operation: 'list' }, 'not-an-id', {}), true);
  assert.equal(defaults.logId.validate.call({ service: 'logs', operation: 'download' }, 7, {}), true);
  assert.match(String(defaults.logId.validate.call({ service: 'logs', operation: 'download' }, 1.5, {})), /integer/);
  assert.equal(defaults.path.validate.call({ service: 'files' }, '', {}), true);
  assert.equal(defaults.path.validate.call({ service: 'files' }, 'a'.repeat(239), {}), true);
  assert.match(String(defaults.path.validate.call({ service: 'files' }, 'a'.repeat(240), {})), /239/);
  assert.match(String(defaults.path.validate.call({ service: 'files' }, 'a\u0000b', {})), /NUL/);
  assert.equal(defaults.path.validate.call({ service: 'backup' }, 'a'.repeat(239), {}), true);
  assert.match(String(defaults.path.validate.call({ service: 'backup' }, 'a'.repeat(240), {})), /239/);
  assert.equal(defaults.path.validate.call({ service: 'logs' }, 'a'.repeat(300), {}), true);
  assert.equal(defaults.paramEncoding.validate.call({ service: 'logs' }, 'invalid', {}), true);
  assert.equal(defaults.paramEncoding.validate.call({ service: 'backup', connection: 'connection' }, 'auto', {}), true);
  assert.equal(defaults.paramEncoding.validate.call({ service: 'backup' }, 'auto', {}), true);
  assert.equal(defaults.paramEncoding.validate.call({ service: 'backup' }, 'bytewise', {}), true);
  assert.match(String(defaults.paramEncoding.validate.call({ service: 'backup' }, 'invalid', {})), /one of/);
});

test('mavlink-system help and editor expose each service contract', () => {
  assert.match(html, /data-template-name="mavlink-system"/);
  assert.match(html, /data-help-name="mavlink-system"/);
  assert.match(html, /LOG_DATA/);
  assert.match(html, /LOG_REQUEST_END/);
  assert.match(html, /\{id, size\}/);
  assert.match(html, /ArduPilot/);
  assert.match(html, /CREATE_FILE/);
  assert.match(html, /239 UTF-8 bytes/);
  assert.match(html, /parameters, fence, rally, and FTP/);
  assert.match(html, /root, directories, files:\[\{path, data\}\]/);
  assert.match(html, /base64 encoded/);
  assert.match(html, /the remaining sections still transfer/);
  assert.match(html, /<code>partial<\/code> rather than <code>succeeded<\/code>/);
  assert.match(html, /mission is not included/);
  assert.match(html, /no rollback/);
  assert.match(html, /msg\.payload/);
  assert.match(html, /Backup\/Restore/);
  assert.doesNotMatch(html, /value="parameters"|value="missions"|value="fences"|value="rally"/);
  assert.doesNotMatch(html, /\['backup', 'Backup files'\]/);
});

test('mavlink-system refreshes operation validation after rebuilding the select', () => {
  assert.match(
    html,
    /\$operation\.val\(selected\);\s*\$operation\.trigger\('change'\);/,
    'changing service must notify the shared enum validator of the preserved operation'
  );
});

test('mavlink-system companion hides sysid while keeping config compid visible', () => {
  assert.match(html, /RED\.mavlink\.applyCompanionTargetVisibility\(/);
  assert.match(html, /hideCompidWhenCompanion:\s*false/);
  assert.match(html, /targetSystemRow:\s*['"]#row-targetSystem['"]/);
  assert.match(html, /targetComponentRow:\s*['"]#row-targetComponent['"]/);
  assert.match(html, /id="row-targetSystem"/);
  assert.match(html, /id="row-targetComponent"/);
  assert.match(
    html,
    /\$\('#node-input-identity'\)\.on\('change',\s*refreshRows\)/,
    'identity changes refresh companion target visibility'
  );
  assertChangeHandlerContains(
    html,
    "$('#node-input-connection')",
    'refreshRows()',
    'connection changes refresh companion target visibility'
  );
});
