'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMachine, OPERATION } = require('../../lib/ftp');
const { decodePayload } = require('../../lib/ftp/items');
const { StubConnection, FakeTimers, fakeDeps } = require('../mission/stubs/connection');

const TARGET = { sysid: 42, compid: 1 };
const SOURCE = { sysid: 255, compid: 190 };

function machineOptions(stub, clock, extra = {}) {
  return {
    send: (message) => stub.send(message),
    subscribe: (filter, handler) => stub.subscribe(filter, handler),
    target: TARGET,
    source: SOURCE,
    timeoutMs: 10,
    maxRetries: 1,
    ...fakeDeps(clock),
    ...extra,
  };
}

function reply(message, opcode, options = {}) {
  const request = decodePayload(message.fields.payload);
  const data = options.data || Buffer.alloc(0);
  const payload = Buffer.alloc(251);
  payload.writeUInt16LE(options.seq === undefined ? request.seq + 1 : options.seq, 0);
  payload[2] = options.session === undefined ? request.session : options.session;
  payload[3] = opcode;
  payload[4] = options.size === undefined ? data.length : options.size;
  payload[5] = options.reqOpcode === undefined ? request.opcode : options.reqOpcode;
  payload[6] = options.burstComplete || 0;
  payload.writeUInt32LE(options.offset === undefined ? request.offset : options.offset, 8);
  data.copy(payload, 12, 0, Math.min(data.length, 239));
  return {
    name: 'FILE_TRANSFER_PROTOCOL',
    sysid: TARGET.sysid,
    compid: TARGET.compid,
    fields: {
      target_system: options.targetSystem === undefined ? SOURCE.sysid : options.targetSystem,
      target_component: options.targetComponent === undefined ? SOURCE.compid : options.targetComponent,
      payload,
    },
  };
}

function nack(message, errorCode, options = {}) {
  return reply(message, 129, { ...options, data: Buffer.from([errorCode]), size: 1 });
}

test('FTP exports the operation factory and packs protocol requests', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    assert.equal(request.opcode, 3);
    assert.equal(request.offset, 0);
    deliver(nack(message, 6));
  });

  const machine = createMachine(OPERATION.LIST, machineOptions(stub, clock, { path: '/' }));
  assert.equal(typeof machine.start, 'function');
  assert.equal(typeof machine.cancel, 'function');
  const outcome = await machine.start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.entries, []);
  assert.equal(stub.sent[0].message.name, 'FILE_TRANSFER_PROTOCOL');
  assert.equal(stub.subscriberCount(), 0);

  const firstSequence = decodePayload(stub.sent[0].message.fields.payload).seq;
  const second = createMachine(OPERATION.LIST, machineOptions(stub, clock, { path: '/' }));
  assert.equal((await second.start()).result, 'succeeded');
  const secondSequence = decodePayload(stub.sent[1].message.fields.payload).seq;
  assert.equal(secondSequence, (firstSequence + 2) & 0xffff);
});

test('list paginates by wire entry index and skips unsupported directory records', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode !== 3) return;
    if (request.offset === 0) {
      deliver(reply(message, 128, {
        data: Buffer.from('Ffirst.txt\t3\0Dfolder\0Sskip-me\0malformed\0'),
      }));
    } else if (request.offset === 4) {
      deliver(reply(message, 128, { data: Buffer.from('Fsecond.bin\t2\0') }));
    } else {
      deliver(nack(message, 6));
    }
  });

  const outcome = await createMachine(OPERATION.LIST, machineOptions(stub, clock, { path: '/logs' })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.entries, [
    { name: 'first.txt', type: 'file', size: 3 },
    { name: 'folder', type: 'directory', size: 0 },
    { name: 'second.bin', type: 'file', size: 2 },
  ]);
  const requests = stub.sent.map(({ message }) => decodePayload(message.fields.payload));
  assert.deepEqual(requests.map((request) => request.offset), [0, 4, 5]);
  assert.equal(requests[1].seq, (requests[0].seq + 2) & 0xffff);
  assert.equal(requests[2].seq, (requests[1].seq + 2) & 0xffff);
});

test('download reads sequential chunks, accepts EOF, and terminates the session', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 4) {
      deliver(reply(message, 128, {
        session: 7,
        size: 4,
        data: Buffer.from([5, 0, 0, 0]),
      }));
    } else if (request.opcode === 5 && request.offset === 0) {
      deliver(reply(message, 128, { session: 7, data: Buffer.from('abc') }));
    } else if (request.opcode === 5 && request.offset === 3) {
      deliver(reply(message, 128, { session: 7, data: Buffer.from('de') }));
    } else if (request.opcode === 5 && request.offset === 5) {
      deliver(nack(message, 6, { session: 7 }));
    }
  });

  const outcome = await createMachine(OPERATION.DOWNLOAD, machineOptions(stub, clock, { path: '/log.bin' })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.data, Buffer.from('abcde'));
  assert.deepEqual(stub.sentNames(), [
    'FILE_TRANSFER_PROTOCOL',
    'FILE_TRANSFER_PROTOCOL',
    'FILE_TRANSFER_PROTOCOL',
    'FILE_TRANSFER_PROTOCOL',
    'FILE_TRANSFER_PROTOCOL',
  ]);
  const requests = stub.sent.map(({ message }) => decodePayload(message.fields.payload));
  assert.deepEqual(requests.map((request) => request.opcode), [4, 5, 5, 5, 1]);
  assert.equal(requests[4].session, 7);
});

