'use strict';

/**
 * Tests for nodes/mavlink-in, mavlink-out, and mavlink-build (DESIGN.md §9,
 * §12 step 5). No full Node-RED runtime — a minimal stub RED drives the node
 * constructors and exercises their behaviour in isolation.
 *
 * Pain points guarded:
 *   - mavlink-in: subscribe/unsubscribe lifecycle, filter, changed-only,
 *     rate-limit, invalid config guard
 *   - mavlink-out: suppress (payload===false), resolved message shape,
 *     band/target/identity forwarding, invalid config
 *   - mavlink-build: suppress, Build tier output shape, Send tier enqueue,
 *     invalid config guards (no vehicle, no message, bad messageName)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { TIER, shouldSuppress } = require('../../lib/delivery');

// ---------------------------------------------------------------------------
// RED stub
// ---------------------------------------------------------------------------

/**
 * Minimal stub of the Node-RED `RED` object. Stores registered node types and
 * known config nodes; does not implement HTTP admin routes.
 *
 * @returns {object}
 */
function makeRED() {
  const nodeTypes = {};
  const configNodes = {};
  return {
    nodes: {
      registerType(type, constructor, _opts) {
        nodeTypes[type] = constructor;
      },
      getNode(id) {
        return configNodes[id] || null;
      },
      /**
       * Node-RED sets up node infrastructure. In tests the node instance is
       * already pre-built by makeNodeInstance(); createNode is a no-op here
       * since we use Constructor.call(node, config) which gives the node
       * its own EventEmitter / input-handler plumbing via makeNodeInstance.
       */
      createNode(_node, _config) {},
      _register(id, nodeObj) {
        configNodes[id] = nodeObj;
      },
    },
    httpAdmin: {
      get() {},
    },
    auth: {
      needsPermission() { return (_req, _res, next) => next && next(); },
    },
    _nodeTypes: nodeTypes,
  };
}

/**
 * Build a minimal Node-RED node instance (the `this` inside a node constructor)
 * with stubbed `status`, `error`, `send`, `on`, and `log` methods.
 *
 * @param {object} [config]
 * @returns {object}
 */
function makeNodeInstance(config = {}) {
  const node = {
    id: config.id || 'test-node',
    _status: null,
    _errors: [],
    _sends: [],
    _doneErrors: [],
    _handlers: {},
    _closed: false,

    status(s) { this._status = s; },
    error(msg, _context) { this._errors.push(msg); },
    send(msgs) { this._sends.push(msgs); },
    log() {},
    warn() {},

    on(event, fn) {
      if (!this._handlers[event]) this._handlers[event] = [];
      this._handlers[event].push(fn);
    },

    /**
     * Simulate Node-RED dispatching an inbound msg. The runtime always supplies
     * both `send` and `done` (node-red >=4), so this passes both; `send`
     * records through the same `_sends` sink `node.send` uses, and errors
     * routed through `done` — the Catch path — land in `_doneErrors`.
     */
    _input(msg) {
      const done = (err) => { if (err) this._doneErrors.push(err); };
      const send = (msgs) => this.send(msgs);
      for (const fn of (this._handlers.input || [])) fn(msg, send, done);
    },

    /** Simulate Node-RED closing the node. */
    _close() {
      this._closed = true;
      for (const fn of (this._handlers.close || [])) fn(() => {});
    },
  };
  return node;
}

// ---------------------------------------------------------------------------
// Shared connection stub
// ---------------------------------------------------------------------------

/**
 * Build a connection stub with a controllable subscribe/send pair.
 *
 * The stub applies the subscription filter when delivering messages, mirroring
 * what `SubscriptionRegistry.dispatch` does in the real Connection (§7). This
 * means tests for mavlink-in's filter config exercise the actual filter the
 * node passes to `subscribe`, not just the node's internal handling.
 *
 * @returns {{ stub: object, sent: object[], subscribers: object[] }}
 */
function makeConnectionStub() {
  const sent = [];
  const subscribers = [];

  /** Inline filter matching from SubscriptionRegistry (§7). */
  function filterMatches(filter, decoded) {
    if (filter.message !== undefined && filter.message !== decoded.name) return false;
    if (filter.sysid !== undefined && filter.sysid !== decoded.sysid) return false;
    if (filter.compid !== undefined && filter.compid !== decoded.compid) return false;
    return true;
  }

  const stub = {
    // Real connections always expose the frozen profile snapshot; `id` is the
    // profile node id the wire tier resolves for its dialect bundle.
    vehicle: Object.freeze({
      id: 'v1',
      targetSystem: 1,
      targetComponent: 1,
      firmware: 'ardupilot',
      dialect: 'test',
      autopilot: 3,
    }),
    subscribe(filter, handler) {
      const entry = { filter: filter || {}, handler };
      subscribers.push(entry);
      return () => {
        const idx = subscribers.indexOf(entry);
        if (idx !== -1) subscribers.splice(idx, 1);
      };
    },
    send(message, opts) {
      sent.push({ message, opts });
    },
    /**
     * Deliver a decoded message to every subscriber whose filter matches.
     * Mirrors SubscriptionRegistry.dispatch so tests are realistic.
     */
    _deliver(decoded) {
      for (const { filter, handler } of subscribers) {
        if (filterMatches(filter, decoded)) handler(decoded);
      }
    },
  };
  return { stub, sent, subscribers };
}

