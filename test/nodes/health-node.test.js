'use strict';

/**
 * Health node runtime: blank config (the editor writes blank for a
 * single-identity Connection) asserts the Connection's Local Identity. A
 * non-blank saved pick rides as given — no membership fallback.
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

test('single-identity Connection asserts the identity the editor wrote', () => {
  const conn = makeConnection({ localIdentity: 'comp', additionalIdentities: [] });
  const node = build({ identity: 'comp' }, conn);
  node._input({ payload: { health: 'ok' } });
  assert.equal(conn._asserts.length, 1);
  assert.equal(conn._asserts[0].id, 'comp');
  assert.equal(conn._asserts[0].healthy, true);
});

test('a non-blank saved pick rides as given — no membership fallback', () => {
  const conn = makeConnection({ localIdentity: 'comp', additionalIdentities: [] });
  const node = build({ identity: 'loose' }, conn);
  node._input({ payload: { health: 'ok' } });
  assert.equal(conn._asserts[0].id, 'loose', 'saved pick is not rewritten to the Local Identity');
});

test('multi-identity Connection honours a bound, existing saved pick', () => {
  const conn = makeConnection({ localIdentity: 'comp', additionalIdentities: ['gcs'] });
  const node = build({ identity: 'gcs' }, conn, { gcs: idNode('gcs') });
  node._input({ payload: { health: 'fatal' } });
  assert.equal(conn._asserts[0].id, 'gcs');
  assert.equal(conn._asserts[0].healthy, false);
});

test('a saved id the Connection does not bind still rides — assertHealth is the loud path', () => {
  const conn = makeConnection({ localIdentity: 'comp', additionalIdentities: ['dangling'] });
  const node = build({ identity: 'loose' }, conn);
  node._input({ payload: { health: 'ok' } });
  assert.equal(conn._asserts[0].id, 'loose');
});
