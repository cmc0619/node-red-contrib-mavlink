'use strict';

/**
 * nodes/mavlink-connection.js wrapper contract: a disabled Connection still
 * answers the read-side stubs, and the live wrapper forwards resolveSourceIds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const registerMavlinkConnection = require('../../nodes/mavlink-connection');

/**
 * Minimal RED mock: captures the registered constructor and answers
 * RED.nodes.getNode from a lookup table. createNode grafts just enough
 * EventEmitter behaviour for the constructor to run.
 *
 * @param {Object<string, object|null>} lookup  node id → node (or null)
 * @returns {{ctor: Function, RED: object}}
 */
function makeRED(lookup) {
  let ctor = null;
  const RED = {
    nodes: {
      createNode(node) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.status = () => {};
        node.log = () => {};
        node.warn = () => {};
        node.error = () => {};
        node.credentials = {};
      },
      registerType(_name, fn) {
        ctor = fn;
      },
      getNode(id) {
        return Object.prototype.hasOwnProperty.call(lookup, id) ? lookup[id] : null;
      },
    },
    // Registration installs the serial-ports admin route, same as the Vehicle
    // node's dialect routes — a RED double has to carry these two.
    httpAdmin: { get() {} },
    auth: { needsPermission() { return (_r, _s, n) => n && n(); } },
  };
  registerMavlinkConnection(RED);
  return { ctor, RED };
}

const BASE_CONFIG = {
  mode: 'udp',
  bindHost: '0.0.0.0',
  bindPort: 14550,
  vehicle: 'veh-1',
  localIdentity: 'id-1',
  additionalIdentities: [],
};

test('a disabled Connection still exposes an empty peer table', () => {
  const { ctor } = makeRED({});
  const node = Object.create(null);
  ctor.call(node, { ...BASE_CONFIG, disabled: true });

  // Disabled is a valid choice, not a broken reference. Action nodes gate on
  // the peer table existing, so without this they report "invalid config"
  // when the truth is "the link is switched off and nobody is on it".
  assert.ok(node.peerTable, 'peer table is present');
  assert.equal(typeof node.subscribe, 'function');
  // send refuses rather than no-ops: swallowing the frame would let the
  // sender report "sent" over a link that moved nothing (§2).
  assert.throws(() => node.send({ name: 'HEARTBEAT', fields: {} }, {}), /disabled/);
  assert.equal(typeof node.resolveSourceIds, 'function', 'ack-attribution accessor is part of the wrapper contract');
  assert.equal(node.resolveSourceIds(), null, 'a disabled connection resolves no source ids — the gate stays off');
});

test('the live Connection wrapper forwards resolveSourceIds to the runtime (Codex #161)', () => {
  // The runtime method alone is not enough: palette nodes reach the runtime
  // only through the wrapper (node.subscribe/send/peerTable), so an
  // unforwarded accessor is a TypeError on the first confirm-delivery send —
  // invisible to unit tests whose stubs all provide the method.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'nodes', 'mavlink-connection.js'),
    'utf8'
  );
  assert.match(
    source,
    /node\.resolveSourceIds = \(identityId\) => node\.connection\.resolveSourceIds\(identityId\)/,
    'wrapper forwards resolveSourceIds alongside subscribe/send'
  );
});
