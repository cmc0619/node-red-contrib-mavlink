'use strict';

/**
 * `listSerialPorts` — the enumerator behind the Connection editor's serial
 * path suggestions. Two behaviours matter and neither is observable from the
 * transport tests: a missing optional dependency is an empty list rather than
 * a failure, and a real listing failure reaches the caller as a rejection
 * (the route turns one into 200 and the other into 500).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { listSerialPorts } = require('../../lib/connection/transport/serial');

/**
 * Run `fn` with `require('serialport')` answered by `impl`, or made to fail
 * the way an uninstalled optional dependency does when `impl` is null.
 *
 * @param {?object} impl  the module `require` should return, or null
 * @param {function(): Promise<*>} fn
 * @returns {Promise<*>}
 */
async function withSerialPort(impl, fn) {
  const real = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request !== 'serialport') return real(request, parent, isMain);
    if (impl) return impl;
    const err = new Error("Cannot find module 'serialport'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };
  try {
    return await fn();
  } finally {
    Module._load = real;
  }
}

test('an absent serialport is an empty list, not a failure', async () => {
  const ports = await withSerialPort(null, () => listSerialPorts());
  assert.deepEqual(ports, [], 'UDP/TCP installs never carry the dependency');
});

test('ports come back as the library reports them', async () => {
  const listed = [
    { path: '/dev/ttyUSB0', manufacturer: 'FTDI' },
    { path: '/dev/ttyACM0' },
  ];
  const ports = await withSerialPort(
    { SerialPort: { list: () => Promise.resolve(listed) } },
    () => listSerialPorts()
  );
  assert.deepEqual(ports, listed, 'passed through untouched — the editor labels them');
});

test('a real listing failure rejects rather than throwing synchronously', async () => {
  // The route calls this and attaches handlers; a synchronous throw would
  // skip its 500 and land in Express instead.
  const boom = new Error('EACCES: permission denied');
  const call = withSerialPort(
    { SerialPort: { list: () => Promise.reject(boom) } },
    () => listSerialPorts()
  );
  await assert.rejects(call, /EACCES/);
});

test('a non-missing require failure rejects, and is not read as an absent dependency', async () => {
  const real = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request !== 'serialport') return real(request, parent, isMain);
    throw new SyntaxError('broken native binding');
  };
  try {
    await assert.rejects(listSerialPorts(), /broken native binding/);
  } finally {
    Module._load = real;
  }
});
