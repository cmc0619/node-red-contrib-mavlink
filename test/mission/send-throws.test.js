'use strict';

/**
 * A throwing `connection.send` must fail the transfer, not the process.
 *
 * `Connection.send` throws synchronously by design — `QueueOverflowError` once
 * the Bulk band hits its cap, or identity resolution failing on a dead link.
 * Two of the places the transfer calls it are outside any caller's reach:
 *
 *   - the retry inside `_onTimeout`, which runs in timer context, where a throw
 *     is an uncaughtException rather than a failed transfer; and
 *   - `_begin()`, whose throw rejects `start()` while leaving the machine armed
 *     and subscribed, so the live timer later re-fires the same throwing send
 *     from timer context.
 *
 * Both arrive on a dead or saturated link — exactly when a mission transfer is
 * most likely to be running.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MissionDownload } = require('../../lib/mission/download');
const { MISSION_TYPE } = require('../../lib/mission/types');
const { StubConnection, FakeTimers, fakeDeps } = require('./stubs/connection');

const TARGET = { sysid: 1, compid: 1 };

/** Build a download machine over `stub`, driven by `clock`. */
function downloadOver(stub, clock) {
  return new MissionDownload({
    send: (m) => stub.send(m),
    subscribe: (f, h) => stub.subscribe(f, h),
    target: TARGET,
    missionType: MISSION_TYPE.MISSION,
    maxRetries: 3,
    timeoutMs: 1000,
    ...fakeDeps(clock),
  });
}

test('a retry send that throws aborts the transfer instead of escaping the timer', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();
  let sends = 0;

  stub.onSend(() => {
    sends += 1;
    // The first request goes out; the link dies before the retry.
    if (sends > 1) throw new Error('queue overflow on control band');
  });

  const machine = downloadOver(stub, clock);
  const settled = machine.start();

  // Unfixed, the throw escapes _onTimeout into the timer callback, so flush()
  // itself throws and the assertions below never run.
  clock.flush();
  const outcome = await settled;

  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.phase, 'aborted');
  assert.match(outcome.reason, /send failed/);
  assert.match(outcome.reason, /queue overflow/);
  assert.equal(clock.pending(), 0, 'no timer left armed after the abort');
});

test('a first send that throws settles the machine rather than leaving it armed', async () => {
  const stub = new StubConnection();
  const clock = new FakeTimers();

  stub.onSend(() => {
    throw new Error('no route to host');
  });

  const machine = downloadOver(stub, clock);
  const outcome = await machine.start();

  assert.equal(outcome.result, 'failed');
  assert.match(outcome.reason, /no route to host/);

  // The leak this guards: _step() arms before it sends, so an unhandled throw
  // out of _begin() leaves both of these live. The armed timer is the crash —
  // it re-enters the same throwing send with nothing above it to catch.
  assert.equal(clock.pending(), 0, 'no timer left armed');
  assert.equal(stub.subscriberCount(), 0, 'subscription released');
});
