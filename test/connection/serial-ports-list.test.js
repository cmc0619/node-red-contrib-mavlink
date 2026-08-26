'use strict';

/**
 * listSerialPorts (lib/connection/transport/serial.js) — the enumeration
 * behind `GET /mavlink/serial-ports`. serialport is an optional dependency:
 * its absence is an empty list, never a failure, and the lazy require's
 * resolution is cached so the admin endpoint does not re-require per request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const SERIAL_JS = require.resolve('../../lib/connection/transport/serial.js');

/**
 * Require a fresh copy of the serial transport module (the lister's cache is
 * module state) while `serialport` resolution is steered by `steer(request)`
 * — return the fake module, or throw the MODULE_NOT_FOUND shape
 * loadSerialPort recognizes.
 */
function freshSerial(steer) {
  delete require.cache[SERIAL_JS];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'serialport') return steer();
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(SERIAL_JS);
  } finally {
    Module._load = originalLoad;
  }
}

/** Run `fn(serial)` with the `serialport` require steered, then restore. */
async function withSteered(steer, fn) {
  const serial = freshSerial(steer);
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'serialport') return steer();
    return originalLoad.apply(this, arguments);
  };
  try {
    await fn(serial);
  } finally {
    Module._load = originalLoad;
  }
}

function missingSerialport() {
  const err = new Error("Cannot find module 'serialport'");
  err.code = 'MODULE_NOT_FOUND';
  throw err;
}

test('absent optional serialport resolves to an empty list', async () => {
  await withSteered(missingSerialport, async (serial) => {
    assert.deepEqual(await serial.listSerialPorts(), []);
  });
});

test('absence is cached — the failing require is not retried per request', async () => {
  let attempts = 0;
  await withSteered(() => {
    attempts += 1;
    return missingSerialport();
  }, async (serial) => {
    assert.deepEqual(await serial.listSerialPorts(), []);
    assert.deepEqual(await serial.listSerialPorts(), []);
    assert.equal(attempts, 1, 'second list must not require serialport again');
  });
});

test('a present serialport contributes its PortInfo records unchanged', async () => {
  const ports = [
    { path: '/dev/ttyUSB0', manufacturer: 'FTDI', vendorId: '0403' },
    { path: 'COM3' },
  ];
  await withSteered(() => ({ SerialPort: { list: async () => ports } }), async (serial) => {
    assert.deepEqual(await serial.listSerialPorts(), ports);
  });
});

test('the resolved module is cached — one require across repeated lists', async () => {
  let requires = 0;
  let lists = 0;
  await withSteered(() => {
    requires += 1;
    return { SerialPort: { list: async () => {
      lists += 1;
      return [{ path: '/dev/ttyACM0' }];
    } } };
  }, async (serial) => {
    await serial.listSerialPorts();
    await serial.listSerialPorts();
    assert.equal(requires, 1, 'the require resolves once');
    assert.equal(lists, 2, 'enumeration itself re-runs — hot-plugged ports appear');
  });
});

test('a listing failure propagates so the route can answer 500', async () => {
  await withSteered(() => ({
    SerialPort: {
      list: async () => {
        throw new Error('permission denied');
      },
    },
  }), async (serial) => {
    await assert.rejects(() => serial.listSerialPorts(), /permission denied/);
  });
});