// ---------------------------------------------------------------------------
// Vehicle stub with a minimal dialect bundle
// ---------------------------------------------------------------------------

/**
 * Build a minimal vehicle stub exposing a tiny in-memory dialect bundle.
 * The bundle's HEARTBEAT message has two fields: `type` (uint8_t) and
 * `autopilot` (uint8_t), enough to exercise the codec path.
 *
 * @returns {object} vehicle node stub
 */
function makeVehicleStub() {
  const bundle = {
    dialect: 'test',
    version: null,
    files: ['test'],
    fetched: null,
    enums: {
      MAV_TYPE: {
        name: 'MAV_TYPE',
        bitmask: false,
        description: null,
        entries: [
          { name: 'MAV_TYPE_GENERIC', value: 0, description: null },
          { name: 'MAV_TYPE_GCS', value: 6, description: null },
        ],
      },
    },
    messages: {
      HEARTBEAT: {
        id: 0,
        name: 'HEARTBEAT',
        description: null,
        fields: [
          {
            name: 'type',
            type: 'uint8_t',
            arrayLength: null,
            extension: false,
            enum: 'MAV_TYPE',
            display: null,
            units: null,
            invalid: null,
            minValue: null,
            maxValue: null,
            increment: null,
            description: null,
          },
          {
            name: 'autopilot',
            type: 'uint8_t',
            arrayLength: null,
            extension: false,
            enum: null,
            display: null,
            units: null,
            invalid: null,
            minValue: null,
            maxValue: null,
            increment: null,
            description: null,
          },
        ],
      },
    },
    messagesById: { '0': 'HEARTBEAT' },
    commands: {},
    overrides: [],
  };

  return {
    id: 'vehicle-1',
    getDialect: () => bundle,
    getDefaults: () => ({
      vehicleFamily: 'unknown',
      firmware: 'ardupilot',
      dialect: 'ardupilotmega',
      dialectRevision: 'seed',
      defaultTargetSystem: 1,
      defaultTargetComponent: 1,
    }),
  };
}

// ---------------------------------------------------------------------------
// mavlink-in tests
// ---------------------------------------------------------------------------

test('mavlink-in: marks invalid config when connection is missing', () => {
  const RED = makeRED();
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ id: 'n1', connection: 'missing' });
  Constructor.call(node, { connection: 'missing' });
  assert.equal(node._status && node._status.fill, 'red');
  assert.equal(node._status && node._status.shape, 'ring');
});

test('mavlink-in: subscribes to the connection on construction', () => {
  const RED = makeRED();
  const { stub, subscribers } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });
  assert.equal(subscribers.length, 1);
});

test('mavlink-in: emits msg on matching inbound decoded message', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });

  assert.equal(node._sends.length, 1);
  const out = node._sends[0];
  assert.equal(out.topic, 'HEARTBEAT');
  assert.deepEqual(out.payload, { type: 6 });
  assert.equal(out.sysid, 1);
  assert.equal(out.compid, 1);
  assert.equal(out.trusted, true);
});

test('mavlink-in: the badge counts deliveries, count first so it survives the cap', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  assert.deepEqual(node._status, { fill: 'grey', shape: 'ring', text: 'waiting' });

  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: {}, trusted: true });
  assert.equal(node._status.text, '1 HEARTBEAT');
  assert.equal(node._status.fill, 'green');

  // A different name refreshes immediately — the badge must not lag behind
  // which stream is arriving, even inside the throttle window.
  stub._deliver({ name: 'ATTITUDE', sysid: 1, compid: 1, fields: {}, trusted: true });
  assert.equal(node._status.text, '2 ATTITUDE');

  // The count is node-wide, not per message name.
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: {}, trusted: true });
  assert.equal(node._status.text, '3 HEARTBEAT');

  // Count leads so capBadge's tail truncation eats the name, never the number:
  // GLOBAL_POSITION_INT is 19 of the 24 characters §6 allows.
  stub._deliver({ name: 'GLOBAL_POSITION_INT', sysid: 1, compid: 1, fields: {}, trusted: true });
  assert.ok(node._status.text.startsWith('4 '), `count leads: ${node._status.text}`);
  assert.ok(node._status.text.length <= 24, `badge capped: ${node._status.text}`);
});

