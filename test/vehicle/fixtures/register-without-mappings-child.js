'use strict';

/**
 * Child-process fixture: stub out mavlink-mappings, load mavlink-vehicle, and
 * assert the type still registers (DESIGN.md §14 config-node picker ground truth).
 *
 * Exit codes: 0 OK, 2 type missing, 3 getDialect did not throw, 4 wrong error.
 */

const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;
Module._load = function stubMappings(request, parent, isMain) {
  if (request === 'mavlink-mappings') {
    throw new Error("Cannot find module 'mavlink-mappings'");
  }
  return originalLoad.apply(this, arguments);
};

const register = require(path.resolve(__dirname, '../../../nodes/mavlink-vehicle.js'));
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
