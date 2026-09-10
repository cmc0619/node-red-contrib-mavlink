'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ParamBackupRestore,
  locks,
  OPERATION,
} = require('../../lib/param/backup');
const { paramValueToWire } = require('../../lib/codec/param-union');
const { createWire } = require('../../lib/connection/wire');
const { loadBundled } = require('../../lib/metadata/bundled');
const { StubConnection, FakeTimers, fakeDeps } = require('../mission/stubs/connection');

const TARGET = { sysid: 1, compid: 1 };

function machineOptions(stub, clock, extra = {}) {
  return {
    send: (message) => stub.send(message),
    subscribe: (filter, handler) => stub.subscribe(filter, handler),
    target: TARGET,
    onProgress: () => {
      // Fixture ignores progress unless a test overrides it.
    },
    encoding: 'bytewise',
    timeoutMs: 10,
    maxRetries: 1,
    ...fakeDeps(clock),
    ...extra,
  };
}

function valueFrame({ index, count, paramId, paramType, value, sysid = TARGET.sysid, compid = TARGET.compid }) {
  return {
    name: 'PARAM_VALUE',
    sysid,
    compid,
    fields: {
      param_id: paramId,
      param_index: index,
      param_count: count,
      param_type: paramType,
      param_value: value,
    },
  };
}

function echo(param, extra = {}, encoding = 'bytewise') {
  return {
    name: 'PARAM_VALUE',
    sysid: TARGET.sysid,
    compid: TARGET.compid,
    fields: {
      param_id: param.paramId,
      param_type: param.paramType,
      param_value: encoding === 'c-cast'
        ? Number(param.value)
        : paramValueToWire(param.value, param.paramType),
      param_index: 0,
      param_count: 1,
      ...extra,
    },
  };
}

function serializeSetAndEcho(wire, message) {
  const sent = wire.decode(
    wire.serialize(message, { sysid: 255, compid: 1, seq: 0 }),
    { address: '127.0.0.1', port: 14550 }
  )[0];
  const echoedMessage = {
    name: 'PARAM_VALUE',
    fields: {
      param_id: sent.fields.param_id,
      param_value: sent.fields.param_value,
      param_type: sent.fields.param_type,
      param_index: 0,
      param_count: 1,
    },
  };
  const echoed = wire.decode(
    wire.serialize(echoedMessage, { sysid: TARGET.sysid, compid: TARGET.compid, seq: 1 }),
    { address: '127.0.0.1', port: 14551 }
  )[0];
  return { sent, echoed };
}

test('parameter backup exports operations and a per-target lock registry', () => {
  assert.deepEqual(OPERATION, { BACKUP: 'backup', RESTORE: 'restore' });
  const release = locks.acquire('conn', TARGET);
  assert.notEqual(release, null);
  assert.equal(locks.acquire('conn', TARGET), null);
  release();
});

test('backup decodes bytewise integer values and returns them in wire-index order', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name !== 'PARAM_REQUEST_LIST') return;
    deliver(valueFrame({ index: 1, count: 2, paramId: 'B', paramType: 6, value: paramValueToWire(-7, 6) }));
    deliver(valueFrame({ index: 0, count: 2, paramId: 'A', paramType: 5, value: paramValueToWire(4000000000, 5) }));
  });

  const outcome = await new ParamBackupRestore(OPERATION.BACKUP, machineOptions(stub, clock)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.params, [
    { paramId: 'A', paramType: 5, value: 4000000000 },
    { paramId: 'B', paramType: 6, value: -7 },
  ]);
  assert.deepEqual(stub.sentNames(), ['PARAM_REQUEST_LIST']);
  assert.equal(stub.subscriberCount(), 0);
  assert.equal(clock.pending(), 0);
});

test('backup retries the full list with the same collector and reports received count on failure', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  let requests = 0;
  stub.onSend((message, deliver) => {
    if (message.name !== 'PARAM_REQUEST_LIST') return;
    requests += 1;
    if (requests === 1) {
      deliver(valueFrame({ index: 0, count: 2, paramId: 'A', paramType: 6, value: paramValueToWire(1, 6) }));
    }
  });

  const done = new ParamBackupRestore(OPERATION.BACKUP, machineOptions(stub, clock, { maxRetries: 1 })).start();
  clock.flush();
  const outcome = await done;

  assert.equal(requests, 2);
  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'aborted');
  assert.equal(outcome.received, 1);
  assert.match(outcome.reason, /list/);
});

