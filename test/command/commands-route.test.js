'use strict';

/**
 * Admin catalog route for Advanced MAV_CMD (§6 / §9).
 * A missing Vehicle Profile must not fall through to ardupilotmega.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata');

function captureRoutes(nodesById) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const RED = {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'node';
        node.status = () => {};
        node.error = () => {};
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
      getNode(id) {
        return nodesById[id];
      },
    },
    httpAdmin: {
      get(path, _auth, handler) {
        handlers.set(path, handler);
      },
    },
    auth: { needsPermission() { return (_req, _res, next) => next && next(); } },
  };
  require('../../nodes/mavlink-command')(RED);
  return handlers;
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('deployed Vehicle Profile serves its own dialect bundle', () => {
  const custom = {
    dialect: 'custom',
    commands: {
      MAV_CMD_USER_1: {
        name: 'MAV_CMD_USER_1',
        value: 31000,
        description: 'custom only',
        params: [{ index: 1, label: 'Flag', description: 'Flag', reserved: false }],
      },
    },
    enums: {},
  };
  const handlers = captureRoutes({
    veh1: {
      dialect: 'custom',
      getDialect: () => custom,
    },
  });
  const handler = handlers.get('/mavlink/command/commands');
  const res = mockRes();
  handler({ query: { vehicle: 'veh1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dialect, 'custom');
  assert.ok(res.body.commands.some((c) => c.value === 31000));
});

test('missing Vehicle Profile does not invent ardupilotmega', () => {
  const handlers = captureRoutes({});
  const handler = handlers.get('/mavlink/command/commands');
  const res = mockRes();
  handler({ query: { vehicle: 'missing-id' } }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /not found|not deployed/i);
  assert.equal(res.body.commands, undefined);
});

test('missing Vehicle Profile with bundled dialect serves that dialect', () => {
  const handlers = captureRoutes({});
  const handler = handlers.get('/mavlink/command/commands');
  const res = mockRes();
  handler({ query: { vehicle: 'missing-id', dialect: 'common' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dialect, 'common');
  assert.ok(res.body.commands.some((c) => c.value === 400));
});

test('missing Vehicle Profile with custom dialect is refused', () => {
  const handlers = captureRoutes({});
  const handler = handlers.get('/mavlink/command/commands');
  const res = mockRes();
  handler({ query: { vehicle: 'gone', dialect: 'custom' } }, res);
  assert.equal(res.statusCode, 404);
});

test('empty command catalog query is rejected instead of defaulting to ardupilotmega', () => {
  const handlers = captureRoutes({});
  const handler = handlers.get('/mavlink/command/commands');
  const res = mockRes();
  handler({ query: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /dialect is required/i);
  assert.equal(res.body.commands, undefined);
});

test('explicit ardupilotmega command catalog request still works', () => {
  const handlers = captureRoutes({});
  const handler = handlers.get('/mavlink/command/commands');
  const res = mockRes();
  handler({ query: { dialect: 'ardupilotmega' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dialect, 'ardupilotmega');
  const expected = Object.keys(loadBundled('ardupilotmega').commands || {}).length;
  assert.equal(res.body.commands.length, expected);
});