test('mavlink-in: a same-name burst is throttled, and the count still counts it', () => {
  // The count changes on every delivery, so throttling on rendered text would
  // never fire — a 50 Hz stream would rewrite the badge 50×/s. The throttle
  // keys on the message name instead; deliveries are still counted while it
  // holds, so the next badge write jumps to the true total.
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  const writes = [];
  node.status = (s) => { node._status = s; writes.push(s.text); };

  for (let i = 0; i < 40; i++) {
    stub._deliver({ name: 'ATTITUDE', sysid: 1, compid: 1, fields: {}, trusted: true });
  }

  assert.equal(node._sends.length, 40, 'every message is still delivered');
  assert.ok(writes.length < 40, `badge writes throttled: ${writes.length} for 40 messages`);
  assert.equal(writes[0], '1 ATTITUDE', 'first delivery paints immediately');
});

test('mavlink-in: message filter rejects non-matching message names', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', messages: ['HEARTBEAT'] });

  stub._deliver({ name: 'GLOBAL_POSITION_INT', sysid: 1, compid: 1, fields: { alt: 100 }, trusted: true });
  assert.equal(node._sends.length, 0);

  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });
  assert.equal(node._sends.length, 1);
});

test('mavlink-in: several message filters each deliver, once (#211)', () => {
  const RED = makeRED();
  const { stub, subscribers } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', messages: ['HEARTBEAT', 'ATTITUDE'] });

  // One subscription per name, so a name can never match two filters and
  // deliver twice.
  assert.equal(subscribers.length, 2, 'one subscription per configured name');

  stub._deliver({ name: 'GLOBAL_POSITION_INT', sysid: 1, compid: 1, fields: {}, trusted: true });
  assert.equal(node._sends.length, 0, 'an unlisted message is still dropped');

  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });
  stub._deliver({ name: 'ATTITUDE', sysid: 1, compid: 1, fields: { roll: 0.1 }, trusted: true });
  assert.equal(node._sends.length, 2, 'each listed message delivers exactly once');
});

test('mavlink-in: an empty message list receives everything (#211)', () => {
  const RED = makeRED();
  const { stub, subscribers } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', messages: [] });

  assert.equal(subscribers.length, 1, 'one unfiltered subscription, not zero');
  stub._deliver({ name: 'GLOBAL_POSITION_INT', sysid: 1, compid: 1, fields: {}, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: {}, trusted: true });
  assert.equal(node._sends.length, 2, 'an empty list is the old blank filter: match all');
});

test('mavlink-in: close releases every subscription, not just the first (#211)', () => {
  const RED = makeRED();
  const { stub, subscribers } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', messages: ['HEARTBEAT', 'ATTITUDE', 'SYS_STATUS'] });
  assert.equal(subscribers.length, 3);

  // Holding N unsubscribes means the close path has to walk them; keeping only
  // the last would leave two subscribers dispatching into a torn-down node.
  for (const fn of node._handlers.close || []) fn();
  assert.equal(subscribers.length, 0, 'every subscription is torn down');

  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: {}, trusted: true });
  assert.equal(node._sends.length, 0, 'nothing is delivered after close');
});

test('mavlink-in: sysid filter drops messages from other systems', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', sysid: '2' });

  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });
  assert.equal(node._sends.length, 0, 'sysid 1 should be filtered out');

  stub._deliver({ name: 'HEARTBEAT', sysid: 2, compid: 1, fields: { type: 6 }, trusted: true });
  assert.equal(node._sends.length, 1, 'sysid 2 should pass through');
});

test('mavlink-in: changed-only skips messages with identical fields', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', changedOnly: true });

  const fields = { type: 6 };
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields, trusted: true });

  assert.equal(node._sends.length, 1, 'only the first delivery should pass through');
});

test('mavlink-in: changed-only forwards when fields change', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', changedOnly: true });

  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 2 }, trusted: true });

  assert.equal(node._sends.length, 2);
});

test('mavlink-in: changed-only compares only the listed fields when Compare fields is set', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', changedOnly: true, changedFields: 'custom_mode' });

  // A hot timestamp changes every frame; the compared field does not.
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { custom_mode: 4, t: 1 }, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { custom_mode: 4, t: 2 }, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { custom_mode: 5, t: 3 }, trusted: true });

  assert.equal(node._sends.length, 2, 'only the first frame and the mode change pass');
});

test('mavlink-in: field predicate passes on presence, and on value when one is given', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', fieldName: 'custom_mode', fieldValue: '4' });

  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { custom_mode: 5 }, trusted: true });
  stub._deliver({ name: 'SYS_STATUS', sysid: 1, compid: 1, fields: { load: 100 }, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { custom_mode: 4 }, trusted: true });

  assert.equal(node._sends.length, 1, 'only the matching value passes');
  assert.equal(node._sends[0].payload.custom_mode, 4);
});

