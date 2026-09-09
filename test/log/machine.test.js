'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRequestList, buildRequestData, buildRequestEnd } = require('../../lib/log/items');
const { LogList } = require('../../lib/log/list');
const { LogDownload, LOG_REQUEST_BYTES } = require('../../lib/log/download');
const { StubConnection, FakeTimers, fakeDeps } = require('../mission/stubs/connection');

const TARGET = { sysid: 42, compid: 1 };

function machineOptions(stub, clock, extra = {}) {
  return {
    send: (message) => stub.send(message),
    subscribe: (filter, handler) => stub.subscribe(filter, handler),
    target: TARGET,
    timeoutMs: 10,
    maxRetries: 2,
    ...fakeDeps(clock),
    ...extra,
  };
}

function entry(id, numLogs, lastLogNum, size, timeUtc = 0) {
  return {
    name: 'LOG_ENTRY',
    sysid: TARGET.sysid,
    compid: TARGET.compid,
    fields: { id, num_logs: numLogs, last_log_num: lastLogNum, time_utc: timeUtc, size },
  };
}

function data(id, ofs, bytes) {
  const payload = Buffer.from(bytes);
  return {
    name: 'LOG_DATA',
    sysid: TARGET.sysid,
    compid: TARGET.compid,
    fields: { id, ofs, count: payload.length, data: payload },
  };
}

test('log message builders carry only the protocol fields', () => {
  assert.deepEqual(buildRequestList(TARGET), {
    name: 'LOG_REQUEST_LIST',
    fields: { target_system: 42, target_component: 1, start: 0, end: 0xffff },
  });
  assert.deepEqual(buildRequestData(TARGET, 7, 90, 90), {
    name: 'LOG_REQUEST_DATA',
    fields: { target_system: 42, target_component: 1, id: 7, ofs: 90, count: 90 },
  });
  assert.deepEqual(buildRequestEnd(TARGET), {
    name: 'LOG_REQUEST_END',
    fields: { target_system: 42, target_component: 1 },
  });
});

test('log list completes from an advertised zero-entry response', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name === 'LOG_REQUEST_LIST') deliver(entry(0, 0, 0, 0));
  });

  const outcome = await new LogList(machineOptions(stub, clock)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.entries, []);
  assert.deepEqual(stub.sentNames(), ['LOG_REQUEST_LIST', 'LOG_REQUEST_END']);
  assert.equal(stub.subscriberCount(), 0);
  assert.equal(clock.pending(), 0);
});

test('log list accepts zero and one based ids, preserves metadata, and ignores wrong sources', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name !== 'LOG_REQUEST_LIST') return;
    deliver(entry(1, 2, 2, 11, 100));
    deliver({ ...entry(2, 2, 2, 22, 200), sysid: 7 });
    deliver(entry(2, 2, 2, 22, 200));
  });

  const outcome = await new LogList(machineOptions(stub, clock)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.entries, [
    { id: 1, numLogs: 2, lastLogNum: 2, timeUtc: 100, size: 11 },
    { id: 2, numLogs: 2, lastLogNum: 2, timeUtc: 200, size: 22 },
  ]);
  assert.equal(stub.sentNames().filter((name) => name === 'LOG_REQUEST_LIST').length, 1);
});

test('log list retries the directory after a dropped entry', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  let requestCount = 0;
  stub.onSend((message, deliver) => {
    if (message.name !== 'LOG_REQUEST_LIST') return;
    requestCount += 1;
    if (requestCount === 1) {
      deliver(entry(1, 3, 3, 10));
      deliver(entry(3, 3, 3, 30));
    } else {
      deliver(entry(2, 3, 3, 20));
    }
  });

  const done = new LogList(machineOptions(stub, clock)).start();
  clock.flush(1);
  const retry = stub.sent.filter(({ message }) => message.name === 'LOG_REQUEST_LIST').at(-1).message;
  assert.deepEqual(retry, {
    name: 'LOG_REQUEST_LIST',
    fields: { target_system: 42, target_component: 1, start: 0, end: 0xffff },
  });
  const outcome = await done;

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.entries.map((item) => item.id), [1, 2, 3]);
});

