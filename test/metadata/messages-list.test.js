'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  catalogMessagesFromBundle,
  listMessagesCatalog,
  commandLabel,
} = require('../../lib/metadata');

test('commandLabel renders a message id the same `NAME (value)` way (§6)', () => {
  // messageLabel was an alias of commandLabel with no consumers; the shared
  // label shape is what this pins.
  assert.equal(commandLabel('HEARTBEAT', 0), 'HEARTBEAT (0)');
});

const FIXTURE_BUNDLE = {
  dialect: 'fixture',
  messages: {
    Z_MESSAGE: {
      name: 'Z_MESSAGE',
      id: 12,
      description: 'sorts after A_MESSAGE with the same id',
      fields: [
        {
          name: 'mode',
          type: 'uint8_t',
          arrayLength: null,
          extension: false,
          enum: 'FIXTURE_MODE',
          display: null,
          units: null,
          minValue: null,
          maxValue: null,
          increment: null,
          description: 'Mode selector',
          invalid: null,
        },
      ],
    },
    LOW_MESSAGE: {
      name: 'LOW_MESSAGE',
      id: 2,
      description: 'sorts first by id',
      fields: [
        {
          name: 'temperature',
          type: 'int16_t',
          arrayLength: null,
          extension: false,
          enum: null,
          display: null,
          units: 'cdegC',
          minValue: -4000,
          maxValue: 8500,
          increment: 1,
          description: 'Temperature',
          invalid: '-32768',
        },
      ],
    },
    A_MESSAGE: {
      name: 'A_MESSAGE',
      id: 12,
      description: 'sorts before Z_MESSAGE with the same id',
      fields: [
        {
          name: 'flags',
          type: 'uint32_t',
          arrayLength: null,
          extension: true,
          enum: 'FIXTURE_FLAGS',
          display: 'bitmask',
          units: null,
          minValue: null,
          maxValue: null,
          increment: null,
          description: 'Flags',
          invalid: null,
        },
      ],
    },
  },
  enums: {
    FIXTURE_MODE: {
      name: 'FIXTURE_MODE',
      entries: [
        { name: 'FIXTURE_MODE_AUTO', value: 0, description: 'Automatic mode.' },
        { name: 'FIXTURE_MODE_MANUAL', value: 1, description: 'Manual mode.' },
      ],
    },
    FIXTURE_FLAGS: {
      name: 'FIXTURE_FLAGS',
      entries: [
        { name: 'FIXTURE_FLAGS_ONE', value: 1, description: 'First flag.' },
      ],
    },
    UNUSED_ENUM: {
      name: 'UNUSED_ENUM',
      entries: [
        { name: 'UNUSED_ENUM_VALUE', value: 9, description: 'Unused.' },
      ],
    },
  },
};

test('catalogMessagesFromBundle fixture: messages, fields, and referenced enums', () => {
  const catalog = catalogMessagesFromBundle(FIXTURE_BUNDLE, 'fixture');
  assert.equal(catalog.dialect, 'fixture');
  assert.deepEqual(
    catalog.messages.map((m) => m.name),
    ['LOW_MESSAGE', 'A_MESSAGE', 'Z_MESSAGE'],
    'messages are sorted by id then name'
  );

  const low = catalog.messages[0];
  assert.equal(low.label, 'LOW_MESSAGE (2)');
  assert.deepEqual(low.fields[0], {
    name: 'temperature',
    type: 'int16_t',
    arrayLength: null,
    extension: false,
    enum: null,
    display: null,
    units: 'cdegC',
    minValue: -4000,
    maxValue: 8500,
    increment: 1,
    description: 'Temperature',
    invalid: '-32768',
  });

  assert.deepEqual(Object.keys(catalog.enums).sort(), ['FIXTURE_FLAGS', 'FIXTURE_MODE']);
  assert.deepEqual(catalog.enums.FIXTURE_MODE[0], {
    name: 'FIXTURE_MODE_AUTO',
    value: 0,
    label: 'FIXTURE_MODE_AUTO (0)',
    description: 'Automatic mode.',
  });
});

test('listMessagesCatalog bundled smoke includes HEARTBEAT type enum', () => {
  const catalog = listMessagesCatalog('ardupilotmega');
  assert.equal(catalog.dialect, 'ardupilotmega');

  const heartbeat = catalog.messages.find((m) => m.name === 'HEARTBEAT');
  assert.ok(heartbeat, 'HEARTBEAT should be present');
  assert.equal(heartbeat.id, 0);

  const type = heartbeat.fields.find((f) => f.name === 'type');
  assert.equal(type.enum, 'MAV_TYPE');
  assert.ok(Array.isArray(catalog.enums.MAV_TYPE));
  assert.ok(catalog.enums.MAV_TYPE.some((entry) => entry.name === 'MAV_TYPE_GCS'));
});

function captureBuildRoutes(nodesById) {
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
        return nodesById[id] || null;
      },
    },
    httpAdmin: {
      get(path, _auth, handler) {
        handlers.set(path, handler);
      },
    },
    auth: { needsPermission() { return (_req, _res, next) => next && next(); } },
  };
  // Module-scope route guard survives across factory calls; clear the cache so
  // each capture rebinds httpAdmin.get against this RED stub.
  const buildPath = require.resolve('../../nodes/mavlink-build');
  delete require.cache[buildPath];
  require(buildPath)(RED);
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

test('build messages route serves a deployed Vehicle Profile bundle', () => {
  const custom = {
    dialect: 'custom',
    messages: {
      CUSTOM_MESSAGE: {
        name: 'CUSTOM_MESSAGE',
        id: 31000,
        description: 'custom only',
        fields: [],
      },
    },
    enums: {},
  };
  const handlers = captureBuildRoutes({
    veh1: {
      dialect: 'custom',
      getDialect: () => custom,
    },
  });
  const res = mockRes();
  handlers.get('/mavlink/build/messages')({ query: { vehicle: 'veh1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dialect, 'custom');
  assert.ok(res.body.messages.some((m) => m.id === 31000));
});

test('build messages route does not invent a dialect for missing Vehicle Profile', () => {
  const handlers = captureBuildRoutes({});
  const res = mockRes();
  handlers.get('/mavlink/build/messages')({ query: { vehicle: 'missing-id' } }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /not found|not deployed/i);
  assert.equal(res.body.messages, undefined);
});

test('build messages route falls back to an allow-listed bundled dialect when named', () => {
  const handlers = captureBuildRoutes({});
  const res = mockRes();
  handlers.get('/mavlink/build/messages')({ query: { vehicle: 'missing-id', dialect: 'common' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dialect, 'common');
  assert.ok(res.body.messages.some((m) => m.name === 'HEARTBEAT'));
});

test('build messages route with no dialect craters at the seed lookup — nothing defaults to ardupilotmega', () => {
  const handlers = captureBuildRoutes({});
  const res = mockRes();
  handlers.get('/mavlink/build/messages')({ query: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /undefined/);
  assert.equal(res.body.messages, undefined);
});
