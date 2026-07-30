'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertChangeHandlerContains } = require('./html-assert');

test('assertChangeHandlerContains finds needle in the named callback only', () => {
  const html = `
    $('#node-input-delivery').on('change', function () {
      refreshVisibility();
      reloadTargetCompId();
    });
    $('#node-input-connection').on('change', function () {
      refreshVisibility();
    });
  `;
  assertChangeHandlerContains(html, "$('#node-input-delivery')", 'reloadTargetCompId()');
  assert.throws(
    () => assertChangeHandlerContains(html, "$('#node-input-connection')", 'reloadTargetCompId()'),
    /must contain reloadTargetCompId/
  );
});

test('assertChangeHandlerContains does not accept a later sibling reload', () => {
  const html = `
    $('#node-input-delivery').on('change', function () {
      refreshVisibility();
    });
    $('#node-input-connection').on('change', function () {
      reloadTargetCompId();
    });
  `;
  assert.throws(
    () => assertChangeHandlerContains(html, "$('#node-input-delivery')", 'reloadTargetCompId()'),
    /must contain reloadTargetCompId/
  );
});
