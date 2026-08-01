'use strict';

/**
 * Issue #88 — blank lat/lon/alt must not become 0,0 (null island).
 * Destination presets and ROI require values for all three.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { buildParamArray, getPreset } = require('../../lib/command/presets');
const { buildPayloadMessage } = require('../../lib/payload');

const BLANK_RE = /lat|lon|alt|0,0|blank/i;

test('reposition refuses blank lat/lon/alt — no silent null island (#88)', () => {
  const preset = getPreset('reposition');
  assert.throws(
    () => buildParamArray(preset, { 1: 5 }),
    BLANK_RE
  );
  assert.throws(
    () => buildParamArray(preset, { 1: 5, 5: -35, 6: 149 }),
    BLANK_RE,
    'alt is required too — blank must not become 0'
  );
});

test('reposition accepts explicit lat/lon/alt including 0 and NaN', () => {
  const preset = getPreset('reposition');
  const withZero = buildParamArray(preset, { 5: 0, 6: 0, 7: 0 });
  assert.deepEqual(withZero.slice(4), [0, 0, 0]);
  const withNan = buildParamArray(preset, { 5: NaN, 6: NaN, 7: 50 });
  assert.ok(Number.isNaN(withNan[4]));
  assert.ok(Number.isNaN(withNan[5]));
  assert.equal(withNan[6], 50);
});

test('orbit refuses absent center/alt — examples must send NaN explicitly (#88)', () => {
  assert.throws(
    () => buildParamArray(getPreset('orbit'), { 1: 100, 2: 5, 3: 0 }),
    BLANK_RE
  );
});

test('takeoff still allows altitude-only — unused lat/lon stay zero-filled', () => {
  const arr = buildParamArray(getPreset('takeoff'), { 7: 10 });
  assert.equal(arr[6], 10);
  assert.equal(arr[4], 0);
  assert.equal(arr[5], 0);
});

test('gimbal roi-set refuses blank lat/lon/alt (#88)', () => {
  assert.throws(
    () => buildPayloadMessage({
      carrier: 'long',
      topic: 'gimbal',
      verb: 'roi-set',
      target: { sysid: 1, compid: 154 },
      values: {},
    }),
    BLANK_RE
  );
  assert.throws(
    () => buildPayloadMessage({
      carrier: 'long',
      topic: 'gimbal',
      verb: 'roi-set',
      target: { sysid: 1, compid: 154 },
      values: { lat: -35, lon: 149 },
    }),
    BLANK_RE,
    'alt required'
  );
  assert.throws(
    () => buildPayloadMessage({
      carrier: 'long',
      topic: 'gimbal',
      verb: 'roi-set',
      target: { sysid: 1, compid: 154 },
      values: { lat: '  ', lon: null, alt: 50 },
    }),
    BLANK_RE,
    'whitespace/null lat/lon are blank'
  );
});

test('gimbal roi-set preserves explicit NaN lat/lon (§14 #88)', () => {
  const built = buildPayloadMessage({
    carrier: 'long',
    topic: 'gimbal',
    verb: 'roi-set',
    target: { sysid: 1, compid: 154 },
    values: { lat: NaN, lon: 'NaN', alt: 50 },
  });
  assert.ok(Number.isNaN(built.message.fields.param5));
  assert.ok(Number.isNaN(built.message.fields.param6));
  assert.equal(built.message.fields.param7, 50);
});

test('reposition refuses whitespace/null location params (#88)', () => {
  const { mergeParams } = require('../../lib/command/merge-params');
  const user = mergeParams(
    { params: '{"5":"  ","6":null,"7":50}' },
    { 5: ' ', 6: null }
  );
  assert.equal(Object.prototype.hasOwnProperty.call(user, 5), false);
  assert.equal(Object.prototype.hasOwnProperty.call(user, 6), false);
  assert.throws(() => buildParamArray(getPreset('reposition'), user), BLANK_RE);
});

test('command node: reposition with blank coords fails loud on build (#88)', async () => {
  const RED = redStub({});
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  const node = new Node({
    carrier: 'long',
    mode: 'preset',
    preset: 'reposition',
    delivery: 'build',
    targetSysid: '1',
    targetCompid: '1',
  });

  let sent;
  let err;
  node.emit('input', { payload: null }, (m) => { sent = m; }, (e) => { err = e; });
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(err, 'done(err) on blank coords');
  assert.match(String(err.message || err), BLANK_RE);
  assert.equal(sent[0], null, 'no message on output 0');
  assert.equal(sent[1].result, 'failed');
});

test('command node advanced hasLocation: blank param5/6/7 refused (#88)', async () => {
  const RED = redStub({});
  require('../../nodes/mavlink-command')(RED);
  const Node = RED.nodes.types['mavlink-command'];
  // DO_REPOSITION = 192 — hasLocation in common.xml
  const node = new Node({
    carrier: 'long',
    mode: 'advanced',
    advancedCommand: '192',
    dialect: 'common',
    delivery: 'build',
    targetSysid: '1',
    targetCompid: '1',
    params: '{}',
  });

  let err;
  node.emit('input', { payload: null }, () => {}, (e) => { err = e; });
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(err, 'done(err) when advanced location params blank');
  assert.match(String(err.message || err), BLANK_RE);
});

/** Minimal Node-RED stub matching test/command/node.test.js. */
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
      },
      registerType(name, ctor) {
        this.types[name] = ctor;
      },
      getNode(id) {
        return nodesById[id];
      },
    },
    httpAdmin: { get() {} },
    auth: { needsPermission() { return (_req, _res, next) => next && next(); } },
  };
}
