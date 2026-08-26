'use strict';

/**
 * GET /mavlink/serial-ports — the admin endpoint behind the Connection
 * editor's serial-path dropdown. Registered once per process by
 * mavlink-connection, gated on `mavlink.read` like the dialects route
 * (DESIGN.md §6), and never hard-fails on the optional dependency: absent
 * serialport is HTTP 200 with `{ ports: [] }`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const SERIAL_JS = require.resolve('../../lib/connection/transport/serial.js');
const NODE_JS = require.resolve('../../nodes/mavlink-connection.js');

/**
 * Register a fresh copy of the connection node against a mock RED and return
 * the captured route handlers and the permission scopes they asked for. Both
 * modules are fresh because the endpoint's once-per-process flag and the
 * lister's require cache are module state. (`serialport` itself is lazy — it
 * is not required until the first request, so steering belongs to `answer`.)
 */
function captureRoutes() {
  delete require.cache[SERIAL_JS];
  delete require.cache[NODE_JS];
  const routes = new Map();
  const permissions = [];
  const RED = {
    nodes: { registerType() {} },
    httpAdmin: {
      get(path, _auth, handler) {
        routes.set(path, handler);
      },
    },
    auth: {
      needsPermission(scope) {
        permissions.push(scope);
        return (_req, _res, next) => next && next();
      },
    },
  };
  require(NODE_JS)(RED);
  return { routes, permissions };
}

/**
 * Invoke `handler` with the `serialport` require steered by `steer` (return
 * the fake module or throw the MODULE_NOT_FOUND shape) and resolve with the
 * response it writes. The require is synchronous inside the handler, so the
 * patch comes straight back off.
 */
function answer(handler, steer) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body });
        return this;
      },
    };
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request) {
      if (request === 'serialport') return steer();
      return originalLoad.apply(this, arguments);
    };
    try {
      handler({ query: {} }, res);
    } catch (err) {
      reject(err);
    } finally {
      Module._load = originalLoad;
    }
  });
}

function missingSerialport() {
  const err = new Error("Cannot find module 'serialport'");
  err.code = 'MODULE_NOT_FOUND';
  throw err;
}

test('the route is registered and gated on mavlink.read', () => {
  const { routes, permissions } = captureRoutes();
  assert.ok(routes.has('/mavlink/serial-ports'), 'GET /mavlink/serial-ports must be registered');
  assert.deepEqual(permissions, ['mavlink.read']);
});

test('absent serialport answers 200 with an empty port list, every time', async () => {
  const { routes } = captureRoutes();
  const handler = routes.get('/mavlink/serial-ports');
  const first = await answer(handler, missingSerialport);
  const second = await answer(handler, missingSerialport);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body, { ports: [] });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body, { ports: [] });
});

test('a present serialport serves its PortInfo records', async () => {
  const ports = [
    { path: '/dev/ttyUSB0', manufacturer: 'FTDI' },
    { path: 'COM3' },
  ];
  const { routes } = captureRoutes();
  const res = await answer(
    routes.get('/mavlink/serial-ports'),
    () => ({ SerialPort: { list: async () => ports } })
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ports });
});

test('a real listing failure answers 500 with an empty list and the message', async () => {
  const { routes } = captureRoutes();
  const res = await answer(
    routes.get('/mavlink/serial-ports'),
    () => ({
      SerialPort: {
        list: async () => {
          throw new Error('permission denied');
        },
      },
    })
  );
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { ports: [], error: 'permission denied' });
});