test('mavlink-in: NAME=Hz pairs rate-limit per message name; unlisted names use the bare default', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  // ATTITUDE throttled hard; HEARTBEAT explicitly unlimited; no bare default.
  Constructor.call(node, { connection: 'conn-1', rateLimit: 'ATTITUDE=0.001, HEARTBEAT=0' });

  stub._deliver({ name: 'ATTITUDE', sysid: 1, compid: 1, fields: { roll: 0.1 }, trusted: true });
  stub._deliver({ name: 'ATTITUDE', sysid: 1, compid: 1, fields: { roll: 0.2 }, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });

  assert.equal(
    node._sends.filter((m) => m.topic === 'ATTITUDE').length, 1,
    'second ATTITUDE inside the interval is dropped'
  );
  assert.equal(
    node._sends.filter((m) => m.topic === 'HEARTBEAT').length, 2,
    'NAME=0 means unlimited for that name'
  );
});

test('mavlink-in: the editor validates the rate-limit shape; runtime trusts the saved config (§2)', () => {
  // AGENTS: "Runtime code MUST NOT duplicate validation already performed by
  // the editor." A hand-edited unreadable token is skipped (like fanout's
  // unparseable params JSON), never a second deploy-time error path.
  const RED = makeRED();
  const { stub, subscribers } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', rateLimit: 'ATTITUDE=fast, HEARTBEAT=0.001' });

  assert.equal(subscribers.length, 1, 'the node subscribes normally');
  stub._deliver({ name: 'ATTITUDE', sysid: 1, compid: 1, fields: { roll: 0.1 }, trusted: true });
  stub._deliver({ name: 'ATTITUDE', sysid: 1, compid: 1, fields: { roll: 0.2 }, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });
  assert.equal(
    node._sends.filter((m) => m.topic === 'ATTITUDE').length, 2,
    'the unreadable pair is skipped — ATTITUDE unlimited'
  );
  assert.equal(
    node._sends.filter((m) => m.topic === 'HEARTBEAT').length, 1,
    'the readable pair still limits its message'
  );
});

test('mavlink-in: a blank pair value does not fall open to unlimited', () => {
  // `Number('')` is 0 and `NAME=0` means unlimited, so the naive parse turns a
  // typo into "delete the limit the operator asked for" — and a later blank
  // token clobbers a good earlier one. Skipping the unreadable value leaves
  // the message on the bare default: the node keeps skipping.
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  // Default 0.001 Hz for everything; the ATTITUDE pair is a typo, and the
  // second HEARTBEAT token would otherwise erase the first.
  Constructor.call(node, {
    connection: 'conn-1',
    rateLimit: '0.001, ATTITUDE=, HEARTBEAT=0.001, HEARTBEAT=',
  });

  stub._deliver({ name: 'ATTITUDE', sysid: 1, compid: 1, fields: { roll: 0.1 }, trusted: true });
  stub._deliver({ name: 'ATTITUDE', sysid: 1, compid: 1, fields: { roll: 0.2 }, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });

  assert.equal(
    node._sends.filter((m) => m.topic === 'ATTITUDE').length, 1,
    'the blank pair falls back to the bare default, not to unlimited'
  );
  assert.equal(
    node._sends.filter((m) => m.topic === 'HEARTBEAT').length, 1,
    'a trailing blank token does not erase the readable limit before it'
  );
});

test('mavlink-in: changed-only does not crash on 64-bit BigInt fields (SYSTEM_TIME-style)', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', changedOnly: true });

  // node-mavlink decodes uint64_t fields as BigInt; JSON.stringify throws on a
  // bare BigInt with no replacer, and an uncaught throw here would propagate
  // out of the socket event handler and kill the Node-RED process.
  assert.doesNotThrow(() => {
    stub._deliver({
      name: 'SYSTEM_TIME',
      sysid: 1,
      compid: 1,
      fields: { time_unix_usec: 1700000000000000n, time_boot_ms: 12345 },
      trusted: true,
    });
  });
  assert.equal(node._sends.length, 1);
  // msg.payload must carry the original BigInt untouched — the fix only
  // changes the internal changed-only comparison, not the output shape.
  assert.equal(node._sends[0].payload.time_unix_usec, 1700000000000000n);

  // A second, identical delivery must still be recognised as unchanged.
  stub._deliver({
    name: 'SYSTEM_TIME',
    sysid: 1,
    compid: 1,
    fields: { time_unix_usec: 1700000000000000n, time_boot_ms: 12345 },
    trusted: true,
  });
  assert.equal(node._sends.length, 1, 'identical BigInt fields must be treated as unchanged');

  // A changed BigInt field must still be recognised as changed.
  stub._deliver({
    name: 'SYSTEM_TIME',
    sysid: 1,
    compid: 1,
    fields: { time_unix_usec: 1700000000001000n, time_boot_ms: 12346 },
    trusted: true,
  });
  assert.equal(node._sends.length, 2, 'a changed BigInt field must pass through');
  // Assert the forwarded frame is the CHANGED one — a count alone would let a
  // regression that forwards the duplicate and suppresses the change pass.
  assert.equal(node._sends[1].payload.time_unix_usec, 1700000000001000n);
});