test('upload writes bounded chunks and reports bytes after cleanup', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  const data = Buffer.alloc(241, 0x5a);
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 6) {
      const fileSize = Buffer.alloc(4);
      deliver(reply(message, 128, { session: 9, size: 4, data: fileSize }));
    } else if (request.opcode === 7) {
      const bytesWritten = request.offset === 0 ? 128 : 113;
      const ack = Buffer.alloc(4);
      ack.writeUInt32LE(bytesWritten, 0);
      deliver(reply(message, 128, {
        session: 9,
        offset: request.offset,
        size: 4,
        data: ack,
      }));
    }
  });

  const outcome = await createMachine(OPERATION.UPLOAD, machineOptions(stub, clock, {
    path: '/upload.bin',
    data,
  })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.bytes, data.length);
  const requests = stub.sent.map(({ message }) => decodePayload(message.fields.payload));
  assert.deepEqual(requests.map((request) => request.opcode), [6, 7, 7, 1]);
  assert.deepEqual(requests.filter((request) => request.opcode === 7).map((request) => request.size), [239, 113]);
  assert.deepEqual(requests.filter((request) => request.opcode === 7).map((request) => request.offset), [0, 128]);
});

test('upload accepts the specification zero-sized write acknowledgement', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 6) deliver(reply(message, 128, { session: 0 }));
    if (request.opcode === 7) deliver(reply(message, 128, { session: 0, size: 0 }));
  });

  const outcome = await createMachine(OPERATION.UPLOAD, machineOptions(stub, clock, {
    path: '/spec.bin', data: Buffer.from('spec'),
  })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.bytes, 4);
});

test('retries preserve sequence and duplicate or misaddressed replies do not advance the machine', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  let reads = 0;
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 4) {
      deliver(reply(message, 128, { session: 3, size: 4, data: Buffer.from([4, 0, 0, 0]) }));
    } else if (request.opcode === 5) {
      reads += 1;
      if (reads === 1) return;
      if (request.offset >= 4) {
        deliver(nack(message, 6, { session: 3 }));
        return;
      }
      const valid = reply(message, 128, { session: 3, data: Buffer.from('ok') });
      const wrongSource = { ...valid, sysid: 77 };
      const wrongDestination = reply(message, 128, {
        session: 3,
        data: Buffer.from('bad'),
        targetSystem: 99,
      });
      deliver(wrongSource);
      deliver(wrongDestination);
      deliver(valid);
      deliver(valid);
    }
  });

  const done = createMachine(OPERATION.DOWNLOAD, machineOptions(stub, clock, {
    path: '/short',
    maxRetries: 1,
  })).start();
  const initialRead = () => stub.sent.map(({ message }) => decodePayload(message.fields.payload))
    .filter((request) => request.opcode === 5)[0];
  clock.flush(1);
  const retryRead = () => stub.sent.map(({ message }) => decodePayload(message.fields.payload))
    .filter((request) => request.opcode === 5)[1];
  assert.equal(retryRead().seq, initialRead().seq);

  clock.flush(1);
  const outcome = await done;
  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.data, Buffer.from('okok'));
});

test('cancel, NAK, timeout, and send errors all settle with cleanup and no live waiter', async () => {
  const cancelStub = new StubConnection();
  const cancelClock = new FakeTimers();
  cancelStub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 4) {
      deliver(reply(message, 128, { session: 4, size: 4, data: Buffer.from([9, 0, 0, 0]) }));
    }
  });
  const cancelMachine = createMachine(OPERATION.DOWNLOAD, machineOptions(cancelStub, cancelClock, { path: '/cancel' }));
  const cancelled = cancelMachine.start();
  cancelMachine.cancel();
  const cancelOutcome = await cancelled;
  assert.equal(cancelOutcome.result, 'cancelled');
  assert.equal(decodePayload(cancelStub.sent.at(-1).message.fields.payload).opcode, 1);
  assert.equal(cancelStub.subscriberCount(), 0);
  assert.equal(cancelClock.pending(), 0);

  const nakStub = new StubConnection();
  const nakClock = new FakeTimers();
  nakStub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 6) deliver(nack(message, 10));
  });
  const nakOutcome = await createMachine(OPERATION.UPLOAD, machineOptions(nakStub, nakClock, {
    path: '/missing', data: Buffer.from('x'),
  })).start();
  assert.equal(nakOutcome.result, 'failed');
  assert.equal(nakOutcome.phase, 'ack');
  assert.equal(nakOutcome.protocol.errorCode, 10);

  const timeoutStub = new StubConnection();
  const timeoutClock = new FakeTimers();
  timeoutStub.onSend(() => {});
  const timedOut = createMachine(OPERATION.LIST, machineOptions(timeoutStub, timeoutClock, {
    path: '/', maxRetries: 0,
  })).start();
  timeoutClock.flush();
  const timeoutOutcome = await timedOut;
  assert.equal(timeoutOutcome.result, 'failed');
  assert.equal(timeoutOutcome.phase, 'timeout');
  assert.equal(timeoutStub.subscriberCount(), 0);

  const sendErrorStub = new StubConnection();
  const sendErrorClock = new FakeTimers();
  const sendErrorOutcome = await createMachine(OPERATION.LIST, machineOptions(sendErrorStub, sendErrorClock, {
    path: '/', send: () => { throw new Error('link down'); },
  })).start();
  assert.equal(sendErrorOutcome.result, 'failed');
  assert.equal(sendErrorOutcome.phase, 'send');
  assert.match(sendErrorOutcome.reason, /link down/);
});
