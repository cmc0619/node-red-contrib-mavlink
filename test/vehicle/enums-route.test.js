'use strict';

/**
 * Admin enum catalog route for editor dropdowns (§6).
 * A missing Vehicle Profile must not fall through to ardupilotmega.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

function captureRoutes(nodesById) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const permissions = [];
  const RED = {
    settings: {},
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
      get(path, auth, handler) {
        handlers.set(path, { auth, handler, method: 'get' });
      },
      post(path, auth, handler) {
        handlers.set(path, { auth, handler, method: 'post' });
      },
    },
    auth: {
      needsPermission(permission) {
        permissions.push(permission);
        return (_req, _res, next) => next && next();
      },
    },
  };

  const vehiclePath = require.resolve('../../nodes/mavlink-vehicle');
  delete require.cache[vehiclePath];
  require(vehiclePath)(RED);
  return { handlers, permissions };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('/mavlink/enums is registered once with mavlink.read auth', () => {
  const { handlers, permissions } = captureRoutes({});

  assert.ok(handlers.has('/mavlink/enums'));
  assert.ok(handlers.has('/mavlink/dialects'));
  // dialects + enums + xml-catalog list/compare GETs are read-guarded; the
  // mutating POSTs (xml-catalog update, compiled-dialect cache rebuild) gate
  // on the write scope.
  assert.equal(permissions.filter((p) => p === 'mavlink.read').length, 4);
  assert.equal(permissions.filter((p) => p === 'mavlink.write').length, 2);
});

test('the compiled-dialect cache exposes a rebuild route', () => {
  const { handlers } = captureRoutes({});

  assert.equal(handlers.get('/mavlink/dialect-cache/rebuild').method, 'post');
});

test('the XML-catalog admin routes register under /mavlink/xml-catalog', () => {
  const { handlers } = captureRoutes({});

  assert.equal(handlers.get('/mavlink/xml-catalog').method, 'get');
  assert.equal(handlers.get('/mavlink/xml-catalog/update').method, 'post');
  assert.equal(handlers.get('/mavlink/xml-catalog/compare').method, 'get');
});

test('deployed Vehicle Profile serves requested enums from its own bundle', () => {
  const custom = {
    dialect: 'custom',
    enums: {
      MAV_TYPE: {
        name: 'MAV_TYPE',
        entries: [{ name: 'MAV_TYPE_GCS', value: 6, description: 'Ground control station.' }],
      },
      CUSTOM_ENUM: {
        name: 'CUSTOM_ENUM',
        entries: [{ name: 'CUSTOM_ENUM_VALUE', value: 42, description: 'Custom value.' }],
      },
    },
  };
  const { handlers } = captureRoutes({
    veh1: {
      dialect: 'custom',
      getDialect: () => custom,
    },
  });
  const res = mockRes();

  handlers.get('/mavlink/enums').handler(
    { query: { vehicle: 'veh1', names: 'CUSTOM_ENUM' } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dialect, 'custom');
  assert.equal(res.body.enums.MAV_TYPE[0].label, 'MAV_TYPE_GCS (6)');
  assert.equal(res.body.enums.CUSTOM_ENUM[0].label, 'CUSTOM_ENUM_VALUE (42)');
});

test('missing Vehicle Profile does not invent ardupilotmega', () => {
  const { handlers } = captureRoutes({});
  const res = mockRes();

  handlers.get('/mavlink/enums').handler({ query: { vehicle: 'missing-id' } }, res);

  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /not found|not deployed/i);
  assert.equal(res.body.enums, undefined);
});

test('missing Vehicle Profile with bundled dialect serves that dialect', () => {
  const { handlers } = captureRoutes({});
  const res = mockRes();

  handlers.get('/mavlink/enums').handler(
    { query: { vehicle: 'missing-id', dialect: 'common', names: 'MAV_TYPE' } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dialect, 'common');
  assert.ok(res.body.enums.MAV_TYPE.some((entry) => entry.label === 'MAV_TYPE_GCS (6)'));
});

test('empty enum catalog query craters at the seed lookup instead of defaulting to ardupilotmega', () => {
  const { handlers } = captureRoutes({});
  const res = mockRes();

  handlers.get('/mavlink/enums').handler({ query: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /undefined/);
  assert.equal(res.body.enums, undefined);
});

test('explicit ardupilotmega enum catalog request still works', () => {
  const { handlers } = captureRoutes({});
  const res = mockRes();

  // The editor always names at least one enum on this route.
  handlers.get('/mavlink/enums').handler({ query: { dialect: 'ardupilotmega', names: 'MAV_TYPE' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dialect, 'ardupilotmega');
  assert.ok(res.body.enums.MAV_TYPE.some((entry) => entry.label === 'MAV_TYPE_GCS (6)'));
});