test('mavlink-in: changed-only tracks independently per (message, sysid, compid)', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', changedOnly: true });

  const fields = { type: 6 };
  // Same fields but from two different sysids — both should pass through.
  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields, trusted: true });
  stub._deliver({ name: 'HEARTBEAT', sysid: 2, compid: 1, fields, trusted: true });

  assert.equal(node._sends.length, 2);
});

test('mavlink-in: rate limit drops excess messages within the window', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  // 1 msg/s → minimum 1000 ms between deliveries.
  Constructor.call(node, { connection: 'conn-1', rateLimit: 1 });

  // Fire 5 messages in rapid succession (same ms timestamp in practice).
  for (let i = 0; i < 5; i++) {
    stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: i }, trusted: true });
  }

  // Only the first should get through.
  assert.equal(node._sends.length, 1);
});

test('mavlink-in: unsubscribes from the connection on close', () => {
  const RED = makeRED();
  const { stub, subscribers } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  assert.equal(subscribers.length, 1);
  node._close();
  assert.equal(subscribers.length, 0, 'subscription should be removed on close');
});

// ---------------------------------------------------------------------------
// mavlink-out tests
// ---------------------------------------------------------------------------

test('mavlink-out: marks invalid config when connection is missing', () => {
  const RED = makeRED();
  require('../../nodes/mavlink-out')(RED);
  const Constructor = RED._nodeTypes['mavlink-out'];
  const node = makeNodeInstance({ connection: 'missing' });
  Constructor.call(node, { connection: 'missing' });
  assert.equal(node._status && node._status.fill, 'red');
});

