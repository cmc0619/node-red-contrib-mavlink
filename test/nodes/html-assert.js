'use strict';

/**
 * Shared HTML-source assertions for Node-RED editor wiring tests.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Assert that `binder.on('change', function () { ... })` contains `needle`
 * inside that callback only (brace-balanced), not a later sibling handler.
 *
 * @param {string} html
 * @param {string} binder  e.g. "$('#node-input-delivery')" or "$dialect"
 * @param {string} needle
 * @param {string} [msg]
 */
function assertChangeHandlerContains(html, binder, needle, msg) {
  const escaped = binder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(
    `${escaped}\\.on\\('change(?:\\.[^']*)?',\\s*function\\s*\\(\\)\\s*\\{`
  );
  const m = startRe.exec(html);
  assert.ok(m, msg || `change handler for ${binder} must exist`);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < html.length && depth > 0) {
    const c = html[i++];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
  }
  assert.equal(depth, 0, msg || `change handler for ${binder} must be brace-balanced`);
  const body = html.slice(m.index + m[0].length, i - 1);
  assert.ok(
    body.includes(needle),
    msg || `${binder} change handler must contain ${needle}`
  );
}


/**
 * Execute a node's editor script and return the `defaults` object it actually
 * registered.
 *
 * Source greps answer "is the shared factory mentioned"; they cannot answer
 * "did its descriptor survive into defaults". A node can call
 * `buildTierDialectDefaults()` for its dialect/vehicle rules and still lose the
 * shared `connection` — by declaring its own after the merge, or by merging in
 * the wrong argument order — and a grep sees nothing wrong. That is the exact
 * regression the shared descriptor exists to prevent, so the test has to run
 * the merge rather than read around it.
 *
 * The shared resource is executed first in the same context, so
 * `RED.mavlink.*` is populated the way the browser populates it.
 *
 * @param {string} nodeName  e.g. 'mavlink-build'
 * @param {object} [nodeLookup]  ids visible to RED.nodes.node()
 * @returns {object} the registered `defaults`
 */
function loadNodeDefaults(nodeName, nodeLookup = {}) {
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'nodes', `${nodeName}.html`), 'utf8');
  const start = html.indexOf('<script type="text/javascript">');
  assert.ok(start >= 0, `${nodeName}.html must have an editor script block`);
  const open = html.indexOf('>', start) + 1;
  const end = html.indexOf('</script>', open);
  const script = html.slice(open, end);

  const registered = {};
  function $() {
    // No dialog is open: every live-field lookup misses, which is the state
    // Node-RED validates in on import and on deploy.
    return { length: 0, val() { return undefined; }, toggle() { return this; }, empty() { return this; },
      append() { return this; }, on() { return this; }, each() { return this; }, find() { return this; },
      attr() { return this; }, text() { return this; }, prop() { return this; }, is() { return false; },
      css() { return this; }, replaceWith() { return this; }, next() { return { length: 0 }; } };
  }
  $.getJSON = () => ({ fail() { return this; } });
  $.ajax = () => ({ done() { return this; }, fail() { return this; } });

  const context = {
    RED: {
      settings: { httpAdminRoot: '/' },
      mavlink: {},
      validators: { number: () => () => true, regex: () => () => true },
      _: (k) => k,
      editor: {},
      nodes: {
        registerType(name, def) { registered[name] = def; },
        getType: (t) => (/^mavlink-/.test(t) ? function () {} : undefined),
        node: (id) => nodeLookup[id] || null,
      },
    },
    $,
    console,
    setTimeout,
  };
  context.window = context;

  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'resources', 'mavlink-editor.js'), 'utf8'),
    context
  );
  vm.runInNewContext(script, context);

  assert.ok(registered[nodeName], `${nodeName} must call registerType`);
  return registered[nodeName].defaults;
}

module.exports = { assertChangeHandlerContains, loadNodeDefaults };
