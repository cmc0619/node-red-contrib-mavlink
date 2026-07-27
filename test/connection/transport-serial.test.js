'use strict';

const { EventEmitter } = require('node:events');
const Module = require('node:module');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SerialTransport, SERIAL_NO_DESTINATION } = require('../../lib/connection/transport/serial');

class FakeSerialPort extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.isOpen = false;
    this.writes = [];
    this.closed = false;
    FakeSerialPort.instances.push(this);
  }

  open(callback) {
    this.isOpen = true;
    setTimeout(() => callback(), 0);
  }

  write(buffer, callback) {
    this.writes.push(Buffer.from(buffer));
    this.writeCallback = callback;
    return this.writeReturn;
  }

  close(callback) {
    this.closed = true;
    this.isOpen = false;
    setTimeout(() => {
      this.emit('close');
      callback();
    }, 0);
  }

  receive(buffer) {
    this.emit('data', buffer);
  }
}

FakeSerialPort.instances = [];

function resetFakeSerialPort() {
  FakeSerialPort.instances = [];
  FakeSerialPort.prototype.writeReturn = true;
}

function openTransport(config = {}) {
  resetFakeSerialPort();
  const transport = new SerialTransport(
    { path: '/dev/ttyUSB0', baudRate: 115200, highWaterMark: 32, ...config },
    { SerialPort: FakeSerialPort }
  );
  return { transport, opened: transport.open(), port: () => FakeSerialPort.instances[0] };
}

test('open constructs the port with config and emits listening after it opens', async () => {
  const { transport, opened, port } = openTransport();
  const listening = new Promise((resolve) => transport.once('listening', resolve));

  await opened;

  assert.equal(transport.mode, 'serial');
  assert.deepEqual(port().options, { path: '/dev/ttyUSB0', baudRate: 115200, highWaterMark: 32, autoOpen: false });
  assert.equal(await listening, undefined);
});

test('baud rate defaults to common MAVLink radio speed', async () => {
  const { opened, port } = openTransport({ baudRate: undefined, highWaterMark: undefined });

  await opened;

  assert.equal(port().options.baudRate, 57600);
  assert.equal('highWaterMark' in port().options, false);
});

test('data events become peer-table-compatible message events', async () => {
  const { transport, opened, port } = openTransport();
  const messages = [];
  transport.on('message', (message) => messages.push(message));

  await opened;
  port().receive(Buffer.from([0xfd, 0x01]));

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { buffer: Buffer.from([0xfd, 0x01]), address: '/dev/ttyUSB0', port: 0 });
});

test('send writes and calls back immediately when the port accepts the frame', async () => {
  const { transport, opened, port } = openTransport();
  await opened;

  await new Promise((resolve, reject) => {
    transport.send(Buffer.from('abc'), { address: '/dev/ttyUSB0', port: 0 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
    port().writeCallback();
  });

  assert.deepEqual(port().writes, [Buffer.from('abc')]);
});

test('send waits for drain before callback when write returns false', async () => {
  const { transport, opened, port } = openTransport();
  await opened;
  port().writeReturn = false;
  let called = false;

  transport.send(Buffer.from('abc'), null, (err) => {
    assert.ifError(err);
    called = true;
  });

  assert.equal(called, false);
  port().writeCallback();
  assert.equal(called, false);
  port().emit('drain');
  assert.equal(called, true);
});

test('send soft-fails with SERIAL_NO_DESTINATION when the port is not open', () => {
  resetFakeSerialPort();
  const transport = new SerialTransport({ path: '/dev/ttyUSB0' }, { SerialPort: FakeSerialPort });

  transport.send(Buffer.from('abc'), null, (err) => {
    assert.equal(err.code, SERIAL_NO_DESTINATION);
    assert.match(err.message, /not open/i);
  });
});

test('close closes the port and emits close', async () => {
  const { transport, opened, port } = openTransport();
  const closed = new Promise((resolve) => transport.once('close', resolve));
  await opened;

  await new Promise((resolve) => transport.close(resolve));

  await closed;
  assert.equal(port().closed, true);
});

test('missing optional serialport dependency rejects with a clear error', async () => {
  const transport = new SerialTransport({ path: '/dev/ttyUSB0' });
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'serialport') {
      const err = new Error("Cannot find module 'serialport'");
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    await assert.rejects(
      () => transport.open(),
      (err) =>
        err.code === 'SERIALPORT_MISSING' &&
        /optional dependency 'serialport'/.test(err.message) &&
        !/node-gyp|bindings|\.node/i.test(err.stack)
    );
  } finally {
    Module._load = originalLoad;
  }
});
