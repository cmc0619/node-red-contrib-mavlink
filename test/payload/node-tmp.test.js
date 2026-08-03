'use strict';

/**
 * THROWAWAY — delete alongside nodes/mavlink-payload-tmp.{js,html}.
 *
 * The two `-tmp` editors are a design comparison, but they ride the shipped
 * runtime through one parameter, so the thing worth pinning is that the
 * parameterization did not fork behaviour: same message out, from a `values`
 * object instead of a field per slot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function redStub() {
  const types = {};
  return {
    nodes: {
      types,
      createNode(node) {
        const { EventEmitter } = require('node:events');
        Object.assign(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.status = () => {};
        node.error = () => {};
      },
      getNode: () => null,
      registerType(name, ctor) {
        types[name] = ctor;
      },
    },
    log: { error: () => {} },
  };
}

function buildWith(RED, type, config) {
  const Node = RED.nodes.types[type];
  assert.ok(Node, `${type} registered`);
  const node = new Node(Object.assign({ delivery: 'build', dialect: 'common' }, config));
  let sent;
  node.emit('input', {}, (messages) => { sent = messages; }, () => {});
  return sent;
}

test('both -tmp types register and read their values object', () => {
  const RED = redStub();
  require('../../nodes/mavlink-payload-tmp')(RED);

  for (const type of ['mavlink-payload-tmp1', 'mavlink-payload-tmp2']) {
    const sent = buildWith(RED, type, {
      carrier: 'long',
      topic: 'servo',
      verb: 'set',
      targetSystem: 7,
      targetComponent: 1,
      values: { servo: 8, pwm: 1600 },
    });
    assert.equal(sent[0].payload.name, 'COMMAND_LONG', type);
    assert.equal(sent[0].payload.fields.command, 183, type);
    assert.equal(sent[0].payload.fields.param1, 8, type);
    assert.equal(sent[0].payload.fields.param2, 1600, type);
  }
});

test('a -tmp node builds the same message the shipped node does', () => {
  const config = {
    carrier: 'long',
    topic: 'servo',
    verb: 'set',
    targetSystem: 7,
    targetComponent: 1,
  };

  const shippedRED = redStub();
  require('../../nodes/mavlink-payload')(shippedRED);
  const shipped = buildWith(shippedRED, 'mavlink-payload', {
    ...config,
    servo: 8,
    pwm: 1600,
  });

  const tmpRED = redStub();
  require('../../nodes/mavlink-payload-tmp')(tmpRED);
  const tmp = buildWith(tmpRED, 'mavlink-payload-tmp2', {
    ...config,
    values: { servo: 8, pwm: 1600 },
  });

  assert.deepEqual(tmp[0].payload, shipped[0].payload);
});

test('the -tmp editors do not register a second field-tips route', () => {
  const routes = [];
  const RED = redStub();
  RED.httpAdmin = { get: (path) => routes.push(path) };
  RED.auth = { needsPermission: () => () => {} };

  require('../../nodes/mavlink-payload')(RED);
  const afterShipped = routes.length;
  require('../../nodes/mavlink-payload-tmp')(RED);

  assert.equal(afterShipped, 1, 'the shipped node serves the route');
  assert.equal(routes.length, 1, 'both -tmp types reuse it');
});