test('log list cancellation and timeout both send LOG_REQUEST_END', async () => {
  const cancelStub = new StubConnection();
  const cancelClock = new FakeTimers();
  cancelStub.onSend(() => {});
  const cancelledMachine = new LogList(machineOptions(cancelStub, cancelClock));
  const cancelled = cancelledMachine.start();
  cancelledMachine.cancel();
  assert.equal((await cancelled).result, 'cancelled');
  assert.deepEqual(cancelStub.sentNames(), ['LOG_REQUEST_LIST', 'LOG_REQUEST_END']);

  const timeoutStub = new StubConnection();
  const timeoutClock = new FakeTimers();
  timeoutStub.onSend(() => {});
  const timedOut = new LogList(machineOptions(timeoutStub, timeoutClock)).start();
  timeoutClock.flush();
  const outcome = await timedOut;
  assert.equal(outcome.result, 'failed');
  assert.equal(timeoutStub.sentNames().at(-1), 'LOG_REQUEST_END');
});

test('log download assembles out of order data and does not complete on a hole', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name !== 'LOG_REQUEST_DATA') return;
    if (message.fields.ofs === 0) {
      deliver(data(7, 0, Buffer.alloc(90, 0x61)));
      deliver(data(7, 180, Buffer.alloc(90, 0x63)));
    } else if (message.fields.ofs === 90) {
      deliver(data(7, 90, Buffer.alloc(90, 0x62)));
    }
  });

  const done = new LogDownload(machineOptions(stub, clock, { id: 7 })).start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stub.sent.length, 1, 'one window request serves multiple normal LOG_DATA packets');
  assert.equal(stub.sent[0].message.fields.count, LOG_REQUEST_BYTES);
  assert.equal(stub.subscriberCount(), 1);

  clock.flush(1);
  assert.equal(stub.sent.at(-1).message.fields.ofs, 90, 'the gap, not offset zero, is retried');
  assert.equal(stub.sent.at(-1).message.fields.count, 90);
  stub.inject({
    name: 'LOG_DATA', sysid: 42, compid: 1,
    fields: { id: 7, ofs: 270, count: 0, data: Buffer.alloc(90) },
  });
  const outcome = await done;

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.data.length, 270);
  assert.equal(outcome.data[0], 0x61);
  assert.equal(outcome.data[90], 0x62);
  assert.equal(outcome.data[180], 0x63);
  assert.equal(stub.sentNames().filter((name) => name === 'LOG_REQUEST_DATA').length, 2);
});

test('log download advances a full window before requesting the next window', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name !== 'LOG_REQUEST_DATA') return;
    if (message.fields.ofs === 0) {
      for (let ofs = 0; ofs < LOG_REQUEST_BYTES; ofs += 90) {
        deliver(data(7, ofs, Buffer.alloc(90, 0x61)));
      }
    } else if (message.fields.ofs === LOG_REQUEST_BYTES) {
      deliver(data(7, LOG_REQUEST_BYTES, 'end'));
    }
  });

  const outcome = await new LogDownload(machineOptions(stub, clock, { id: 7 })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.data.length, LOG_REQUEST_BYTES + 3);
  const requests = stub.sent.filter(({ message }) => message.name === 'LOG_REQUEST_DATA');
  assert.deepEqual(requests.map(({ message }) => message.fields.ofs), [0, LOG_REQUEST_BYTES]);
  assert.deepEqual(requests.map(({ message }) => message.fields.count), [LOG_REQUEST_BYTES, LOG_REQUEST_BYTES]);
});

test('log download accepts a short final packet as EOF', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name === 'LOG_REQUEST_DATA') {
      if (message.fields.ofs === 0) deliver(data(7, 0, 'abc'));
      else deliver({
        name: 'LOG_DATA', sysid: 42, compid: 1,
        fields: { id: 7, ofs: 3, count: 0, data: Buffer.alloc(90) },
      });
    }
  });

  const outcome = await new LogDownload(machineOptions(stub, clock, { id: 7 })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.data, Buffer.from('abc'));
});

