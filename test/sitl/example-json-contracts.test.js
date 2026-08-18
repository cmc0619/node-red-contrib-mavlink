'use strict';

/**
 * SITL examples are deployed via the Admin API as raw flow JSON — Node-RED
 * does not materialize editor `defaults` onto omitted properties. Contracts
 * that the editor would fill must be serialized in the shipped files.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SITL_DIR = path.join(__dirname, '../../examples/sitl');

function loadFlows() {
  return fs
    .readdirSync(SITL_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, nodes: JSON.parse(fs.readFileSync(path.join(SITL_DIR, f), 'utf8')) }));
}

test('mavlink-param confirm/collect nodes serialize timeout (Admin-API deploy)', () => {
  const missing = [];
  for (const { file, nodes } of loadFlows()) {
    for (const n of nodes) {
      if (n.type !== 'mavlink-param') continue;
      const needs =
        n.delivery === 'confirm' || n.delivery === 'collect' || n.action === 'request-list';
      if (!needs) continue;
      if (n.timeout == null || n.timeout === undefined) {
        missing.push(`${file}:${n.name || n.id}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    'omitted timeout → Number(undefined)=NaN → setTimeout fires immediately under Admin deploy'
  );
});

test('sitl 40 command nodes serialize identity (Admin-API deploy)', () => {
  // Editor default is identity: ''. String(undefined) becomes the override
  // id "undefined" and Connection.send throws on identity.sysid (SITL 40).
  const nodes = JSON.parse(
    fs.readFileSync(path.join(SITL_DIR, '40-transition-events.json'), 'utf8')
  );
  const missing = nodes
    .filter((n) => n.type === 'mavlink-command')
    .filter((n) => n.identity == null)
    .map((n) => n.name || n.id);
  assert.deepEqual(missing, [], 'omitted identity → String(undefined) override crater');
});

test('mavlink-vehicle profiles serialize dialectRevision (Admin-API deploy)', () => {
  // Editor default is dialectRevision: 'seed' (required). Admin deploy does not
  // materialize omitted defaults — blank revision fails resolveDialect and
  // Connection throws "has no loaded dialect" (#317).
  const missing = [];
  for (const { file, nodes } of loadFlows()) {
    for (const n of nodes) {
      if (n.type !== 'mavlink-vehicle') continue;
      if (n.dialectRevision == null || n.dialectRevision === '') {
        missing.push(`${file}:${n.name || n.id}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    'omitted dialectRevision → Vehicle Profile has no loaded dialect under Admin deploy'
  );
});

test('mission upload injects put items under msg.payload.items (not a bare array)', () => {
  const bare = [];
  for (const { file, nodes } of loadFlows()) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      if (n.type !== 'inject') continue;
      const props = n.props || [];
      const payloadProp = props.find((p) => p.p === 'payload' && p.vt === 'json');
      if (!payloadProp) continue;
      let parsed;
      try {
        parsed = JSON.parse(payloadProp.v);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      const targets = (n.wires && n.wires[0]) || [];
      const hitsMissionUpload = targets.some((id) => {
        const t = byId.get(id);
        return t && t.type === 'mavlink-mission' && t.operation === 'upload';
      });
      if (hitsMissionUpload) bare.push(`${file}:${n.name || n.id}`);
    }
  }
  assert.deepEqual(
    bare,
    [],
    'mavlink-mission reads msg.payload.items; a bare array resolves to [] → phase:empty'
  );
});
