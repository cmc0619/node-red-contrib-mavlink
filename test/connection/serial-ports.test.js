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
function withSerialPort(impl, fn) {
  const real = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request !== 'serialport') return real(request, parent, isMain);
    if (impl) return impl;
    const err = new Error("Cannot find module 'serialport'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };
  // `fn()` is returned, not awaited: awaiting here would convert a
  // synchronous throw into a rejection inside the harness and hide which of
  // the two the subject actually did (CodeRabbit).
  try {
    return fn();
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

test('a listing that throws synchronously still comes back as a rejection', async () => {
  // The route calls this and attaches handlers; a synchronous throw would
  // skip its 500 and land in Express instead. `list()` throwing outright —
  // rather than returning a rejected promise — is the case that proves the
  // conversion is the subject's and not the harness's.
  const call = withSerialPort(
    { SerialPort: { list() { throw new Error('EACCES: permission denied'); } } },
    () => listSerialPorts()
  );
  assert.ok(typeof call.then === 'function', 'a promise, not a synchronous throw');
  await assert.rejects(call, /EACCES/);
});

test('a listing that rejects comes back as a rejection', async () => {
  const call = withSerialPort(
    { SerialPort: { list: () => Promise.reject(new Error('EACCES: permission denied')) } },
    () => listSerialPorts()
  );
  await assert.rejects(call, /EACCES/);
});

test('a missing binding inside an installed serialport is a failure, not an absence', async () => {
  // Node puts the require stack in `message`, so the stack line under
  // node_modules/serialport would satisfy a loose /serialport/ match and turn
  // a broken install into "nothing to enumerate" — 200 with an empty list
  // instead of the 500 it earns (Codex).
  const real = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request !== 'serialport') return real(request, parent, isMain);
    const err = new Error(
      "Cannot find module './build/Release/bindings.node'\n"
      + 'Require stack:\n'
      + '- /app/node_modules/serialport/dist/index.js'
    );
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };
  try {
    await assert.rejects(listSerialPorts(), /bindings\.node/);
  } finally {
    Module._load = real;
  }
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
