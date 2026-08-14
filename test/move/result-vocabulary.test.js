'use strict';

/**
 * The vocabulary pin: one node, one result vocabulary.
 *
 * 'succeeded' is banned from mavlink-move outright — it once meant both "on the
 * wire" (setpoints) and "the vehicle agreed" (reposition ACCEPTED), and that
 * double meaning is how SITL 27 could never pass while 30 measured silence as
 * success (#267, one carrier over). A setpoint says 'sent', which is the same
 * word mavlink-command's send tier uses for the same claim: it left, nobody
 * will answer.
 *
 * The test drives the REAL node (stub-over-fiction lesson, #252/#267).
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

function redStub(nodesById) {
  return {
    nodes: {
      types: {},
      createNode(node, config) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'node';
        node.status = () => {};
        node.error = () => {};
        node.warn = () => {};
        node.send = (m) => m;
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
      getNode(id) {
        return nodesById[id];
      },
    },
  };
}

function makeNode(config, nodesById = {}) {
  const RED = redStub(nodesById);
  require('../../nodes/mavlink-move')(RED);
  const Node = RED.nodes.types['mavlink-move'];
  return new Node(config);
}

function conn() {
  const sends = [];
  const subs = [];
  return {
    id: 'conn',
    vehicle: {},
    sends,
    subs,
    send(message, opts) { sends.push({ message, opts }); },
    subscribe(filter, handler) { subs.push({ filter, handler }); return () => {}; },
    resolveSourceIds() { return { sysid: 255, compid: 190 }; },
  };
}

// Blank, not 0: a zero is a commanded value under the derived mask, and a
// placeholder 0 here would turn the velocity stream fixtures into
// position-velocity commanding the local origin (CodeRabbit, #277).
const setpointCfg = {
  action: 'steer', reference: 'world', north: '', east: '', up: '',
  targetSystem: 5, targetComponent: 1,
};

/** Drive one input; resolve on done() with everything the input emitted. */
function drive(node, payload) {
  return new Promise((resolve) => {
    const out = [];
    node.emit(
      'input',
      { payload },
      (m) => { out.push(m); },
      (err) => resolve({ out, err })
    );
  });
}

test('setpoint send emits result "sent" — shared word, shared meaning with mavlink-command\'s send tier', async () => {
  const c = conn();
  const node = makeNode({ ...setpointCfg, delivery: 'send', connection: 'conn' }, { conn: c });
  const { out, err } = await drive(node, { position: { north: 1, east: 2, up: 3 } });
  assert.equal(err, undefined);
  assert.equal(c.sends.length, 1);
  assert.equal(out[0][0].payload.result, 'sent');
  assert.equal(out[0][1].result, 'sent');
});