test('exact multiple probes for zero-count EOF after a full packet', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name !== 'LOG_REQUEST_DATA') return;
    if (message.fields.ofs === 0) {
      deliver(data(7, 0, Buffer.alloc(90, 0x61)));
    } else if (message.fields.ofs === 90) {
      deliver({
        name: 'LOG_DATA', sysid: 42, compid: 1,
        fields: { id: 7, ofs: 90, count: 0, data: Buffer.alloc(90) },
      });
    }
  });

  const done = new LogDownload(machineOptions(stub, clock, { id: 7 })).start();
  clock.flush(1);
  const outcome = await done;

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.data.length, 90);
  assert.equal(outcome.data[0], 0x61);
  assert.equal(stub.sent[0].message.fields.count, LOG_REQUEST_BYTES);
  assert.equal(stub.sent[1].message.fields.ofs, 90);
  assert.equal(stub.sent[1].message.fields.count, LOG_REQUEST_BYTES - 90);
  assert.equal(stub.sentNames().filter((name) => name === 'LOG_REQUEST_DATA').length, 2);
});

test('duplicate data does not create another range or complete early', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name !== 'LOG_REQUEST_DATA') return;
    if (message.fields.ofs === 0) {
      deliver(data(7, 0, Buffer.alloc(90, 0x61)));
      deliver(data(7, 0, Buffer.alloc(90, 0x61)));
      deliver({
        name: 'LOG_DATA', sysid: 42, compid: 1,
        fields: { id: 7, ofs: 90, count: 0, data: Buffer.alloc(90) },
      });
    }
  });

  const outcome = await new LogDownload(machineOptions(stub, clock, { id: 7 })).start();
  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.data.length, 90);
  assert.equal(stub.sentNames().filter((name) => name === 'LOG_REQUEST_DATA').length, 1);
});

test('wrong log id and wrong source do not settle the download', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((_message, deliver) => {
    deliver(data(8, 0, 'bad-id'));
    deliver({ ...data(7, 0, 'bad-source'), sysid: 7 });
  });

  const done = new LogDownload(machineOptions(stub, clock, { id: 7 })).start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'aborted');
  assert.match(outcome.reason, /stalled at offset 0/);
});

test('download cancel sends LOG_REQUEST_END and never a mission or command ack', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend(() => {});
  const machine = new LogDownload(machineOptions(stub, clock, { id: 7 }));
  const done = machine.start();
  machine.cancel();
  const outcome = await done;

  assert.equal(outcome.result, 'cancelled');
  assert.deepEqual(stub.sentNames(), ['LOG_REQUEST_DATA', 'LOG_REQUEST_END']);
  assert.equal(stub.sentNames().some((name) => /ACK/.test(name)), false);
  assert.equal(stub.subscriberCount(), 0);
  assert.equal(clock.pending(), 0);
});

test('PX4 directory retries a lost zero ID without counting duplicates', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  let requests = 0;
  stub.onSend((message, deliver) => {
    if (message.name !== 'LOG_REQUEST_LIST') return;
    requests += 1;
    deliver(entry(1, 2, 2, 90));
    deliver(entry(1, 2, 2, 90));
    if (requests > 1) deliver(entry(0, 2, 2, 90));
  });
  const done = new LogList(machineOptions(stub, clock)).start();
  assert.equal(stub.subscriberCount(), 1);
  clock.flush();
  const outcome = await done;
  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.entries.map(item => item.id), [0, 1]);
});

test('known byte length completes only after the missing data arrives without EOF', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  const machine = new LogDownload(machineOptions(stub, clock, { id: 7, size: 180 }));
  const done = machine.start();
  stub.inject(data(7, 90, Buffer.alloc(90, 2)));
  assert.equal(stub.subscriberCount(), 1);
  assert.equal(stub.sent.length, 1, 'known size does not cause a request for every packet');
  stub.inject(data(7, 0, Buffer.alloc(90, 1)));
  clock.flush();
  const outcome = await done;
  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.data, Buffer.concat([Buffer.alloc(90, 1), Buffer.alloc(90, 2)]));
});

test('known empty log completes without a data request', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  const done = new LogDownload(machineOptions(stub, clock, { id: 7, size: 0 })).start();
  clock.flush();
  const outcome = await done;
  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.data.length, 0);
  assert.deepEqual(stub.sentNames(), ['LOG_REQUEST_END']);
});

test('observed EOF remains authoritative when a requested byte boundary is longer', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  const done = new LogDownload(machineOptions(stub, clock, { id: 7, size: 180 })).start();
  stub.inject(data(7, 0, 'abc'));
  clock.flush();
  const outcome = await done;
  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.data, Buffer.from('abc'));
});
