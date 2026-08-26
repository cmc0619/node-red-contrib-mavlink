'use strict';

/**
 * The `/mavlink/serial-ports` admin route: what the editor's path suggestions
 * are fetched from. The distinction that matters is which failure is a
 * failure — nothing to enumerate answers 200 with an empty list (UDP and TCP
 * installs must keep working with no optional dependency), while a listing
 * that genuinely failed answers 500 with its message.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const NODE_PATH = path.join(__dirname, '..', '..', 'nodes', 'mavlink-connection.js');
const SERIAL_PATH = path.join(__dirname, '..', '..', 'lib', 'connection', 'transport', 'serial.js');

/**
 * Register the Connection node against a RED double whose admin router only
 * records handlers, with `listSerialPorts` replaced by `lister`. The node
 * module and the serial transport are dropped from the require cache so each
 * case registers afresh — the route guard is once per process.
 *
 * @param {function(): Promise<object[]>} lister
 * @returns {function(object, object): void} the registered route handler
 */
function routeWith(lister) {
  delete require.cache[NODE_PATH];
  delete require.cache[SERIAL_PATH];
  const real = Module._load;
  Module._load = function load(request, parent, isMain) {
    const loaded = real(request, parent, isMain);
    if (parent && parent.filename === NODE_PATH && /transport\/serial$/.test(request)) {
      return { ...loaded, listSerialPorts: lister };
    }
    return loaded;
  };
  let handler = null;
  try {
    require(NODE_PATH)({
      httpAdmin: {
        get(routePath, _auth, fn) {
          if (routePath === '/mavlink/serial-ports') handler = fn;
        },
      },
      auth: { needsPermission: () => (_r, _s, next) => next && next() },
      nodes: { registerType() {}, createNode() {}, getNode: () => null },
    });
  } finally {
    Module._load = real;
    delete require.cache[NODE_PATH];
    delete require.cache[SERIAL_PATH];
  }
  assert.ok(handler, 'the serial-ports route registered');
  return handler;
}

/** Minimal Express response double recording status and body. */
function responseDouble() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

test('a successful listing answers 200 with the ports', async () => {
  const ports = [{ path: '/dev/ttyUSB0', manufacturer: 'FTDI' }];
  const handler = routeWith(() => Promise.resolve(ports));
  const res = responseDouble();
  handler({}, res);
  await new Promise(setImmediate);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ports });
});

test('nothing to enumerate is 200 and an empty list, not an error', async () => {
  const handler = routeWith(() => Promise.resolve([]));
  const res = responseDouble();
  handler({}, res);
  await new Promise(setImmediate);
  assert.equal(res.statusCode, 200, 'a UDP-only install must not see a failing endpoint');
  assert.deepEqual(res.body, { ports: [] });
});

test('a listing failure answers 500 carrying the reason', async () => {
  const handler = routeWith(() => Promise.reject(new Error('EACCES: permission denied')));
  const res = responseDouble();
  handler({}, res);
  await new Promise(setImmediate);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { ports: [], error: 'EACCES: permission denied' });
});