test('repeated duplicate backup frames do not reset the incomplete-list timeout', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name !== 'PARAM_REQUEST_LIST') return;
    const frame = valueFrame({ index: 0, count: 2, paramId: 'A', paramType: 6, value: paramValueToWire(1, 6) });
    deliver(frame);
    for (const at of [5, 10, 15, 20]) clock.setTimeout(() => deliver(frame), at);
  });

  const done = new ParamBackupRestore(OPERATION.BACKUP, machineOptions(stub, clock, { maxRetries: 0 })).start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.elapsed, 10, 'duplicates do not extend the configured wait');
  assert.equal(outcome.received, 1);
});

test('backup ignores wrong source and completes only from the addressed vehicle', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name !== 'PARAM_REQUEST_LIST') return;
    deliver(valueFrame({ index: 0, count: 1, paramId: 'BAD', paramType: 6, value: paramValueToWire(99, 6), sysid: 2 }));
    deliver(valueFrame({ index: 0, count: 1, paramId: 'GOOD', paramType: 6, value: paramValueToWire(7, 6) }));
  });

  const outcome = await new ParamBackupRestore(OPERATION.BACKUP, machineOptions(stub, clock)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.params, [{ paramId: 'GOOD', paramType: 6, value: 7 }]);
});

test('backup decode errors settle and tear down the subscription and timer', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend(() => {});
  const machine = new ParamBackupRestore(OPERATION.BACKUP, machineOptions(stub, clock));
  const done = machine.start();

  assert.doesNotThrow(() => stub.inject(valueFrame({
    index: 0,
    count: 1,
    paramId: 'BROKEN',
    paramType: 999,
    value: 1,
  })));
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'error');
  assert.equal(outcome.received, 1);
  assert.equal(stub.subscriberCount(), 0);
  assert.equal(clock.pending(), 0);
});

test('backup preserves signed zero and nonfinite REAL32 values through JSON and the wire', async () => {
  const saved = [-0, Infinity, -Infinity, NaN];
  const wire = createWire({ bundle: loadBundled('common') });
  for (const value of saved) {
    const stub = new StubConnection();
    const clock = new FakeTimers();
    stub.onSend((message, deliver) => {
      if (message.name === 'PARAM_REQUEST_LIST') {
        deliver(valueFrame({ index: 0, count: 1, paramId: 'FLOAT', paramType: 9, value }));
      }
    });

    const backup = await new ParamBackupRestore(OPERATION.BACKUP, machineOptions(stub, clock, { encoding: 'c-cast' })).start();
    const expected = Object.is(value, -0) ? '-0' : String(value);
    assert.equal(typeof backup.params[0].value, 'string');
    assert.equal(backup.params[0].value, expected);
    const roundTripped = JSON.parse(JSON.stringify(backup.params));
    assert.equal(roundTripped[0].value, expected);

    const restoreStub = new StubConnection();
    const restoreClock = new FakeTimers();
    let sentWireValue = null;
    let echoedWireValue = null;
    restoreStub.onSend((message, deliver) => {
      if (message.name === 'PARAM_SET') {
        const actual = serializeSetAndEcho(wire, message);
        sentWireValue = actual.sent.fields.param_value;
        echoedWireValue = actual.echoed.fields.param_value;
        deliver(actual.echoed);
      }
    });
    const restored = await new ParamBackupRestore(OPERATION.RESTORE, machineOptions(restoreStub, restoreClock, {
      encoding: 'c-cast',
      params: roundTripped,
    })).start();
    assert.equal(restored.result, 'succeeded');
    assert.equal(restored.restored, 1);
    if (Object.is(value, -0)) {
      assert.equal(Object.is(sentWireValue, -0), true);
      assert.equal(Object.is(echoedWireValue, -0), true);
    } else if (Number.isNaN(value)) {
      assert.equal(Number.isNaN(sentWireValue), true);
      assert.equal(Number.isNaN(echoedWireValue), true);
    } else {
      assert.equal(sentWireValue, value);
      assert.equal(echoedWireValue, value);
    }
  }
});

test('restore round-trips bytewise and c-cast saved values sequentially', async () => {
  for (const [encoding, params] of [
    ['bytewise', [
      { paramId: 'I', paramType: 6, value: -12 },
      { paramId: 'U', paramType: 5, value: 4000000000 },
    ]],
    ['c-cast', [
      { paramId: 'F', paramType: 9, value: 47.9 },
      { paramId: 'I', paramType: 6, value: 12 },
    ]],
  ]) {
    const stub = new StubConnection();
    const clock = new FakeTimers();
    stub.onSend((message, deliver) => {
      if (message.name !== 'PARAM_SET') return;
      const sent = params.find((param) => param.paramId === message.fields.param_id);
      deliver(echo(sent, { param_type: sent.paramType }, encoding));
    });

    const outcome = await new ParamBackupRestore(OPERATION.RESTORE, machineOptions(stub, clock, {
      encoding,
      params: JSON.parse(JSON.stringify(params)),
    })).start();

    assert.equal(outcome.result, 'succeeded');
    assert.equal(outcome.restored, params.length);
    assert.deepEqual(stub.sentNames(), ['PARAM_SET', 'PARAM_SET']);
  }
});

