'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMachine,
  locks,
  OPERATION,
} = require('../../lib/param/backup');
const { paramValueToWire } = require('../../lib/codec/param-union');
const { StubConnection, FakeTimers, fakeDeps } = require('../mission/stubs/connection');

const TARGET = { sysid: 1, compid: 1 };

function machineOptions(stub, clock, extra = {}) {
  return {
    send: (message) => stub.send(message),
    subscribe: (filter, handler) => stub.subscribe(filter, handler),
    target: TARGET,
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

  const outcome = await createMachine(OPERATION.BACKUP, machineOptions(stub, clock)).start();

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

  const done = createMachine(OPERATION.BACKUP, machineOptions(stub, clock, { maxRetries: 1 })).start();
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

  const done = createMachine(OPERATION.BACKUP, machineOptions(stub, clock, { maxRetries: 0 })).start();
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

  const outcome = await createMachine(OPERATION.BACKUP, machineOptions(stub, clock)).start();

  assert.equal(outcome.result, 'succeeded');
  assert.deepEqual(outcome.params, [{ paramId: 'GOOD', paramType: 6, value: 7 }]);
});

test('backup decode errors settle and tear down the subscription and timer', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend(() => {});
  const machine = createMachine(OPERATION.BACKUP, machineOptions(stub, clock));
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

test('backup represents nonfinite REAL32 values as strings for JSON round-trip', async () => {
  const saved = [Infinity, -Infinity, NaN];
  for (const value of saved) {
    const stub = new StubConnection();
    const clock = new FakeTimers();
    stub.onSend((message, deliver) => {
      if (message.name === 'PARAM_REQUEST_LIST') {
        deliver(valueFrame({ index: 0, count: 1, paramId: 'FLOAT', paramType: 9, value }));
      }
    });

    const backup = await createMachine(OPERATION.BACKUP, machineOptions(stub, clock, { encoding: 'c-cast' })).start();
    assert.equal(typeof backup.params[0].value, 'string');
    assert.equal(backup.params[0].value, String(value));
    assert.doesNotMatch(JSON.stringify(backup.params), /null/);

    const restoreStub = new StubConnection();
    const restoreClock = new FakeTimers();
    restoreStub.onSend((message, deliver) => {
      if (message.name === 'PARAM_SET') {
        deliver(echo({ paramId: 'FLOAT', paramType: 9, value }, {}, 'c-cast'));
      }
    });
    const restored = await createMachine(OPERATION.RESTORE, machineOptions(restoreStub, restoreClock, {
      encoding: 'c-cast',
      params: JSON.parse(JSON.stringify(backup.params)),
    })).start();
    assert.equal(restored.result, 'succeeded');
    assert.equal(restored.restored, 1);
    const restoredWireValue = restoreStub.sent[0].message.fields.param_value;
    if (Number.isNaN(value)) assert.ok(Number.isNaN(restoredWireValue));
    else assert.equal(restoredWireValue, value);
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

    const outcome = await createMachine(OPERATION.RESTORE, machineOptions(stub, clock, {
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

  const done = createMachine(OPERATION.RESTORE, machineOptions(stub, clock, { params, maxRetries: 1 })).start();
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

  const outcome = await createMachine(OPERATION.RESTORE, machineOptions(stub, clock, { params })).start();

  assert.equal(outcome.result, 'succeeded');
  assert.equal(stub.sentNames().filter((name) => name === 'PARAM_SET').length, 1);
});

test('restore retries only the current parameter with a bounded ceiling', async () => {
  const params = [{ paramId: 'A', paramType: 6, value: 3 }];
  const stub = new StubConnection();
  const clock = new FakeTimers();
  stub.onSend(() => {});

  const done = createMachine(OPERATION.RESTORE, machineOptions(stub, clock, { params, maxRetries: 2 })).start();
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
  const backupMachine = createMachine(OPERATION.BACKUP, machineOptions(backupStub, backupClock));
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
  const restoreMachine = createMachine(OPERATION.RESTORE, machineOptions(restoreStub, restoreClock, { params }));
  const restoreDone = restoreMachine.start();
  restoreMachine.cancel();
  const restoreOutcome = await restoreDone;
  assert.equal(restoreOutcome.result, 'cancelled');
  assert.equal(restoreOutcome.restored, 1);
  assert.equal(restoreOutcome.paramId, 'B');
  assert.equal(restoreStub.subscriberCount(), 0);
  assert.equal(restoreClock.pending(), 0);
});
