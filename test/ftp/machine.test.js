'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FtpMachine } = require('../../lib/ftp');
const { decodePayload, NAK_ERROR } = require('../../lib/ftp/items');
const { StubConnection, FakeTimers, fakeDeps } = require('../mission/stubs/connection');

const TARGET = { sysid: 42, compid: 1 };
const SOURCE = { sysid: 255, compid: 190 };

function machineOptions(stub, clock, extra = {}) {
  return {
    send: (message) => stub.send(message),
    subscribe: (filter, handler) => stub.subscribe(filter, handler),
    target: TARGET,
    source: SOURCE,
    onProgress: () => {
      // Fixture ignores progress unless a test overrides it.
    },
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

test('FTP exports the machine and packs protocol requests', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    assert.equal(request.opcode, 3);
    assert.equal(request.offset, 0);
    deliver(nack(message, 6));
  });

  const machine = new FtpMachine('list', machineOptions(stub, clock, { path: '/' }));
  assert.equal(typeof machine.start, 'function');
  assert.equal(typeof machine.cancel, 'function');
  const outcome = await machine.start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.entries, []);
  assert.equal(stub.sent[0].message.name, 'FILE_TRANSFER_PROTOCOL');
  assert.equal(stub.subscriberCount(), 0);

  const firstSequence = decodePayload(stub.sent[0].message.fields.payload).seq;
  const second = new FtpMachine('list', machineOptions(stub, clock, { path: '/' }));
  assert.equal((await second.start()).result, 'succeeded');
  const secondSequence = decodePayload(stub.sent[1].message.fields.payload).seq;
  assert.equal(secondSequence, (firstSequence + 2) & 0xffff);
});

test('unknown FTP operations fail through the existing start outcome', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  const outcome = await new FtpMachine('unknown', machineOptions(stub, clock, {
    path: '/ignored',
  })).start();

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'send');
  assert.equal(stub.subscriberCount(), 0);
  assert.equal(clock.pending(), 0);
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

  const outcome = await new FtpMachine('list', machineOptions(stub, clock, { path: '/logs' })).start();

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

test('download reads sequential chunks, finishes at the advertised size, and terminates the session', async () => {
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
    } else if (request.opcode === 1) {
      deliver(reply(message, 128, { session: 7 }));
    }
  });

  const outcome = await new FtpMachine('download', machineOptions(stub, clock, { path: '/log.bin' })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.data, Buffer.from('abcde'));
  assert.deepEqual(stub.sentNames(), [
    'FILE_TRANSFER_PROTOCOL',
    'FILE_TRANSFER_PROTOCOL',
    'FILE_TRANSFER_PROTOCOL',
    'FILE_TRANSFER_PROTOCOL',
  ]);
  const requests = stub.sent.map(({ message }) => decodePayload(message.fields.payload));
  assert.deepEqual(requests.map((request) => request.opcode), [4, 5, 5, 1]);
  assert.equal(requests[3].session, 7);
});

test('download accepts authoritative EOF after the file shrinks', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 4) {
      deliver(reply(message, 128, {
        session: 8,
        size: 4,
        data: Buffer.from([8, 0, 0, 0]),
      }));
    } else if (request.opcode === 5 && request.offset === 0) {
      deliver(reply(message, 128, { session: 8, data: Buffer.from('abc') }));
    } else if (request.opcode === 5 && request.offset === 3) {
      deliver(nack(message, 6, { session: 8 }));
    } else if (request.opcode === 1) {
      deliver(reply(message, 128, { session: 8 }));
    }
  });

  const outcome = await new FtpMachine('download', machineOptions(stub, clock, {
    path: '/shrunk.bin',
  })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.data, Buffer.from('abc'));
});

test('download accepts ArduPilot EOF NAK that leaves offset at zero', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 4) {
      deliver(reply(message, 128, {
        session: 9,
        size: 4,
        data: Buffer.from([8, 0, 0, 0]),
      }));
    } else if (request.opcode === 5 && request.offset === 0) {
      deliver(reply(message, 128, { session: 9, data: Buffer.from('xyz') }));
    } else if (request.opcode === 5 && request.offset === 3) {
      // ArduPilot GCS_FTP::error() memsets the reply, so EOF NAKs carry offset 0.
      deliver(nack(message, 6, { session: 9, offset: 0 }));
    } else if (request.opcode === 1) {
      deliver(reply(message, 128, { session: 9 }));
    }
  });

  const outcome = await new FtpMachine('download', machineOptions(stub, clock, {
    path: '/ap-eof.bin',
  })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.data, Buffer.from('xyz'));
});