test('mavlink-out: suppresses when msg.payload === false', () => {
  const RED = makeRED();
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-out')(RED);
  const Constructor = RED._nodeTypes['mavlink-out'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  node._input({ payload: false });

  assert.equal(node._sends.length, 0, 'suppress: neither output fires');
  assert.equal(sent.length, 0, 'suppress: nothing sent to connection');
});

test('mavlink-out: sends a decoded-shape message and emits on both outputs', () => {
  const RED = makeRED();
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-out')(RED);
  const Constructor = RED._nodeTypes['mavlink-out'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  const msg = { payload: { name: 'HEARTBEAT', fields: { type: 6, autopilot: 8 } } };
  node._input(msg);

  // Connection called with the message.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.name, 'HEARTBEAT');
  assert.deepEqual(sent[0].message.fields, { type: 6, autopilot: 8 });

  // Both outputs fired.
  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.equal(out0, msg, 'output 0 is the original msg');
  assert.equal(out1.result, 'sent');
  assert.equal(out1.message, 'HEARTBEAT');
});

test('mavlink-out: unwraps Build-tier envelope from mavlink-build', () => {
  const RED = makeRED();
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-out')(RED);
  const Constructor = RED._nodeTypes['mavlink-out'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  // This is the shape mavlink-build emits on output 0 in Build tier.
  const envelope = {
    message: { name: 'HEARTBEAT', fields: { type: 6 } },
    messageName: 'HEARTBEAT',
    tier: TIER.BUILD,
  };
  node._input({ payload: envelope });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.name, 'HEARTBEAT');
});

test('mavlink-out: forwards the mavlink-in shape (name in msg.topic, fields in msg.payload)', () => {
  const RED = makeRED();
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-out')(RED);
  const Constructor = RED._nodeTypes['mavlink-out'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  // This is exactly what mavlink-in emits: name in topic, fields in payload.
  node._input({ topic: 'HEARTBEAT', payload: { type: 6, autopilot: 8 }, sysid: 1, compid: 1 });

  assert.equal(sent.length, 1, 'a direct In → Out flow must forward without a Function node');
  assert.equal(sent[0].message.name, 'HEARTBEAT');
  assert.deepEqual(sent[0].message.fields, { type: 6, autopilot: 8 });
});

test('mavlink-out: uses msg.band when provided', () => {
  const RED = makeRED();
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-out')(RED);
  const Constructor = RED._nodeTypes['mavlink-out'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', band: '2' });

  node._input({ payload: { name: 'HEARTBEAT', fields: {} }, band: 4 });
  assert.equal(sent[0].opts.band, 4);
});

test('mavlink-out: uses default band from config when msg.band is absent', () => {
  const RED = makeRED();
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-out')(RED);
  const Constructor = RED._nodeTypes['mavlink-out'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', band: '3' });

  node._input({ payload: { name: 'HEARTBEAT', fields: {} } });
  assert.equal(sent[0].opts.band, 3);
});

test('mavlink-out: forwards target from msg to the connection send', () => {
  const RED = makeRED();
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-out')(RED);
  const Constructor = RED._nodeTypes['mavlink-out'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  node._input({
    payload: { name: 'HEARTBEAT', fields: {} },
    target: { sysid: 2, compid: 1 },
  });
  assert.deepEqual(sent[0].opts.target, { sysid: 2, compid: 1 });
});

test('mavlink-out: rejects unrecognised payload and emits error status on output 1', () => {
  const RED = makeRED();
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-out')(RED);
  const Constructor = RED._nodeTypes['mavlink-out'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  node._input({ payload: 'not-an-object' });

  assert.equal(sent.length, 0, 'nothing should be sent to the connection');
  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.equal(out0, null);
  assert.equal(out1.result, 'failed');
});

test('mavlink-out: a connection send throw becomes a failed status record, not an uncaught throw', () => {
  const RED = makeRED();
  const throwingConn = {
    vehicle: Object.freeze({ id: 'v1', dialect: 'test' }),
    send() { throw new Error('Control band full'); },
    subscribe() { return () => {}; },
  };
  RED.nodes._register('conn-1', throwingConn);
  require('../../nodes/mavlink-out')(RED);
  const Constructor = RED._nodeTypes['mavlink-out'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  assert.doesNotThrow(() => node._input({ payload: { name: 'HEARTBEAT', fields: {} } }));
  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.equal(out0, null, 'output 0 must not fire when the send fails');
  assert.equal(out1.result, 'failed');
  assert.equal(node._doneErrors.length, 1, 'the failure reaches Catch via done(err)');
});

// ---------------------------------------------------------------------------
// mavlink-build tests
// ---------------------------------------------------------------------------

test('mavlink-build: marks invalid config when vehicle is missing', () => {
  const RED = makeRED();
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'missing' });
  Constructor.call(node, { vehicle: 'missing', dialect: '__vehicle' });
  assert.equal(node._status && node._status.fill, 'red');
});

test('mavlink-build: a resolvable config clears any stale badge at deploy', () => {
  // The runtime publishes a status clear only when a node is *removed*
  // (@node-red/runtime flows/Flow.js:395-399), and the editor simply replays
  // whatever status events arrive. A node that was misconfigured, then fixed
  // and redeployed, therefore kept showing the dead red badge until a message
  // happened to flow through. Constructing successfully must say so.
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, { vehicle: 'v1', dialect: '__vehicle', tier: 'build' });

  assert.deepEqual(node._status, {}, 'a good config clears rather than badges');
});

test('mavlink-build: defaults empty messageName to HEARTBEAT', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, { vehicle: 'v1', dialect: '__vehicle', messageName: '', tier: 'build' });

  node._input({ payload: { type: 6, autopilot: 3 } });

  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.equal(out0.payload.messageName, 'HEARTBEAT');
  assert.equal(out1.result, 'built');
});

test('mavlink-build: marks invalid config when messageName is not in dialect', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, { vehicle: 'v1', dialect: '__vehicle', messageName: 'NONEXISTENT_MSG' });
  assert.equal(node._status && node._status.fill, 'red');
});

test('mavlink-build: suppresses when msg.payload === false', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, { vehicle: 'v1', dialect: '__vehicle', messageName: 'HEARTBEAT', tier: 'build' });

  node._input({ payload: false });

  assert.equal(node._sends.length, 0);
});

test('mavlink-build Build tier: output 0 carries the built message envelope', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, {
    vehicle: 'v1',
    dialect: '__vehicle',
    messageName: 'HEARTBEAT',
    tier: 'build',
    fields: JSON.stringify({ type: 6, autopilot: 3 }),
  });

  node._input({ payload: {} });

  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];

  // output 0: the built message envelope.
  assert.ok(out0, 'output 0 must fire');
  assert.ok(out0.payload, 'output 0 must carry a payload');
  assert.equal(out0.payload.messageName, 'HEARTBEAT');
  assert.equal(out0.payload.tier, TIER.BUILD);
  assert.ok(out0.payload.message, 'payload.message must be present');
  assert.equal(out0.payload.message.name, 'HEARTBEAT');
  assert.deepEqual(out0.payload.message.fields, { type: 6, autopilot: 3 });

  // output 1: status record.
  assert.equal(out1.result, 'built');
});

test('mavlink-build Build tier: msg.payload overrides config fields', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, {
    vehicle: 'v1',
    dialect: '__vehicle',
    messageName: 'HEARTBEAT',
    tier: 'build',
    fields: JSON.stringify({ type: 6, autopilot: 3 }),
  });

  // Override autopilot to 8.
  node._input({ payload: { autopilot: 8 } });

  const [out0] = node._sends[0];
  assert.equal(out0.payload.message.fields.autopilot, 8, 'msg.payload override should win');
  assert.equal(out0.payload.message.fields.type, 6, 'config default should remain for non-overridden fields');
});

