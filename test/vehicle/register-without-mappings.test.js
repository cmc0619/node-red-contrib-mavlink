'use strict';

/**
 * Vehicle type must still register when mavlink-mappings is unavailable so
 * Connection / Build keep standard config-node edit/add pickers.
 *
 * Runs in a child process so parallel suite workers that already loaded
 * mavlink-mappings cannot poison the stub.
 */

const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('mavlink-vehicle registers even when mavlink-mappings cannot be loaded', () => {
  const script = `
    const { EventEmitter } = require('node:events');
    const Module = require('node:module');
    const path = require('node:path');
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'mavlink-mappings') {
        throw new Error("Cannot find module 'mavlink-mappings'");
      }
      return originalLoad.apply(this, arguments);
    };
    const register = require(${JSON.stringify(path.resolve(__dirname, '../../nodes/mavlink-vehicle.js'))});
    const types = {};
    const RED = {
      log: { error() {} },
      httpAdmin: { get() {} },
      auth: { needsPermission() { return (_r, _s, n) => n && n(); } },
      nodes: {
        createNode(node, config) {
          Object.setPrototypeOf(node, EventEmitter.prototype);
          EventEmitter.call(node);
          node.id = config.id || 'veh';
          node.status = () => {};
        },
        registerType(name, ctor) { types[name] = ctor; },
      },
    };
    register(RED);
    if (typeof types['mavlink-vehicle'] !== 'function') {
      console.error('TYPE_MISSING');
      process.exit(2);
    }
    const node = new types['mavlink-vehicle']({ id: 'v1', dialect: 'ardupilotmega' });
    try {
      node.getDialect();
      console.error('GETDIALECT_DID_NOT_THROW');
      process.exit(3);
    } catch (err) {
      if (!/mavlink-mappings/.test(err.message)) {
        console.error('WRONG_ERROR', err.message);
        process.exit(4);
      }
    }
    console.log('OK');
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OK/);
});
