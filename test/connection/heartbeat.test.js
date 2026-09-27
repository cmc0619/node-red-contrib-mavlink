'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { HeartbeatScheduler } = require('../../lib/connection/heartbeat');

// Shaped like the snapshot nodes/mavlink-connection.js builds: the Local
// Identity always supplies heartbeatIntervalMs.
const GCS = {
  id: 'gcs',
  sysid: 255,
  compid: 190,
  heartbeatIntervalMs: 1000,
  heartbeat: { type: 6, autopilot: 8 },
};

/**
 * @param {object} [opts]
 * @returns {{scheduler: HeartbeatScheduler, emitted: object[], logs: object[]}}
 */
function build(opts = {}) {
  const emitted = [];
  const logs = [];
  const scheduler = new HeartbeatScheduler({
    emit: (entry) => emitted.push(entry),
    health: () => true,
    setInterval,
    clearInterval,
    logger: {
      info: (m) => logs.push({ level: 'info', m }),
      warn: (m) => logs.push({ level: 'warn', m }),
    },
    ...opts,
  });
  return { scheduler, emitted, logs };
}

test('emits one HEARTBEAT per bound identity per tick', () => {
  const { scheduler, emitted } = build();
  scheduler.add(GCS);
  scheduler.add({
    id: 'comp',
    sysid: 1,
    compid: 191,
    heartbeatIntervalMs: 1000,
    heartbeat: { type: 18, autopilot: 8 },
  });
  scheduler.tick();
  assert.equal(emitted.length, 2);
  const gcs = emitted.find((e) => e.identity.id === 'gcs').message;
  assert.equal(gcs.name, 'HEARTBEAT');
  assert.equal(gcs.sysid, 255);
  assert.equal(gcs.compid, 190);
  assert.equal(gcs.fields.type, 6);
  assert.equal(gcs.fields.autopilot, 8);
  assert.equal(gcs.fields.system_status, 4);
  assert.equal(gcs.fields.mavlink_version, 3);
});

test('a faulted identity does not heartbeat, and the fault is logged once', () => {
  const faulted = new Set(['gcs']);
  const { scheduler, emitted, logs } = build({ health: (id) => !faulted.has(id) });
  scheduler.add(GCS);

  scheduler.tick();
  scheduler.tick();
  assert.equal(emitted.length, 0);
  assert.equal(logs.filter((l) => l.level === 'warn').length, 1); // logged once, not per tick
});

test('the heartbeat resumes when the fault clears, logged once', () => {
  const faulted = new Set(['gcs']);
  const { scheduler, emitted, logs } = build({
    health: (id) => !faulted.has(id),
  });
  scheduler.add(GCS);

  scheduler.tick(); // faulted
  faulted.delete('gcs');
  scheduler.tick(); // healthy again
  scheduler.tick();

  assert.equal(emitted.length, 2);
  assert.equal(logs.filter((l) => l.level === 'info').length, 1);
});

test('start/stop drive the injected interval and release it', () => {
  let intervalCleared = false;
  const token = { unref() {} };
  const { scheduler, emitted } = build({
    setInterval: (fn) => {
      fn(); // fire once immediately
      return token;
    },
    clearInterval: (handle) => {
      intervalCleared = handle === token;
    },
  });
  scheduler.add(GCS);
  scheduler.start();
  assert.equal(emitted.length, 1);
  scheduler.stop();
  assert.equal(intervalCleared, true);
});

test('each identity beats on its own interval, not a multiple of the smallest (R45)', () => {
  /**
   * A shared timer at min(interval) quantizes a 1500 ms identity beside a
   * 1000 ms one to every 2000 ms, and its clock-skew gate skips periods.
   */
  const timers = [];
  const cleared = [];
  const { scheduler, emitted } = build({
    setInterval: (fn, ms) => {
      const handle = { fn, ms, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearInterval: (handle) => cleared.push(handle),
  });
  scheduler.add({ ...GCS, heartbeatIntervalMs: 1000 });
  scheduler.add({
    id: 'slow',
    sysid: 1,
    compid: 191,
    heartbeatIntervalMs: 1500,
    heartbeat: { type: 18, autopilot: 8 },
  });

  scheduler.start();
  scheduler.start();
  assert.deepEqual(timers.map((t) => t.ms), [1000, 1500], 'one interval per identity, started once');

  timers[1].fn();
  assert.deepEqual(emitted.map((e) => e.identity.id), ['slow'], 'a timer beats only its own identity');

  scheduler.stop();
  assert.deepEqual(cleared, timers, 'stop releases every identity timer');
});