test('download reports termination timeout instead of false success when cleanup is dropped', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  let terminateRequests = 0;
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 4) {
      deliver(reply(message, 128, {
        session: 7,
        size: 4,
        data: Buffer.from([4, 0, 0, 0]),
      }));
    } else if (request.opcode === 5 && request.offset === 0) {
      deliver(reply(message, 128, { session: 7, data: Buffer.from('done') }));
    } else if (request.opcode === 5 && request.offset === 4) {
      deliver(nack(message, 6, { session: 7 }));
    } else if (request.opcode === 1) {
      terminateRequests += 1;
    }
  });

  const done = new FtpMachine('download', machineOptions(stub, clock, {
    path: '/dropped-termination', maxRetries: 1,
  })).start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'cleanup');
  assert.match(outcome.reason, /timed out/);
  assert.equal(terminateRequests, 2);
});

test('download reports a termination NAK as cleanup failure', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 4) {
      deliver(reply(message, 128, {
        session: 10,
        size: 4,
        data: Buffer.from([4, 0, 0, 0]),
      }));
    } else if (request.opcode === 5 && request.offset === 0) {
      deliver(reply(message, 128, { session: 10, data: Buffer.from('done') }));
    } else if (request.opcode === 5 && request.offset === 4) {
      deliver(nack(message, NAK_ERROR.EOF, { session: 10 }));
    } else if (request.opcode === 1) {
      deliver(nack(message, NAK_ERROR.INVALIDSESSION, { session: 10 }));
    }
  });

  const outcome = await new FtpMachine('download', machineOptions(stub, clock, {
    path: '/naked-termination',
  })).start();

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'cleanup');
  assert.equal(outcome.protocol.errorCode, NAK_ERROR.INVALIDSESSION);
});

test('cleanup failure does not replace the primary transfer failure', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 4) {
      deliver(reply(message, 128, {
        session: 11,
        size: 4,
        data: Buffer.from([4, 0, 0, 0]),
      }));
    } else if (request.opcode === 5) {
      deliver(nack(message, NAK_ERROR.FILENOTFOUND, { session: 11 }));
    } else if (request.opcode === 1) {
      deliver(nack(message, NAK_ERROR.INVALIDSESSION, { session: 11 }));
    }
  });

  const outcome = await new FtpMachine('download', machineOptions(stub, clock, {
    path: '/primary-failure',
  })).start();

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'ack');
  assert.equal(outcome.protocol.errorCode, NAK_ERROR.FILENOTFOUND);
  assert.match(outcome.cleanupError, /INVALIDSESSION/);
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
    } else if (request.opcode === 1) {
      deliver(reply(message, 128, { session: 9 }));
    }
  });

  const outcome = await new FtpMachine('upload', machineOptions(stub, clock, {
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
    if (request.opcode === 1) deliver(reply(message, 128, { session: 0 }));
  });

  const outcome = await new FtpMachine('upload', machineOptions(stub, clock, {
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
    } else if (request.opcode === 1) {
      deliver(reply(message, 128, { session: 3 }));
    }
  });

  const done = new FtpMachine('download', machineOptions(stub, clock, {
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
  const cancelMachine = new FtpMachine('download', machineOptions(cancelStub, cancelClock, { path: '/cancel' }));
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
  const nakOutcome = await new FtpMachine('upload', machineOptions(nakStub, nakClock, {
    path: '/missing', data: Buffer.from('x'),
  })).start();
  assert.equal(nakOutcome.result, 'failed');
  assert.equal(nakOutcome.phase, 'ack');
  assert.equal(nakOutcome.protocol.errorCode, 10);

  const timeoutStub = new StubConnection();
  const timeoutClock = new FakeTimers();
  timeoutStub.onSend(() => {});
  const timedOut = new FtpMachine('list', machineOptions(timeoutStub, timeoutClock, {
    path: '/', maxRetries: 0,
  })).start();
  timeoutClock.flush();
  const timeoutOutcome = await timedOut;
  assert.equal(timeoutOutcome.result, 'failed');
  assert.equal(timeoutOutcome.phase, 'timeout');
  assert.equal(timeoutStub.subscriberCount(), 0);

  const sendErrorStub = new StubConnection();
  const sendErrorClock = new FakeTimers();
  const sendErrorOutcome = await new FtpMachine('list', machineOptions(sendErrorStub, sendErrorClock, {
    path: '/', send: () => { throw new Error('link down'); },
  })).start();
  assert.equal(sendErrorOutcome.result, 'failed');
  assert.equal(sendErrorOutcome.phase, 'send');
  assert.match(sendErrorOutcome.reason, /link down/);
});

test('create-directory sends the protocol operation and reports the path', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    assert.equal(request.opcode, 9);
    assert.equal(request.data.toString(), '/restore/folder');
    deliver(reply(message, 128));
  });

  const outcome = await new FtpMachine('create-directory', machineOptions(stub, clock, {
    path: '/restore/folder',
  })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.path, '/restore/folder');
});

