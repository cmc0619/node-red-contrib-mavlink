'use strict';

/**
 * Tests for nodes/mavlink-in, mavlink-out, and mavlink-build (DESIGN.md §9,
 * §12 step 5). No full Node-RED runtime — a minimal stub RED drives the node
 * constructors and exercises their behaviour in isolation.
 *
 * Pain points guarded:
 *   - mavlink-in: subscribe/unsubscribe lifecycle, filter, changed-only,
 *     rate-limit, invalid config guard
 *   - mavlink-out: suppress (payload===false), refuse status record miswire,
 *     resolved message shape, band/target/identity forwarding, invalid config
 *   - mavlink-build: suppress, refuse, Build tier output shape, Send tier
 *     enqueue, invalid config guards (no vehicle, no message, bad messageName)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isStatusRecord, makeStatusRecord, TIER, shouldSuppress } = require('../../lib/delivery');

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

    /** Simulate Node-RED dispatching an inbound msg. */
    _input(msg) {
      for (const fn of (this._handlers.input || [])) fn(msg);
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
      vehicleFamily: 'generic',
      firmware: 'ardupilot',
      dialect: 'ardupilotmega',
      dialectSource: 'bundled',
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

test('mavlink-in: message filter rejects non-matching message names', () => {
  const RED = makeRED();
  const { stub } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-in')(RED);
  const Constructor = RED._nodeTypes['mavlink-in'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1', message: 'HEARTBEAT' });

  stub._deliver({ name: 'GLOBAL_POSITION_INT', sysid: 1, compid: 1, fields: { alt: 100 }, trusted: true });
  assert.equal(node._sends.length, 0);

  stub._deliver({ name: 'HEARTBEAT', sysid: 1, compid: 1, fields: { type: 6 }, trusted: true });
  assert.equal(node._sends.length, 1);
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

test('mavlink-out: refuses a status record input and emits on output 1', () => {
  const RED = makeRED();
  const { stub, sent } = makeConnectionStub();
  RED.nodes._register('conn-1', stub);
  require('../../nodes/mavlink-out')(RED);
  const Constructor = RED._nodeTypes['mavlink-out'];
  const node = makeNodeInstance({ connection: 'conn-1' });
  Constructor.call(node, { connection: 'conn-1' });

  // When output 1 of a node is wired to an action node's input, the status
  // record IS the entire msg — the marker is at the top level of msg, not
  // nested inside msg.payload (§9 "A status record is refused").
  const sr = makeStatusRecord({ result: 'sent', message: 'HEARTBEAT' });
  node._input(sr);

  // Connection must not have been called.
  assert.equal(sent.length, 0);
  // Should have emitted [null, refusalRecord] on output 1.
  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.equal(out0, null);
  assert.ok(isStatusRecord(out1), 'output 1 must be a status record');
  assert.equal(out1.result, 'refused');
  // node.error should have been called.
  assert.equal(node._errors.length, 1);
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
  assert.ok(isStatusRecord(out1), 'output 1 is a status record');
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
  assert.ok(isStatusRecord(out1));
  assert.equal(out1.result, 'failed');
});

// ---------------------------------------------------------------------------
// mavlink-build tests
// ---------------------------------------------------------------------------

test('mavlink-build: marks invalid config when vehicle is missing', () => {
  const RED = makeRED();
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'missing' });
  Constructor.call(node, { vehicle: 'missing' });
  assert.equal(node._status && node._status.fill, 'red');
});

test('mavlink-build: marks invalid config when messageName is empty', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, { vehicle: 'v1', messageName: '' });
  assert.equal(node._status && node._status.fill, 'red');
});

test('mavlink-build: marks invalid config when messageName is not in dialect', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, { vehicle: 'v1', messageName: 'NONEXISTENT_MSG' });
  assert.equal(node._status && node._status.fill, 'red');
});

test('mavlink-build: suppresses when msg.payload === false', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, { vehicle: 'v1', messageName: 'HEARTBEAT', tier: 'build' });

  node._input({ payload: false });

  assert.equal(node._sends.length, 0);
});

test('mavlink-build: refuses a status record input', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, { vehicle: 'v1', messageName: 'HEARTBEAT', tier: 'build' });

  // The status record is the entire msg (the marker is at msg level, not msg.payload).
  const sr = makeStatusRecord({ result: 'sent' });
  node._input(sr);

  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.equal(out0, null);
  assert.ok(isStatusRecord(out1));
  assert.equal(out1.result, 'refused');
  assert.equal(node._errors.length, 1);
});

test('mavlink-build Build tier: output 0 carries the built message envelope', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, {
    vehicle: 'v1',
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
  assert.ok(isStatusRecord(out1), 'output 1 must be a status record');
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

  const inMsg = { payload: {} };
  node._input(inMsg);

  // Connection must have received the message.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.name, 'HEARTBEAT');
  assert.deepEqual(sent[0].message.fields, { type: 6, autopilot: 3 });

  // output 0 carries the input msg pass-through.
  // output 1 is a status record.
  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.ok(out0, 'output 0 must fire');
  assert.ok(isStatusRecord(out1), 'output 1 must be a status record');
  assert.equal(out1.result, 'sent');
});

test('mavlink-build Send tier: falls back to Build when no connection configured', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, {
    vehicle: 'v1',
    messageName: 'HEARTBEAT',
    tier: 'send',   // requests Send but no connection
    fields: JSON.stringify({ type: 6, autopilot: 3 }),
  });

  node._input({ payload: {} });

  // Should have built (not failed), because the effective tier is Build.
  assert.equal(node._sends.length, 1);
  const [out0, out1] = node._sends[0];
  assert.ok(out0, 'output 0 must fire');
  assert.ok(isStatusRecord(out1));
  assert.equal(out1.result, 'built', 'effective tier is Build when no connection');
});

test('mavlink-build Build tier: codec error emits error status on output 1', () => {
  const RED = makeRED();
  RED.nodes._register('v1', makeVehicleStub());
  require('../../nodes/mavlink-build')(RED);
  const Constructor = RED._nodeTypes['mavlink-build'];
  const node = makeNodeInstance({ vehicle: 'v1' });
  Constructor.call(node, {
    vehicle: 'v1',
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
  assert.ok(isStatusRecord(out1));
  assert.equal(out1.result, 'failed');
  assert.ok(typeof out1.reason === 'string');
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
// shouldSuppress contract (unit, for completeness in this file)
// ---------------------------------------------------------------------------

test('shouldSuppress: true only for payload === false, not falsy', () => {
  assert.equal(shouldSuppress({ payload: false }), true);
  assert.equal(shouldSuppress({ payload: null }), false);
  assert.equal(shouldSuppress({ payload: 0 }), false);
  assert.equal(shouldSuppress({ payload: '' }), false);
  assert.equal(shouldSuppress({ payload: undefined }), false);
});
