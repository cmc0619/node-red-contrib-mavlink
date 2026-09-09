'use strict';

/**
 * The `/mavlink/gimbal-managers` admin route is a read-only projection of the
 * deployed Connection peer table for payload editor selectors.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function captureRoute(nodesById) {
  const routes = new Map();
  const permissions = [];
  const RED = {
    nodes: {
      registerType() {},
      getNode(id) { return nodesById[id] || null; },
    },
    httpAdmin: {
      get(path, auth, handler) { routes.set(path, { auth, handler }); },
    },
    auth: {
      needsPermission(permission) {
        permissions.push(permission);
        return (_req, _res, next) => next && next();
      },
    },
  };
  require('../../nodes/mavlink-connection')(RED);
  return { route: routes.get('/mavlink/gimbal-managers'), permissions };
}

function responseDouble() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

test('gimbal manager discovery is read-gated and flattens the peer snapshot', () => {
  let snapshotCalls = 0;
  let sendCalls = 0;
  const snapshot = [
    {
      sysid: 1,
      components: [
        {
          compid: 154,
          gimbalManagers: [
            {
              gimbalDeviceId: 0,
              information: { capFlags: 1, rollMin: -1, rollMax: 1 },
              status: { flags: 3, primaryControlSysid: 0, primaryControlCompid: 0 },
            },
            {
              gimbalDeviceId: 2,
              information: null,
              status: { flags: 4, primaryControlSysid: 42, primaryControlCompid: 43 },
            },
          ],
        },
      ],
    },
  ];
  const { route, permissions } = captureRoute({
    conn1: {
      peerTable: {
        snapshot() {
          snapshotCalls += 1;
          return snapshot;
        },
      },
      send() { sendCalls += 1; },
    },
  });
  const res = responseDouble();

  route.handler({ query: { connection: 'conn1' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    managers: [
      {
        sysid: 1,
        compid: 154,
        gimbalDeviceId: 0,
        information: { capFlags: 1, rollMin: -1, rollMax: 1 },
        status: { flags: 3, primaryControlSysid: 0, primaryControlCompid: 0 },
      },
      {
        sysid: 1,
        compid: 154,
        gimbalDeviceId: 2,
        information: null,
        status: { flags: 4, primaryControlSysid: 42, primaryControlCompid: 43 },
      },
    ],
  });
  assert.equal(snapshotCalls, 1);
  assert.equal(sendCalls, 0, 'discovery reads state and does not request telemetry');
  assert.equal(permissions.filter((permission) => permission === 'mavlink.read').length, 2);
});

test('missing or undeployed connection answers 404', () => {
  const { route } = captureRoute({});
  const res = responseDouble();

  route.handler({ query: { connection: 'gone' } }, res);

  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /not found|not deployed/i);
  assert.equal(res.body.managers, undefined);
});
