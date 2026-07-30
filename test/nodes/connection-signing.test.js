'use strict';

/**
 * mavlink-connection: signing key derivation (DESIGN.md §7 "Signing").
 *
 * A passphrase alone must produce a key. The key is what lets inbound
 * signatures be *verified* at all — gating it on the checkboxes made every
 * signed frame fail verification and get dropped silently, so the link looked
 * dead. `signOutbound` and `requireSigned` keep their own jobs.
 *
 * The runtime Connection is replaced in the module cache so the node's
 * `start()` never opens a socket; the assertion is on the config it hands over.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Patch lib/connection *before* the node destructures Connection from it.
const connectionModulePath = require.resolve('../../lib/connection');
const connectionModule = require(connectionModulePath);
const captured = [];
connectionModule.Connection = class FakeConnection {
  constructor(config) {
    captured.push(config);
  }
  on() {}
  start() {
    return Promise.resolve();
  }
  close(done) {
    if (done) done();
  }
};

delete require.cache[require.resolve('../../nodes/mavlink-connection')];
const registerConnection = require('../../nodes/mavlink-connection');

const BUNDLE = {
  dialect: 'test',
  enums: {
    MAV_TYPE: { name: 'MAV_TYPE', entries: [{ name: 'MAV_TYPE_GCS', value: 6 }] },
    MAV_AUTOPILOT: { name: 'MAV_AUTOPILOT', entries: [{ name: 'MAV_AUTOPILOT_INVALID', value: 8 }] },
    MAV_STATE: { name: 'MAV_STATE', entries: [{ name: 'MAV_STATE_ACTIVE', value: 4 }] },
  },
  messages: {},
};

/**
 * @returns {object} RED stub exposing the registered constructor
 */
function makeRED() {
  const nodeTypes = {};
  const configNodes = {
    'vehicle-1': {
      id: 'vehicle-1',
      getDialect: () => BUNDLE,
      getDefaults: () => ({
        firmware: 'ardupilot',
        dialect: 'test',
        defaultTargetSystem: 1,
        defaultTargetComponent: 1,
      }),
    },
    'identity-1': {
      id: 'identity-1',
      heartbeatIntervalMs: 1000,
      getIdentity: () => ({ sysid: 255, compid: 190 }),
      getHeartbeatFields: () => ({
        type: 'MAV_TYPE_GCS',
        autopilot: 'MAV_AUTOPILOT_INVALID',
        system_status: 'MAV_STATE_ACTIVE',
      }),
      describe: () => 'GCS',
    },
  };
  return {
    nodes: {
      createNode() {},
      registerType(type, constructor) {
        nodeTypes[type] = constructor;
      },
      getNode: (id) => configNodes[id] || null,
    },
    _nodeTypes: nodeTypes,
  };
}

/**
 * Construct the connection node and return the signing config it built.
 *
 * @param {object} config  editor config overrides
 * @param {object} [credentials]
 * @returns {object} the runtime signing snapshot
 */
function signingFor(config, credentials) {
  const RED = makeRED();
  registerConnection(RED);
  const node = {
    id: 'conn-1',
    credentials,
    status() {},
    error() {},
    log() {},
    warn() {},
    on() {},
  };
  captured.length = 0;
  RED._nodeTypes['mavlink-connection'].call(node, {
    id: 'conn-1',
    vehicle: 'vehicle-1',
    localIdentity: 'identity-1',
    mode: 'udp',
    bindPort: 14550,
    ...config,
  });
  return captured[0].signing;
}

test('a passphrase alone derives the verification key, with both checkboxes off', () => {
  const signing = signingFor({}, { signingPassphrase: 'hunter2' });
  assert.equal(signing.hasKey, true);
  assert.ok(Buffer.isBuffer(signing.key), 'inbound verification needs the key regardless of policy');
  assert.equal(signing.signOutbound, false);
  assert.equal(signing.requireSigned, false);
});

test('no passphrase means no key', () => {
  const signing = signingFor({}, {});
  assert.equal(signing.hasKey, false);
  assert.equal(signing.key, null);
});
