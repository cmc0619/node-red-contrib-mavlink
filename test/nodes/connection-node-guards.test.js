'use strict';

/**
 * nodes/mavlink-connection.js constructor guards (issue #95). A dangling
 * Vehicle Profile or Local Identity reference — the config node was deleted or
 * disabled after the Connection was saved — must fail with a clear, actionable
 * error in the buildSigning style, never a raw TypeError from calling a method
 * on null.
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

test('a dangling Vehicle Profile reference fails loud, not with a TypeError', () => {
  const { ctor } = makeRED({ 'veh-1': null, 'id-1': {} });
  assert.throws(
    () => ctor.call({}, { ...BASE_CONFIG }),
    /Vehicle Profile is missing or disabled/,
    'the error must name the problem and the fix, not "reading getDialect of null"'
  );
});

test('a dangling Local Identity reference fails loud naming the id', () => {
  const vehicleNode = {
    getDialect: () => ({ messages: {}, enums: {} }),
    getDefaults: () => ({
      defaultTargetSystem: 1,
      defaultTargetComponent: 1,
      firmware: 'ardupilot',
      dialect: 'common',
    }),
  };
  const { ctor } = makeRED({ 'veh-1': vehicleNode, 'id-1': null });
  assert.throws(
    () => ctor.call({}, { ...BASE_CONFIG }),
    /Local Identity "id-1" is missing or disabled/,
    'the error names which reference is dangling'
  );
});

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

test('a hand-edited garbage staleMs/expireMs refuses at construction instead of leaving peers never-stale (owner ruling, 2026-08-14)', () => {
  const { loadBundled } = require('../../lib/metadata');
  const bundle = loadBundled('common');
  const vehicleNode = {
    getDialect: () => bundle,
    getDefaults: () => ({
      defaultTargetSystem: 1,
      defaultTargetComponent: 1,
      firmware: 'ardupilot',
      dialect: 'common',
    }),
  };

  // A real Local Identity node, not a hand-rolled stub — it is the thing
  // that actually produces the type/autopilot/system_status names
  // identitySnapshot resolves against the bundle.
  const registerLocalIdentity = require('../../nodes/mavlink-local-identity');
  let IdentityCtor;
  const identityRED = {
    nodes: {
      createNode(node) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.status = () => {};
      },
      registerType(_name, fn) { IdentityCtor = fn; },
    },
  };
  registerLocalIdentity(identityRED);
  const identityNode = Object.create(null);
  IdentityCtor.call(identityNode, { role: 'gcs', sourceSystemId: 255, sourceComponentId: 190 });

  const { ctor } = makeRED({ 'veh-1': vehicleNode, 'id-1': identityNode });

  assert.throws(
    () => ctor.call({}, { ...BASE_CONFIG, staleMs: 'abc' }),
    /Connection stale threshold \(staleMs\) must be a finite number \(got "abc"\)/
  );
  assert.throws(
    () => ctor.call({}, { ...BASE_CONFIG, expireMs: 'nope' }),
    /Connection expire threshold \(expireMs\) must be a finite number \(got "nope"\)/
  );
  // Blank staying `undefined` (PeerTable's own default applies) is pinned at
  // the unit level (`test/addressing/resolve.test.js`, `test/connection/
  // peer-table.test.js`'s explicit-`undefined` case) — not repeated here,
  // since a fully-constructed live Connection opens a real UDP socket and
  // heartbeat timer this guard-test file never tears down.
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