test('mavlink-build Send tier: enqueues on the connection and emits on both outputs', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1', connection: 'conn-1' });
  Constructor.call(node, {
    vehicle: 'v1',
    connection: 'conn-1',
    messageName: 'HEARTBEAT',
    tier: 'send',
    fields: JSON.stringify({ type: 6, autopilot: 3 }),
  });

  const inMsg = { payload: { marker: 'from-upstream' } };
  node._input(inMsg);

  // Connection must have received the message.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.name, 'HEARTBEAT');
  assert.deepEqual(sent[0].message.fields, { type: 6, autopilot: 3 });

  // §9: output 0 is a pass-through trigger on Send — it preserves the inbound
  // payload rather than replacing it with a Build envelope.
  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.ok(out0, 'output 0 must fire');
  assert.deepEqual(out0.payload, { marker: 'from-upstream' }, 'Send output 0 passes the trigger through unchanged');
  assert.equal(out1.result, 'sent');
});

test('mavlink-build Send tier: a connection send throw becomes a failed status record, not an uncaught throw', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  const throwingConn = {
    vehicle: Object.freeze({ id: 'v1', dialect: 'test' }),
    send() { throw new Error('Control band full'); },
    subscribe() { return () => {}; },
  };
  RED.nodes._register('conn-1', throwingConn);
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1', connection: 'conn-1' });
  Constructor.call(node, {
    vehicle: 'v1',
    connection: 'conn-1',
    messageName: 'HEARTBEAT',
    tier: 'send',
    fields: JSON.stringify({ type: 6, autopilot: 3 }),
  });

  assert.doesNotThrow(() => node._input({ payload: {} }));
  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.equal(out0, null, 'output 0 must not fire when the send fails');
  assert.equal(out1.result, 'failed');
  assert.equal(node._doneErrors.length, 1, 'the failure reaches Catch via done(err)');
});

test('mavlink-build: unreadable fields JSON is not caught — the editor already refused it', () => {
  // Two guardrails have stood here. The original badged and returned before
  // registering an input handler, so every message the node was wired to
  // receive vanished. The replacement fell back to {}, which on a Send tier
  // transmitted a blank-field message and reported success — worse.
  //
  // Neither is wanted. The editor validates this field, so reaching the
  // constructor with bad JSON means a hand-edited flow or a deploy forced past
  // a red field: AGENTS.md:520-529 classifies both as unsupported paths and
  // says not to add the guard. Node-RED contains a throwing constructor, logs
  // it, and loads the rest of the flow.
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });

  assert.throws(() => Constructor.call(node, {
    vehicle: 'v1',
    dialect: '__vehicle',
    messageName: 'HEARTBEAT',
    tier: 'build',
    fields: '{ not valid json',
  }), SyntaxError);
});

test('mavlink-build Send tier: a missing Connection is a misconfiguration, not a Build', () => {
  // Was: "falls back to Build when no connection configured", asserting that a
  // Send with no Connection emits a built message on output 0 and reports
  // `built`. That is the silent degrade §9 forbids everywhere else — it reports
  // success for something that was never transmitted, and it invents a tier the
  // operator did not choose. The clamp that produced it is gone.
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, {
    vehicle: 'v1',
    dialect: '__vehicle',
    messageName: 'HEARTBEAT',
    tier: 'send',   // requests Send but no connection
    fields: JSON.stringify({ type: 6, autopilot: 3 }),
  });

  assert.equal(node._status && node._status.fill, 'red', 'says so at deploy (§6)');
  assert.equal(node._sends.length, 0, 'and emits nothing it did not send');
});

test('mavlink-build Build tier: codec error emits error status on output 1', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, {
    vehicle: 'v1',
    dialect: '__vehicle',
    messageName: 'HEARTBEAT',
    tier: 'build',
    // 'type' is uint8_t — passing undefined triggers a FieldCodecError.
    fields: JSON.stringify({ type: undefined }),
  });

  // Force the bad encode by setting type to null via override (undefined survives JSON.parse as the key is absent).
  node._input({ payload: { type: null } });

  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.equal(out0, null, 'output 0 must not fire on codec error');
  assert.equal(out1.result, 'failed');
  assert.ok(typeof out1.detail === 'string');
});

test('mavlink-build: close stops the repeat timer', () => {
  // We can't assert that clearInterval was called without a fake timer,
  // but we can verify close() completes without error when a timer is active.
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, {
    vehicle: 'v1',
    dialect: '__vehicle',
    messageName: 'HEARTBEAT',
    tier: 'build',
    fields: '{}',
    repeatMs: 60000,  // Long enough to not actually fire in the test.
  });

  // Should not throw.
  node._close();
  assert.ok(node._closed);
});

// ---------------------------------------------------------------------------
// Integration: mavlink-build Build tier → mavlink-out
// ---------------------------------------------------------------------------

