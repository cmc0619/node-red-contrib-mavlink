'use strict';

/**
 * /mavlink/payload/field-tips dialect resolution (DESIGN.md §6).
 * Pre-deploy bundled profiles must load seed tips; custom/missing must not
 * invent ardupilotmega (Codex #36).
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

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
    log: { error() {} },
  };
  require('../../nodes/mavlink-payload')(RED);
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

test('deployed Vehicle Profile serves field tips from its dialect bundle', () => {
  const handlers = captureRoutes({
    veh1: {
      dialect: 'ardupilotmega',
      getDialect: () => require('../../lib/metadata').loadBundled('ardupilotmega'),
    },
  });
  const handler = handlers.get('/mavlink/payload/field-tips');
  const res = mockRes();
  handler({ query: { topic: 'camera', verb: 'photo', vehicle: 'veh1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dialect, 'ardupilotmega');
  assert.ok(res.body.fields.sequence);
  assert.match(res.body.fields.sequence.description, /sequence/i);
});

test('missing Vehicle Profile with bundled dialect serves that dialect', () => {
  const handlers = captureRoutes({});
  const handler = handlers.get('/mavlink/payload/field-tips');
  const res = mockRes();
  handler({
    query: {
      topic: 'camera',
      verb: 'photo',
      vehicle: 'missing-id',
      dialect: 'ardupilotmega',
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dialect, 'ardupilotmega');
  assert.ok(res.body.fields.interval);
  assert.equal(res.body.fields.interval.units, 's');
});

test('missing Vehicle Profile without dialect does not invent tips', () => {
  const handlers = captureRoutes({});
  const handler = handlers.get('/mavlink/payload/field-tips');
  const res = mockRes();
  handler({ query: { topic: 'camera', verb: 'photo', vehicle: 'gone' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.fields, {});
  assert.match(res.body.notice, /not deployed/i);
});

test('missing Vehicle Profile with custom dialect is refused', () => {
  const handlers = captureRoutes({});
  const handler = handlers.get('/mavlink/payload/field-tips');
  const res = mockRes();
  handler({
    query: {
      topic: 'camera',
      verb: 'photo',
      vehicle: 'gone',
      dialect: 'custom',
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.fields, {});
  assert.match(res.body.notice, /not deployed/i);
});

test('field-tip resolution errors remain generic', () => {
  const handlers = captureRoutes({
    veh1: {
      getDialect() {
        throw new Error('/private/dialect.xml');
      },
    },
  });
  const res = mockRes();
  handlers.get('/mavlink/payload/field-tips')(
    { query: { topic: 'camera', verb: 'photo', vehicle: 'veh1' } },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    fields: {},
    error: 'field tips unavailable',
  });
  assert.ok(
    !JSON.stringify(res.body).includes('/private/'),
    'client body must not leak filesystem paths'
  );
});

/** Serve the route for one verb against a deployed ardupilotmega profile. */
function tipsFor(query) {
  const handlers = captureRoutes({
    veh1: {
      dialect: 'ardupilotmega',
      getDialect: () => require('../../lib/metadata').loadBundled('ardupilotmega'),
    },
  });
  const res = mockRes();
  handlers.get('/mavlink/payload/field-tips')({ query: { vehicle: 'veh1', ...query } }, res);
  return res;
}

test('the route returns everything the form needs: fields, enums and carrierMatters', () => {
  const res = tipsFor({ topic: 'release', verb: 'winch', path: '' });

  // Field set is the row set.
  assert.deepEqual(Object.keys(res.body.fields).sort(), ['action', 'instance', 'length', 'rate']);

  // Descriptors carry what the dialog would otherwise hardcode.
  assert.equal(res.body.fields.action.enum, 'WINCH_ACTIONS');
  assert.ok(res.body.fields.action.label, 'label comes from the dialect');

  // Enum entries ride along, so no baked fallback table is needed.
  assert.ok(Array.isArray(res.body.enums.WINCH_ACTIONS));
  assert.ok(res.body.enums.WINCH_ACTIONS.length > 1);

  // Winch is not positional, so the carrier is not a real choice.
  assert.equal(res.body.carrierMatters, false);
});

test('carrierMatters is true for the one positional payload verb', () => {
  const res = tipsFor({ topic: 'gimbal', verb: 'roi-set', path: '' });
  assert.equal(res.body.carrierMatters, true);
  assert.deepEqual(Object.keys(res.body.fields).sort(), ['alt', 'lat', 'lon']);
});