test('backup recursively lists a selected directory, skips dot traversal records, and downloads files', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    const path = request.data.toString();
    if (request.opcode === 3) {
      if (path === '/config' && request.offset === 0) {
        deliver(reply(message, 128, {
          data: Buffer.from('Dfolder\0Froot.bin\t3\0D.\0D..\0'),
        }));
      } else if (path === '/config' && request.offset === 4) {
        deliver(nack(message, NAK_ERROR.EOF));
      } else if (path === '/config/folder' && request.offset === 0) {
        deliver(reply(message, 128, { data: Buffer.from('Finner.bin\t2\0') }));
      } else if (path === '/config/folder' && request.offset === 1) {
        deliver(nack(message, NAK_ERROR.EOF));
      }
      return;
    }
    if (request.opcode === 4) {
      if (path === '/config/root.bin') {
        deliver(reply(message, 128, {
          session: 7, size: 4, data: Buffer.from([3, 0, 0, 0]),
        }));
      } else if (path === '/config/folder/inner.bin') {
        deliver(reply(message, 128, {
          session: 8, size: 4, data: Buffer.from([2, 0, 0, 0]),
        }));
      }
      return;
    }
    if (request.opcode === 5) {
      if (request.session === 7 && request.offset === 0) {
        deliver(reply(message, 128, { session: 7, data: Buffer.from('abc') }));
      } else if (request.session === 7 && request.offset === 3) {
        deliver(nack(message, NAK_ERROR.EOF, { session: 7 }));
      } else if (request.session === 8 && request.offset === 0) {
        deliver(reply(message, 128, { session: 8, data: Buffer.from('de') }));
      } else if (request.session === 8 && request.offset === 2) {
        deliver(nack(message, NAK_ERROR.EOF, { session: 8 }));
      }
      return;
    }
    if (request.opcode === 1) deliver(reply(message, 128, { session: request.session }));
  });

  const outcome = await new FtpMachine('backup', machineOptions(stub, clock, {
    path: '/config',
  })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.root, '/config');
  assert.deepEqual(outcome.directories, ['folder']);
  assert.deepEqual(outcome.files, [
    { path: 'root.bin', data: 'YWJj' },
    { path: 'folder/inner.bin', data: 'ZGU=' },
  ]);
  const requests = stub.sent.map(({ message }) => decodePayload(message.fields.payload));
  assert.deepEqual(requests.filter((request) => request.opcode === 1).map((request) => request.session), [7, 8]);
  assert.equal(stub.subscriberCount(), 0);
});

test('restore creates recorded directories and uploads base64 file data where each entry joins the root', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  const bundle = {
    version: 1,
    root: '/config',
    // Each entry joins the destination as written, `..` included: backup never
    // emits one, so this shape only reaches here from a hand-edited bundle and
    // rides to its natural reading (§0).
    directories: ['folder', '../escape'],
    files: [
      { path: 'root.bin', data: 'YWJj' },
      { path: 'folder/inner.bin', data: 'ZGU=' },
      { path: '../../etc/passwd', data: 'Zg==' },
    ],
  };
  let nextSession = 20;
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 9) {
      assert.ok(['/restore', '/restore/folder', '/escape'].includes(request.data.toString()));
      deliver(nack(message, NAK_ERROR.FILEEXISTS));
    } else if (request.opcode === 3) {
      deliver(nack(message, NAK_ERROR.EOF));
    } else if (request.opcode === 6) {
      const session = nextSession;
      nextSession += 1;
      deliver(reply(message, 128, { session }));
    } else if (request.opcode === 7) {
      deliver(reply(message, 128, { session: request.session, size: 0 }));
    } else if (request.opcode === 1) {
      deliver(reply(message, 128, { session: request.session }));
    }
  });

  const outcome = await new FtpMachine('restore', machineOptions(stub, clock, {
    path: '/restore',
    entries: bundle,
  })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(outcome.bytes, 6);
  assert.equal(outcome.restoredFiles, 3);
  assert.equal(outcome.restoredDirectories, 2);
  const requests = stub.sent.map(({ message }) => decodePayload(message.fields.payload));
  assert.deepEqual(requests.filter((request) => request.opcode === 6).map((request) => request.data.toString()), [
    '/restore/root.bin',
    '/restore/folder/inner.bin',
    '/etc/passwd',
  ]);
  assert.deepEqual(requests.filter((request) => request.opcode === 7).map((request) => request.data.toString()), ['abc', 'de', 'f']);
});

