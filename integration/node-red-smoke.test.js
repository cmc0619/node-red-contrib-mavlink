'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const helper = require('node-red-node-test-helper');
const { loadNodeDefaults } = require('../test/nodes/html-assert.js');

const packageRoot = process.env.MAVLINK_PACKAGE_ROOT
  ? path.resolve(process.env.MAVLINK_PACKAGE_ROOT)
  : path.resolve(__dirname, '..');
const packageJson = require(path.join(packageRoot, 'package.json'));
const runtimeModules = Object.values(packageJson['node-red'].nodes).map((modulePath) =>
  require(path.resolve(packageRoot, modulePath))
);

const nodeIds = [
  'identity',
  'vehicle',
  'connection',
  'node-in',
  'node-out',
  'node-build',
  'node-command',
  'node-move',
  'node-param',
  'node-payload',
  'node-state',
  'node-mission',
  'node-fanout'
];

/**
 * A node config as the editor would deploy it: every key the node's
 * `defaults` declares, at its registered editor default, with this flow's
 * explicit choices on top. The runtime trusts editor-produced configuration
 * (§0), so the smoke flow must actually be one — a hand-authored skeleton
 * missing defaults keys craters in the very constructors this test deploys.
 */
function editorShaped(type, overrides) {
  const config = { type };
  for (const [name, def] of Object.entries(loadNodeDefaults(type))) {
    // structuredClone: array/object defaults come out of loadNodeDefaults'
    // vm sandbox as cross-realm values, and the helper's deepEqual against
    // the runtime's stored flow checks prototypes, not just shape.
    config[name] = structuredClone(def.value);
  }
  return Object.assign(config, overrides);
}

function representativeFlow() {
  return [
    { id: 'flow', type: 'tab', label: 'CI smoke' },
    editorShaped('mavlink-local-identity', {
      id: 'identity',
      name: 'CI GCS',
      role: 'gcs',
      sourceSystemId: '255',
      sourceComponentId: '190',
      heartbeatType: 'MAV_TYPE_GCS',
      heartbeatAutopilot: 'MAV_AUTOPILOT_INVALID',
      heartbeatIntervalMs: '1000'
    }),
    editorShaped('mavlink-vehicle', {
      id: 'vehicle',
      name: 'CI vehicle',
      vehicleFamily: 'generic',
      firmware: 'ardupilot',
      dialect: 'common',
      dialectRevision: 'seed'
    }),
    editorShaped('mavlink-connection', {
      id: 'connection',
      name: 'CI disabled connection',
      disabled: true,
      mode: 'udp',
      vehicle: 'vehicle',
      localIdentity: 'identity'
    }),
    editorShaped('mavlink-in', { id: 'node-in', z: 'flow', connection: 'connection', wires: [[]] }),
    editorShaped('mavlink-out', { id: 'node-out', z: 'flow', connection: 'connection', wires: [] }),
    editorShaped('mavlink-build', {
      id: 'node-build',
      z: 'flow',
      tier: 'build',
      dialect: '__vehicle',
      messageName: 'HEARTBEAT',
      fields: '{}',
      vehicle: 'vehicle',
      identity: 'identity',
      wires: [[]]
    }),
    editorShaped('mavlink-command', {
      id: 'node-command',
      z: 'flow',
      connection: 'connection',
      // Without a carrier the node reds out and its inputs do nothing. The
      // smoke test only asserts each node was *created*, so an invalid node
      // passed it silently — the flow has to be genuinely valid for the check
      // to mean anything (#223).
      mode: 'preset',
      preset: 'arm',
      sendAs: 'long',
      wires: [[], []]
    }),
    editorShaped('mavlink-move', {
      id: 'node-move',
      z: 'flow',
      delivery: 'build',
      dialect: '__vehicle',
      vehicle: 'vehicle',
      identity: 'identity',
      targetSystem: '1',
      targetComponent: '1',
      wires: [[], []]
    }),
    editorShaped('mavlink-param', {
      id: 'node-param',
      z: 'flow',
      delivery: 'build',
      dialect: '__vehicle',
      action: 'set',
      paramId: 'CI_PARAM',
      value: '1',
      vehicle: 'vehicle',
      identity: 'identity',
      targetSystem: '1',
      targetComponent: '1',
      wires: [[], []]
    }),
    editorShaped('mavlink-payload', {
      id: 'node-payload',
      z: 'flow',
      delivery: 'build',
      dialect: '__vehicle',
      topic: 'camera',
      verb: 'photo',
      path: 'legacy',
      vehicle: 'vehicle',
      identity: 'identity',
      targetSystem: '1',
      targetComponent: '1',
      wires: [[], []]
    }),
    editorShaped('mavlink-state', {
      id: 'node-state',
      z: 'flow',
      mode: 'snapshot',
      connection: 'connection',
      targetSystem: '1',
      targetComponent: '1',
      wires: [[]]
    }),
    editorShaped('mavlink-mission', {
      id: 'node-mission',
      z: 'flow',
      operation: 'download',
      delivery: 'build',
      dialect: '__vehicle',
      vehicle: 'vehicle',
      identity: 'identity',
      targetSystem: '1',
      targetComponent: '1',
      wires: [[], []]
    }),
    editorShaped('mavlink-fanout', {
      id: 'node-fanout',
      z: 'flow',
      delivery: 'build',
      selectionMode: 'list',
      members: [{ sysid: 1 }, { sysid: 2 }],
      identity: 'identity',
      wires: [[], []]
    })
  ];
}

function startServer() {
  return new Promise((resolve, reject) => {
    helper.startServer((error) => (error ? reject(error) : resolve()));
  });
}

function stopServer() {
  return new Promise((resolve, reject) => {
    helper.stopServer((error) => (error ? reject(error) : resolve()));
  });
}

function loadFlow() {
  return new Promise((resolve, reject) => {
    helper.load(runtimeModules, representativeFlow(), (error) =>
      error ? reject(error) : resolve()
    );
  });
}

async function unloadFlow() {
  let timer;
  try {
    await Promise.race([
      Promise.resolve(helper.unload()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Node-RED unload timed out')), 5000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

helper.init(require.resolve('node-red'));

test.before(startServer);
test.after(async () => {
  await unloadFlow();
  await stopServer();
});

test('all published nodes survive a real Node-RED deploy and redeploy', async () => {
  for (let deployment = 1; deployment <= 2; deployment += 1) {
    await loadFlow();

    for (const id of nodeIds) {
      assert.ok(helper.getNode(id), `deployment ${deployment} did not create ${id}`);
    }

    await unloadFlow();
  }
});
