'use strict';

/**
 * Child-process fixture: stub out mavlink-mappings, load mavlink-vehicle, and
 * assert the type still registers and can load a seeded dialect (seed is the
 * dialect authority — mappings is unused for metadata).
 *
 * Exit codes: 0 OK, 2 type missing, 3 getDialect threw, 4 wrong dialect.
 */

const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;
Module._load = function stubMappings(request, _parent, _isMain) {
  if (request === 'mavlink-mappings') {
    throw new Error("Cannot find module 'mavlink-mappings'");
  }
  return originalLoad.apply(this, arguments);
};

const register = require(path.resolve(__dirname, '../../../nodes/mavlink-vehicle.js'));
const types = {};
const RED = {
  log: { error() {} },
  httpAdmin: {
    get() {},
    post() {},
  },
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

const node = new types['mavlink-vehicle']({
  id: 'v1',
  vehicleFamily: 'unknown',
  firmware: 'ardupilot',
  dialect: 'ardupilotmega',
  dialectRevision: 'seed',
});
let bundle;
try {
  bundle = node.getDialect();
} catch (err) {
  console.error('GETDIALECT_THREW', err.message);
  process.exit(3);
}

if (!bundle || bundle.dialect !== 'ardupilotmega' || !bundle.messages.HEARTBEAT) {
  console.error('WRONG_DIALECT', bundle && bundle.dialect);
  process.exit(4);
}

console.log('OK');
