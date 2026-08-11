'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SubscriptionRegistry } = require('../../lib/connection/subscriptions');

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function decoded(overrides) {
  return {
    name: 'GLOBAL_POSITION_INT',
    sysid: 1,
    compid: 1,
    fields: { lat: 100, lon: 200, coords: [1, 2, 3] },
    ...overrides,
  };
}

test('each subscriber receives its own copy — mutation does not leak', () => {
  const reg = new SubscriptionRegistry();
  let seenByB = null;

  reg.subscribe(null, (msg) => {
    msg.fields.lat = 999; // a Function-node-style mutation
    msg.fields.coords.push(4);
  });
  reg.subscribe(null, (msg) => {
    seenByB = msg;
  });

  const source = decoded();
  reg.dispatch(source);

  assert.equal(seenByB.fields.lat, 100); // unaffected by subscriber A's mutation
  assert.deepEqual(seenByB.fields.coords, [1, 2, 3]);
  assert.equal(source.fields.lat, 100); // the source object is untouched too
  assert.deepEqual(source.fields.coords, [1, 2, 3]);
});

test('NaN survives the copy (the codec sentinel must not become null)', () => {
  const reg = new SubscriptionRegistry();
  let received = null;
  reg.subscribe(null, (msg) => {
    received = msg;
  });
  reg.dispatch(decoded({ fields: { yaw: NaN } }));
  assert.ok(Number.isNaN(received.fields.yaw));
});

test('filter narrows by message, sysid, and compid', () => {
  const reg = new SubscriptionRegistry();
  const hits = [];
  reg.subscribe({ message: 'HEARTBEAT' }, () => hits.push('by-message'));
  reg.subscribe({ sysid: 2 }, () => hits.push('by-sysid'));
  reg.subscribe({ compid: 1 }, () => hits.push('by-compid'));

  reg.dispatch(decoded({ name: 'HEARTBEAT', sysid: 1, compid: 1 }));
  assert.deepEqual(hits.sort(), ['by-compid', 'by-message']);
});

test('trustedOnly excludes only the explicit untrusted mark (§7 trust ruling #264)', () => {
  const reg = new SubscriptionRegistry();
  const received = [];
  reg.subscribe({ trustedOnly: true }, (msg) => received.push(msg.trusted));

  reg.dispatch(decoded({ trusted: false })); // explicitly marked — excluded
  reg.dispatch(decoded({ trusted: true })); // verified — delivered
  reg.dispatch(decoded({})); // no mark (plain unsigned link) — delivered

  assert.deepEqual(received, [true, undefined]);
});

test('unsubscribe stops further delivery', () => {
  const reg = new SubscriptionRegistry();
  let count = 0;
  const off = reg.subscribe(null, () => {
    count += 1;
  });
  reg.dispatch(decoded());
  off();
  reg.dispatch(decoded());
  assert.equal(count, 1);
  assert.equal(reg.size(), 0);
});

test('dispatch reports how many subscribers received the message', () => {
  const reg = new SubscriptionRegistry();
  reg.subscribe({ message: 'HEARTBEAT' }, () => {});
  reg.subscribe(null, () => {});
  assert.equal(reg.dispatch(decoded({ name: 'HEARTBEAT' })), 2);
  assert.equal(reg.dispatch(decoded({ name: 'SYS_STATUS' })), 1);
});

test('a throwing subscriber does not block delivery to the next one, or escape dispatch', () => {
  const errors = [];
  const reg = new SubscriptionRegistry({ logger: { error: (m) => errors.push(m) } });
  let secondReceived = null;

  reg.subscribe(null, () => {
    throw new TypeError('Do not know how to serialize a BigInt');
  });
  reg.subscribe(null, (msg) => {
    secondReceived = msg;
  });

  let delivered;
  assert.doesNotThrow(() => {
    delivered = reg.dispatch(decoded());
  });
  assert.equal(delivered, 1, 'a throwing subscriber must not count as delivered');
  assert.ok(secondReceived, 'second subscriber must still receive the frame');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /BigInt/);
});

test('a subscriber throwing a non-Error (null) is still isolated', () => {
  // `throw null` has no .message — reading it inside the catch would throw
  // from the isolation code itself and escape dispatch.
  const errors = [];
  const reg = new SubscriptionRegistry({ logger: { error: (m) => errors.push(m) } });
  let secondReceived = null;

  reg.subscribe(null, () => {
    throw null;
  });
  reg.subscribe(null, (msg) => {
    secondReceived = msg;
  });

  assert.doesNotThrow(() => reg.dispatch(decoded()));
  assert.ok(secondReceived, 'second subscriber must still receive the frame');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /null/);
});
