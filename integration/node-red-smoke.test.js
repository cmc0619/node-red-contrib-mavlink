'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const helper = require('node-red-node-test-helper');

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
  'node-swarm'
];

function representativeFlow() {
  return [
    { id: 'flow', type: 'tab', label: 'CI smoke' },
    {
      id: 'identity',
      type: 'mavlink-local-identity',
      name: 'CI GCS',
      role: 'gcs',
      sourceSystemId: '255',
      sourceComponentId: '190',
      heartbeatType: 'MAV_TYPE_GCS',
      heartbeatAutopilot: 'MAV_AUTOPILOT_INVALID',
      heartbeatIntervalMs: '1000'
    },
    {
      id: 'vehicle',
      type: 'mavlink-vehicle',
      name: 'CI vehicle',
      vehicleFamily: 'generic',
      firmware: 'ardupilot',
      dialect: 'common',
      dialectRevision: 'seed'
    },
    {
      id: 'connection',
      type: 'mavlink-connection',
      name: 'CI disabled connection',
      disabled: true,
      mode: 'udp',
      vehicle: 'vehicle',
      localIdentity: 'identity'
    },
    { id: 'node-in', z: 'flow', type: 'mavlink-in', connection: 'connection', wires: [[]] },
    { id: 'node-out', z: 'flow', type: 'mavlink-out', connection: 'connection', wires: [] },
    {
      id: 'node-build',
      z: 'flow',
      type: 'mavlink-build',
      tier: 'build',
      dialect: '__vehicle',
      messageName: 'HEARTBEAT',
      fields: '{}',
      vehicle: 'vehicle',
      identity: 'identity',
      wires: [[]]
    },
    {
      id: 'node-command',
      z: 'flow',
      type: 'mavlink-command',
      connection: 'connection',
      wires: [[], []]
    },
    {
      id: 'node-move',
      z: 'flow',
      type: 'mavlink-move',
      delivery: 'build',
      dialect: '__vehicle',
      vehicle: 'vehicle',
      identity: 'identity',
      targetSystem: '1',
      targetComponent: '1',
      wires: [[], []]
    },
    {
      id: 'node-param',
      z: 'flow',
      type: 'mavlink-param',
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
    },
    {
      id: 'node-payload',
      z: 'flow',
      type: 'mavlink-payload',
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
    },
    {
      id: 'node-state',
      z: 'flow',
      type: 'mavlink-state',
      mode: 'snapshot',
      connection: 'connection',
      targetSystem: '1',
      targetComponent: '1',
      wires: [[]]
    },
    {
      id: 'node-mission',
      z: 'flow',
      type: 'mavlink-mission',
      operation: 'download',
      delivery: 'build',
      dialect: '__vehicle',
      vehicle: 'vehicle',
      identity: 'identity',
      targetSystem: '1',
      targetComponent: '1',
      wires: [[], []]
    },
    {
      id: 'node-swarm',
      z: 'flow',
      type: 'mavlink-swarm',
      delivery: 'build',
      dialect: '__vehicle',
      selectionMode: 'all',
      actionType: 'command',
      vehicle: 'vehicle',
      identity: 'identity',
      wires: [[], []]
    }
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
