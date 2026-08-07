'use strict';

/**
 * §6 deploy-time Connection badge, across every sender that has one.
 *
 * `DESIGN.md:558` carries one exception to "action nodes report last activity":
 * `misconfigured at deploy → red ring, invalid config`, because a node that
 * cannot possibly work should say so without being triggered first. A wire tier
 * whose Connection does not resolve is exactly that, and editor validation
 * cannot reach it — the id is valid there, and only fails when the runtime
 * constructs the config node (disabled, or its own constructor threw).
 *
 * This is deliberately a wiring test rather than a helper test. The helper is
 * covered in test/addressing/delivery-context.test.js; what regressed once
 * before was every node's *call* to it, which a helper test cannot see.
 *
 * Both halves are asserted. The clear matters as much as the badge: Node-RED
 * publishes a status clear only when a node is removed, not when it is modified
 * and restarted, so a node fixed and redeployed would otherwise keep showing
 * the dead badge (§14).
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

/** Every sender with a Build tier, and the config that selects a wire tier. */
const SENDERS = [
  { type: 'mavlink-command', module: 'mavlink-command',
    wire: { mode: 'preset', preset: 'arm', carrier: 'long', delivery: 'confirm' },
    build: { mode: 'preset', preset: 'arm', carrier: 'long', delivery: 'build' } },
  { type: 'mavlink-mission', module: 'mavlink-mission',
    wire: { operation: 'download', delivery: 'confirm' },
    build: { operation: 'download', delivery: 'build' } },
  { type: 'mavlink-move', module: 'mavlink-move',
    wire: { delivery: 'send', mode: 'position' },
    build: { delivery: 'build', mode: 'position' } },
  { type: 'mavlink-param', module: 'mavlink-param',
    wire: { delivery: 'confirm', action: 'read' },
    build: { delivery: 'build', action: 'read' } },
  { type: 'mavlink-payload', module: 'mavlink-payload',
    wire: { delivery: 'send', topic: 'servo', verb: 'set' },
    build: { delivery: 'build', topic: 'servo', verb: 'set' } },
];

/** RED stub that records every status write the constructor makes. */
function deploy(moduleName, type, config, connectionNode) {
  const statuses = [];
  const nodes = connectionNode ? { conn: connectionNode } : {};
  const RED = {
    nodes: {
      types: {},
      createNode(node, cfg) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = cfg.id || 'node';
        node.status = (s) => statuses.push(s);
        node.error = () => {};
        node.warn = () => {};
        node.log = () => {};
        node.send = () => {};
      },
      registerType(name, ctor) { this.types[name] = ctor; },
      getNode(id) { return nodes[id]; },
    },
    httpAdmin: { get() {}, post() {} },
    auth: { needsPermission() { return (_q, _s, n) => n && n(); } },
    settings: { userDir: '/tmp' },
  };
  require(`../../nodes/${moduleName}`)(RED);
  new RED.nodes.types[type](config);
  return statuses;
}

for (const s of SENDERS) {
  test(`${s.type}: a wire tier with an unresolvable Connection badges at deploy`, () => {
    // Non-empty id — editor-valid — that resolves to nothing, which is the only
    // way this state is reachable now that the editor rejects a blank.
    const statuses = deploy(s.module, s.type, { ...s.wire, connection: 'gone' }, null);
    const badge = statuses.find((x) => x && x.text === 'invalid config');
    assert.ok(badge, 'expected the §6 invalid config badge');
    assert.equal(badge.fill, 'red');
    assert.equal(badge.shape, 'ring');
  });

  test(`${s.type}: a resolved Connection clears rather than badges`, () => {
    const conn = { id: 'conn', vehicle: { firmware: 'ardupilot' }, peerTable: {} };
    const statuses = deploy(s.module, s.type, { ...s.wire, connection: 'conn' }, conn);
    assert.ok(
      !statuses.some((x) => x && x.text === 'invalid config'),
      'a usable Connection must not badge'
    );
    assert.ok(
      statuses.some((x) => x && Object.keys(x).length === 0),
      'and must clear, or a stale badge from the previous deploy survives'
    );
  });

  test(`${s.type}: the Build tier needs no Connection and does not badge`, () => {
    const statuses = deploy(s.module, s.type, { ...s.build, connection: '' }, null);
    assert.ok(
      !statuses.some((x) => x && x.text === 'invalid config'),
      'Build sends nothing, so a blank Connection is the correct configuration'
    );
  });
}