test('backup and restore surface child failures with partial progress', async () => {
  const backupStub = new StubConnection();
  const backupClock = new FakeTimers();
  backupStub.onSend((message, deliver) => deliver(nack(message, NAK_ERROR.FILENOTFOUND)));
  const backup = await new FtpMachine('backup', machineOptions(backupStub, backupClock, {
    path: '/missing',
  })).start();
  assert.equal(backup.result, 'failed');
  assert.equal(backup.protocol.errorCode, NAK_ERROR.FILENOTFOUND);

  const restoreStub = new StubConnection();
  const restoreClock = new FakeTimers();
  restoreStub.onSend((message, deliver) => deliver(nack(message, NAK_ERROR.FILEPROTECTED)));
  const restore = await new FtpMachine('restore', machineOptions(restoreStub, restoreClock, {
    path: '/restore',
    entries: { directories: ['folder'], files: [{ path: 'file.bin', data: 'eA==' }] },
  })).start();
  assert.equal(restore.result, 'failed');
  assert.equal(restore.restoredDirectories, 0);
  assert.equal(restore.restoredFiles, 0);
  assert.equal(restore.protocol.errorCode, NAK_ERROR.FILEPROTECTED);
  assert.equal(restoreStub.sent.length, 1);
});

test('restore rejects a recorded directory whose existing path is a file', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    const path = request.data.toString();
    if (request.opcode === 9) {
      deliver(nack(message, NAK_ERROR.FILEEXISTS));
    } else if (request.opcode === 3 && path === '/restore') {
      if (request.offset === 0) {
        deliver(reply(message, 128, { data: Buffer.from('Fcollision\t1\0') }));
      } else {
        deliver(nack(message, NAK_ERROR.EOF));
      }
    } else if (request.opcode === 3 && path === '/restore/collision') {
      deliver(nack(message, NAK_ERROR.FILENOTFOUND));
    }
  });

  const outcome = await new FtpMachine('restore', machineOptions(stub, clock, {
    path: '/restore',
    entries: { directories: ['collision'], files: [] },
  })).start();

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.restoredDirectories, 0);
  assert.equal(outcome.protocol.errorCode, NAK_ERROR.FILENOTFOUND);
  assert.equal(stub.sent.map(({ message }) => decodePayload(message.fields.payload))
    .some((request) => request.opcode === 6), false);
});

test('cancelling a composite transfer cancels its active FTP child', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend(() => {});
  const machine = new FtpMachine('backup', machineOptions(stub, clock, {
    path: '/config', maxRetries: 0,
  }));
  const run = machine.start();
  machine.cancel();
  const outcome = await run;
  assert.equal(outcome.result, 'cancelled');
  assert.equal(stub.subscriberCount(), 0);
  assert.equal(clock.pending(), 0);
});

test('cancelling after a child settles does not start the next restore file', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  let createFiles = 0;
  let cancellationQueued = false;
  stub.onSend((message, deliver) => {
    const request = decodePayload(message.fields.payload);
    if (request.opcode === 9) {
      deliver(reply(message, 128));
    } else if (request.opcode === 6) {
      createFiles += 1;
      deliver(reply(message, 128, { session: 30 + createFiles }));
    } else if (request.opcode === 7) {
      deliver(reply(message, 128, { session: request.session, size: 0 }));
    } else if (request.opcode === 1) {
      deliver(reply(message, 128, { session: request.session }));
    }
  });
  const machine = new FtpMachine('restore', machineOptions(stub, clock, {
    path: '/restore',
    entries: {
      directories: [],
      files: [{ path: 'first.bin', data: 'YQ==' }, { path: 'second.bin', data: 'Yg==' }],
    },
    onProgress: (update) => {
      if (!cancellationQueued && update.phase === 'data' && update.offset === 1) {
        cancellationQueued = true;
        queueMicrotask(() => machine.cancel());
      }
    },
  }));

  const outcome = await machine.start();
  assert.equal(outcome.result, 'cancelled');
  assert.equal(createFiles, 1);
  assert.equal(stub.subscriberCount(), 0);
  assert.equal(clock.pending(), 0);
});
