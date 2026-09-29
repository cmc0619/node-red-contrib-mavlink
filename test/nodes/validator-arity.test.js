'use strict';

/**
 * Node-RED renders a validator's returned reason only when the function takes
 * two arguments (`validate.length === 2`, red.js validateNodeProperty); a
 * one-argument validator's string is coerced with `!!` and reads as valid
 * (§14.24). Every validator the palette registers therefore declares (v, opt).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadNodeType } = require('./html-assert');

const nodesDir = path.join(__dirname, '..', '..', 'nodes');
const names = fs.readdirSync(nodesDir)
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.replace(/\.html$/, ''));

test('every palette validator takes (v, opt), so Node-RED shows the reason it returns', () => {
  const oneArg = [];
  for (const name of names) {
    const def = loadNodeType(name);
    for (const group of ['defaults', 'credentials']) {
      for (const [prop, descriptor] of Object.entries(def[group] || {})) {
        if (typeof descriptor.validate === 'function' && descriptor.validate.length !== 2) {
          oneArg.push(`${name}.${group}.${prop} (arity ${descriptor.validate.length})`);
        }
      }
    }
  }
  assert.deepEqual(oneArg, []);
});