test('restore waits for a matching echo and preserves confirmed prefix on failure', async () => {
  const params = [
    { paramId: 'A', paramType: 6, value: 1 },
    { paramId: 'B', paramType: 6, value: 2 },
  ];
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name !== 'PARAM_SET') return;
    if (message.fields.param_id === 'A') deliver(echo(params[0]));
  });

  const done = new ParamBackupRestore(OPERATION.RESTORE, machineOptions(stub, clock, { params, maxRetries: 1 })).start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'aborted');
  assert.equal(outcome.restored, 1);
  assert.equal(outcome.paramId, 'B');
  assert.equal(stub.sentNames().filter((name) => name === 'PARAM_SET').length, 3);
  assert.match(outcome.reason, /B/);
});

test('restore ignores wrong source and wrong echo before confirming a parameter', async () => {
  const params = [{ paramId: 'A', paramType: 6, value: 3 }];
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend((message, deliver) => {
    if (message.name !== 'PARAM_SET') return;
    deliver({ ...echo(params[0]), sysid: 2 });
    deliver(echo({ ...params[0], value: 4 }));
    deliver(echo(params[0]));
  });

  const outcome = await new ParamBackupRestore(OPERATION.RESTORE, machineOptions(stub, clock, { params })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(stub.sentNames().filter((name) => name === 'PARAM_SET').length, 1);
});

test('restore retries only the current parameter with a bounded ceiling', async () => {
  const params = [{ paramId: 'A', paramType: 6, value: 3 }];
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend(() => {});

  const done = new ParamBackupRestore(OPERATION.RESTORE, machineOptions(stub, clock, { params, maxRetries: 2 })).start();
  clock.flush();
  const outcome = await done;

  assert.equal(outcome.result, 'failed');
  assert.equal(stub.sentNames().filter((name) => name === 'PARAM_SET').length, 3);
  assert.equal(outcome.restored, 0);
  assert.equal(outcome.paramId, 'A');
});

test('backup and restore cancel cleanly with partial result information', async () => {
  const backupStub = new StubConnection();
  const backupClock = new FakeTimers();
  backupStub.onSend((message, deliver) => {
    if (message.name === 'PARAM_REQUEST_LIST') {
      deliver(valueFrame({ index: 0, count: 2, paramId: 'A', paramType: 6, value: paramValueToWire(1, 6) }));
    }
  });
  const backupMachine = new ParamBackupRestore(OPERATION.BACKUP, machineOptions(backupStub, backupClock));
  const backupDone = backupMachine.start();
  backupMachine.cancel();
  const backupOutcome = await backupDone;
  assert.equal(backupOutcome.result, 'cancelled');
  assert.equal(backupOutcome.received, 1);
  assert.equal(backupStub.subscriberCount(), 0);
  assert.equal(backupClock.pending(), 0);

  const restoreStub = new StubConnection();
  const restoreClock = new FakeTimers();
  const params = [
    { paramId: 'A', paramType: 6, value: 1 },
    { paramId: 'B', paramType: 6, value: 2 },
  ];
  restoreStub.onSend((message, deliver) => {
    if (message.name === 'PARAM_SET' && message.fields.param_id === 'A') deliver(echo(params[0]));
  });
  const restoreMachine = new ParamBackupRestore(OPERATION.RESTORE, machineOptions(restoreStub, restoreClock, { params }));
  const restoreDone = restoreMachine.start();
  restoreMachine.cancel();
  const restoreOutcome = await restoreDone;
  assert.equal(restoreOutcome.result, 'cancelled');
  assert.equal(restoreOutcome.restored, 1);
  assert.equal(restoreOutcome.paramId, 'B');
  assert.equal(restoreStub.subscriberCount(), 0);
  assert.equal(restoreClock.pending(), 0);
});

test('unknown operation settles through the machine failure path', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  const machine = new ParamBackupRestore('unknown', machineOptions(stub, clock));
  const outcome = machine && await Promise.race([
    machine.start(),
    new Promise((resolve) => setTimeout(() => resolve(null), 50)),
  ]);

  assert.ok(outcome, 'unknown operations must not leave start() pending');
  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'aborted');
  assert.match(outcome.reason, /begin|function/i);
  assert.equal(stub.subscriberCount(), 0);
  assert.equal(clock.pending(), 0);
});
