'use strict';

/**
 * Health node runtime: which identity's health an assertion targets is
 * resolved from the Connection's shape, not from a possibly-stale saved id.
 * A single-identity Connection asserts its sole Local Identity even when a
 * leftover value is stored (the field is hidden and unvalidated there); only a
 * multi-identity Connection honours the saved pick, falling back to the Local
 * Identity when blank.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const registerMavlinkHealth = require('../../nodes/mavlink-health');

/** Minimal RED with a config-node registry. */
function makeRED(configNodes) {
  const nodeTypes = {};
  return {
    nodes: {
      registerType(type, ctor) { nodeTypes[type] = ctor; },
      getNode(id) { return configNodes[id] || null; },
      createNode() {},
    },
    _type() { return nodeTypes['mavlink-health']; },
  };
}

/** A connection stub recording assertHealth calls and its identity shape. */
function makeConnection(shape) {
  return {
    localIdentity: shape.localIdentity,
    additionalIdentities: shape.additionalIdentities,
    _asserts: [],
    assertHealth(id, healthy, ttlMs) { this._asserts.push({ id, healthy, ttlMs }); },
    onHealthExpired() { return () => {}; },
  };
}

/** The `this` inside the node constructor, with an input pump. */
function makeNode() {
  return {
    _handlers: {},
    _sends: [],
    status() {},
    send(m) { this._sends.push(m); },
    warn() {},
    log() {},
    error() {},
    on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    _input(msg) {
      for (const fn of this._handlers.input || []) fn(msg, (m) => this.send(m), () => {});
    },
  };
}

/** An identity config-node stub — enough for RED.nodes.getNode existence. */
function idNode(id) {
  return { id, type: 'mavlink-local-identity' };
}

function build(config, connection, extraNodes = {}) {
  const RED = makeRED({ conn: connection, ...extraNodes });
  registerMavlinkHealth(RED);
  const node = makeNode();
  RED._type().call(node, { connection: 'conn', ttlS: 5, ...config });
  return node;
}

test('single-identity Connection asserts its Local Identity, ignoring a stale saved pick', () => {
  const conn = makeConnection({ localIdentity: 'comp', additionalIdentities: [] });
  // 'loose' is a leftover from before the field was hidden — it must not ride.
  const node = build({ identity: 'loose' }, conn);
  node._input({ payload: { health: 'ok' } });
  assert.equal(conn._asserts.length, 1);
  assert.equal(conn._asserts[0].id, 'comp', 'resolved to the sole Local Identity');
  assert.equal(conn._asserts[0].healthy, true);
});

test('multi-identity Connection honours a bound, existing saved pick', () => {
  const conn = makeConnection({ localIdentity: 'comp', additionalIdentities: ['gcs'] });
  const node = build({ identity: 'gcs' }, conn, { gcs: idNode('gcs') });
  node._input({ payload: { health: 'fatal' } });
  assert.equal(conn._asserts[0].id, 'gcs');
  assert.equal(conn._asserts[0].healthy, false);
});

test('multi-identity Connection with a blank pick falls back to the Local Identity', () => {
  const conn = makeConnection({ localIdentity: 'comp', additionalIdentities: ['gcs'] });
  const node = build({ identity: '' }, conn);
  node._input({ payload: { health: 'ok' } });
  assert.equal(conn._asserts[0].id, 'comp');
});

test('a saved id the Connection does not bind falls back to the Local Identity', () => {
  // Membership, not an additionalIdentities count: a Connection with an entry
  // in additionalIdentities but a stale/unbound saved pick still resolves to
  // the Local Identity, so runtime and editor agree on what "bound" means and
  // an unheartbeated id never reaches assertHealth (Gitar #351).
  const conn = makeConnection({ localIdentity: 'comp', additionalIdentities: ['dangling'] });
  const node = build({ identity: 'loose' }, conn);
  node._input({ payload: { health: 'ok' } });
  assert.equal(conn._asserts[0].id, 'comp', 'stale unbound pick ignored, Local Identity asserted');
});

test('a listed-but-dangling saved id falls back to the Local Identity', () => {
  // The saved id IS in additionalIdentities, but its identity node was deleted.
  // Membership alone would honour it and assertHealth on an id no scheduler
  // heartbeats — a false "healthy". Existence gates it: getNode fails, so it
  // resolves to the Local Identity, matching the editor's existence-filtered
  // options (CodeRabbit #351).
  const conn = makeConnection({ localIdentity: 'comp', additionalIdentities: ['dangling'] });
  const node = build({ identity: 'dangling' }, conn); // 'dangling' node not registered
  node._input({ payload: { health: 'ok' } });
  assert.equal(conn._asserts[0].id, 'comp', 'listed-but-missing id ignored, Local Identity asserted');
});
