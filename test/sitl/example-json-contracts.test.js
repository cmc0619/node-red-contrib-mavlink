'use strict';

/**
 * Shipped examples are the one hand-built flow JSON this project owns, and
 * the runtime trusts it exactly as it trusts an editor save. SITL examples
 * deploy via the Admin API as raw flow JSON, where Node-RED does not
 * materialize editor `defaults` onto omitted properties; a blank string
 * survives even an editor import, because the property exists. Values the
 * editor red-rings blank must therefore be serialized, concretely, in every
 * shipped file.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXAMPLES_DIR = path.join(__dirname, '../../examples');
const SITL_DIR = path.join(EXAMPLES_DIR, 'sitl');

/** Every shipped flow file: `examples/*.json` and `examples/sitl/*.json`. */
function loadFlows() {
  return [EXAMPLES_DIR, SITL_DIR].flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({
        file: path.relative(EXAMPLES_DIR, path.join(dir, f)),
        nodes: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
      }))
  );
}

/** A serialized value the runtime can read as a number: present and not blank. */
function blank(value) {
  return value == null || value === '';
}

test('mavlink-param confirm/collect nodes serialize timeout (Admin-API deploy)', () => {
  const missing = [];
  for (const { file, nodes } of loadFlows()) {
    for (const n of nodes) {
      if (n.type !== 'mavlink-param') continue;
      const needs =
        n.delivery === 'confirm' || n.delivery === 'collect' || n.action === 'request-list';
      if (!needs) continue;
      if (blank(n.timeout)) missing.push(`${file}:${n.name || n.id}`);
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

test('mavlink-mission upload nodes serialize items (Admin-API deploy)', () => {
  // The constructor parses configured items once (config.items.trim(), #371's
  // hoist) and only Upload reads them. Editor default is items: '' — blank
  // means "items come from the payload" — but Admin deploy keeps an omitted
  // key absent, and undefined.trim() throws at deploy (SITL 22 went PARTIAL
  // on exactly this).
  const missing = [];
  for (const { file, nodes } of loadFlows()) {
    for (const n of nodes) {
      if (n.type !== 'mavlink-mission' || n.operation !== 'upload') continue;
      if (n.items == null) missing.push(`${file}:${n.name || n.id}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "omitted items → config.items.trim() throws in the constructor under Admin deploy"
  );
});

test('mavlink-out and mavlink-build nodes serialize band (Admin-API deploy)', () => {
  // The editor always writes band ('2') and rings membership; Admin deploy
  // keeps an omitted key absent, so config.band would read NaN and the
  // queue's §5 switch would select nothing — a silent no-send behind a
  // 'sent' record (#375, declined as runtime work: the flow author owns
  // msg.band and hand-built JSON; these shipped examples are the one
  // hand-built JSON WE own, so the contract pins the key here instead).
  const missing = [];
  for (const { file, nodes } of loadFlows()) {
    for (const n of nodes) {
      if (n.type !== 'mavlink-out' && n.type !== 'mavlink-build') continue;
      if (n.band == null) missing.push(`${file}:${n.name || n.id}`);
    }
  }
  assert.deepEqual(missing, [], 'omitted band → NaN → the queue enqueues nothing, silently');
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

test('mavlink-mission nodes serialize timeout and maxRetries', () => {
  // The editor carries 1500 ms / 5 retries and red-rings blank; the runtime
  // reads Number(config.x). A blank timeout arms a 0 ms step timer and a
  // blank ceiling allows no retry, so the transfer stalls before the vehicle
  // can answer (Codex on #429).
  const missing = [];
  for (const { file, nodes } of loadFlows()) {
    for (const n of nodes) {
      if (n.type !== 'mavlink-mission') continue;
      if (blank(n.timeout) || blank(n.maxRetries)) missing.push(`${file}:${n.name || n.id}`);
    }
  }
  assert.deepEqual(missing, [], 'blank mission timing → 0 ms step timer, no retries');
});

test('confirm-tier mavlink-move nodes serialize ackTimeout', () => {
  // Only Send & confirm arms the AckWaiter; Number('') is 0, an ack timer
  // that fires before the vehicle can answer.
  const missing = [];
  for (const { file, nodes } of loadFlows()) {
    for (const n of nodes) {
      if (n.type !== 'mavlink-move' || n.delivery !== 'confirm') continue;
      if (blank(n.ackTimeout)) missing.push(`${file}:${n.name || n.id}`);
    }
  }
  assert.deepEqual(missing, [], 'blank ackTimeout → 0 ms ack timer → unconfirmed before the ACK');
});

test('every shipped mission item carries current and autocontinue', () => {
  // MISSION_ITEM(_INT).current and .autocontinue ride as given; an item
  // without them serializes an undefined uint8, which the wire refuses when
  // the vehicle requests that item. Items live in a Mission node's configured
  // `items` or in an inject's payload / payload.items.
  const lacking = [];
  let seen = 0;
  const check = (where, items) => {
    if (!Array.isArray(items)) return;
    seen += items.length;
    items.forEach((item, i) => {
      if (item.current === undefined || item.autocontinue === undefined) lacking.push(`${where}[${i}]`);
    });
  };
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  for (const { file, nodes } of loadFlows()) {
    for (const n of nodes) {
      const where = `${file}:${n.name || n.id}`;
      if (n.type === 'mavlink-mission' && n.items) check(where, parse(n.items));
      if (n.type !== 'inject') continue;
      if (n.payloadType === 'json') check(where, (parse(n.payload) || {}).items);
      for (const prop of n.props || []) {
        if (prop.vt !== 'json') continue;
        const value = parse(prop.v);
        if (prop.p === 'payload.items') check(where, value);
        if (prop.p === 'payload' && value && !Array.isArray(value)) check(where, value.items);
      }
    }
  }
  assert.ok(seen > 0, 'the shipped examples carry mission items to check');
  assert.deepEqual(lacking, [], 'a mission item without current/autocontinue serializes undefined uint8s');
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
