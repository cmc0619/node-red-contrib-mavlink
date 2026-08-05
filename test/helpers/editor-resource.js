'use strict';

/**
 * Evaluate the shared editor helpers (`resources/mavlink-editor.js`) into a VM
 * context so node-dialog tests exercise the real `RED.mavlink`.
 *
 * Stubbing a helper the test depends on for its *result* — `resolveCatalogTarget`
 * above all — would put a second implementation of the definition-set key in the
 * suite, and the property worth proving is that the key a load writes is the key
 * a validation reads. Two implementations cannot prove that about one.
 *
 * Helpers a test does not exercise may still be overridden afterwards: assign
 * over `context.RED.mavlink` once the real ones are installed.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const resourceScript = fs.readFileSync(
  path.join(__dirname, '..', '..', 'resources', 'mavlink-editor.js'),
  'utf8'
);

/**
 * @param {object} context  VM context carrying at least `RED` and `$`
 * @returns {object} the same context, with `RED.mavlink` populated
 */
function installEditorHelpers(context) {
  if (!context.RED) context.RED = {};
  if (!context.RED.mavlink) context.RED.mavlink = {};
  if (!context.RED.settings) context.RED.settings = { httpAdminRoot: '/' };
  vm.runInNewContext(resourceScript, context);
  return context;
}

module.exports = { resourceScript, installEditorHelpers };
