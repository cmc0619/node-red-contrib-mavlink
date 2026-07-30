'use strict';

/**
 * Shared HTML-source assertions for Node-RED editor wiring tests.
 */

const assert = require('node:assert/strict');

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

module.exports = { assertChangeHandlerContains };
