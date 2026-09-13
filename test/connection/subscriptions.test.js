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

test('addressed-to filters read the target fields: own id and broadcast pass, others and unaddressed do not', () => {
  // The companion role's inbox: a message names its recipient in its own
  // target_system / target_component fields. 0 is broadcast and passes; a
  // message with no target field at all is addressed to no one and does not.
  const reg = new SubscriptionRegistry();
  const hits = [];
  reg.subscribe({ toSysid: 1, toCompid: 191 }, (m) => hits.push(m.name));

  reg.dispatch(decoded({ name: 'MINE', fields: { target_system: 1, target_component: 191 } }));
  reg.dispatch(decoded({ name: 'BROADCAST', fields: { target_system: 0, target_component: 0 } }));
  reg.dispatch(decoded({ name: 'ALL_COMPONENTS', fields: { target_system: 1, target_component: 0 } }));
  reg.dispatch(decoded({ name: 'OTHER_COMPONENT', fields: { target_system: 1, target_component: 1 } }));
  reg.dispatch(decoded({ name: 'OTHER_SYSTEM', fields: { target_system: 2, target_component: 191 } }));
  reg.dispatch(decoded({ name: 'HEARTBEAT', fields: { type: 6 } }));
  // A system-scoped message (SET_MODE shape: target_system, no component
  // field) is addressed to every component of that system — mine included —
  // and to no component of another.
  reg.dispatch(decoded({ name: 'SET_MODE_MINE', fields: { target_system: 1, base_mode: 1 } }));
  reg.dispatch(decoded({ name: 'SET_MODE_OTHER', fields: { target_system: 2, base_mode: 1 } }));

  assert.deepEqual(hits, ['MINE', 'BROADCAST', 'ALL_COMPONENTS', 'SET_MODE_MINE']);
});

test('a component-only addressed-to filter still keeps out messages that name no recipient', () => {
  // To compid alone reads "for component 191 on any system". HEARTBEAT names
  // no one and stays out; a system-scoped message (no component field) is
  // for every component of its system and comes in; an explicit other
  // component stays out.
  const reg = new SubscriptionRegistry();
  const hits = [];
  reg.subscribe({ toCompid: 191 }, (m) => hits.push(m.name));

  reg.dispatch(decoded({ name: 'HEARTBEAT', fields: { type: 6 } }));
  reg.dispatch(decoded({ name: 'MINE', fields: { target_system: 7, target_component: 191 } }));
  reg.dispatch(decoded({ name: 'SET_MODE', fields: { target_system: 7, base_mode: 1 } }));
  reg.dispatch(decoded({ name: 'OTHER_COMPONENT', fields: { target_system: 7, target_component: 1 } }));

  assert.deepEqual(hits, ['MINE', 'SET_MODE']);
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