test('integration: Build tier output is forwarded and sent by mavlink-out', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  const { stub: connStub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', connStub);

  require('../../nodes/mavlink-build')(RED);
  require('../../nodes/mavlink-out')(RED);

  const BuildConstructor = RED._nodeTypes['mavlink-build'];
  const OutConstructor = RED._nodeTypes['mavlink-out'];

  const buildNode = makeNodeInstance({ vehicle: 'v1' });
  BuildConstructor.call(buildNode, {
    vehicle: 'v1',
    dialect: '__vehicle',
    messageName: 'HEARTBEAT',
    tier: 'build',
    fields: JSON.stringify({ type: 6, autopilot: 3 }),
  });

  const outNode = makeNodeInstance({ connection: 'conn-1' });
  OutConstructor.call(outNode, { connection: 'conn-1' });

  // Trigger the build.
  buildNode._input({ payload: {} });
  const [buildOut0] = buildNode._sends[0];

  // Feed build output 0 into mavlink-out.
  outNode._input(buildOut0);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.name, 'HEARTBEAT');
  assert.deepEqual(sent[0].message.fields, { type: 6, autopilot: 3 });
});

// ---------------------------------------------------------------------------
// mavlink-build: dialect config without vehicle (§6 role × tier matrix)
// ---------------------------------------------------------------------------

test('mavlink-build Build tier: plain dialect config loads bundled dialect without a vehicle', () => {
  const RED = makeRED();
  // No vehicle registered — the node must bootstrap from the bundled dialect.
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance();
  Constructor.call(node, {
    // No vehicle.
    dialect: 'common',
    messageName: 'HEARTBEAT',
    tier: 'build',
    fields: '{}',
  });

  assert.notEqual(
    node._status && node._status.fill, 'red',
    'node must not be in error state when dialect resolves without a vehicle'
  );

  node._input({ payload: {} });

  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.ok(out0, 'output 0 must fire');
  assert.equal(out0.payload.messageName, 'HEARTBEAT');
  assert.equal(out0.payload.tier, TIER.BUILD);
  assert.ok(out0.payload.message, 'payload.message must be present');
  assert.equal(out0.payload.message.name, 'HEARTBEAT');
  assert.equal(out1.result, 'built');
});

test('mavlink-build wire tier: custom-dialect connection profile resolves via getDialect(), not the bundled registry', () => {
  const RED = makeRED();
  // A custom XML profile: its dialect *name* is not in the bundled registry,
  // so any loadBundled(name) path would throw at deploy. The bundle itself is
  // the stub's compiled test bundle — getDialect() is the working invocation.
  const customProfile = makeVehicleStub();
  RED.nodes._register('v-custom', customProfile);
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', {
    ...stub,
    vehicle: Object.freeze({ id: 'v-custom', dialect: 'my_custom_dialect' }),
  });
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, {
    connection: 'conn-1',
    dialect: 'ardupilotmega', // stale build-tier picker value: ignored on wire
    messageName: 'HEARTBEAT',
    tier: 'send',
    fields: JSON.stringify({ type: 6, autopilot: 3 }),
  });

  assert.notEqual(node._status && node._status.fill, 'red',
    'custom wire dialect must not fail deploy');

  node._input({ payload: {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.name, 'HEARTBEAT');
});

test('mavlink-build wire tier: stale hidden config.vehicle cannot override the connection profile (hidden is not honored)', () => {
  const RED = makeRED();
  // The stale explicit vehicle's bundle carries no HEARTBEAT; the connection
  // profile's bundle does. If the wire tier honored the hidden vehicle field,
  // deploy would flag 'unknown message'.
  const staleProfile = makeVehicleStub();
  staleProfile.getDialect = () => ({
    dialect: 'stale', version: null, files: [], fetched: null, enums: {}, messages: {},
  });
  RED.nodes._register('v-stale', staleProfile);
  RED.nodes._register('v1', makeVehicleStub());
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', stub); // stub.vehicle.id === 'v1'
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v-stale', connection: 'conn-1' });
  Constructor.call(node, {
    vehicle: 'v-stale',
    connection: 'conn-1',
    messageName: 'HEARTBEAT',
    tier: 'send',
    fields: '{}',
  });

  assert.notEqual(node._status && node._status.fill, 'red',
    'connection profile governs the wire tier, not the hidden vehicle field');

  node._input({ payload: {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.name, 'HEARTBEAT');
});

// ---------------------------------------------------------------------------
// shouldSuppress contract (unit, for completeness in this file)
// ---------------------------------------------------------------------------

test('shouldSuppress: true only for payload === false, not falsy', () => {
  assert.equal(shouldSuppress({ payload: false }), true);
  assert.equal(shouldSuppress({ payload: null }), false);
  assert.equal(shouldSuppress({ payload: 0 }), false);
  assert.equal(shouldSuppress({ payload: '' }), false);
  assert.equal(shouldSuppress({ payload: undefined }), false);
});
