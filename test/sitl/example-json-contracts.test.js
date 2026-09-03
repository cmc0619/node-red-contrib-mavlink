'use strict';

/**
 * Shipped examples are the one hand-built flow JSON this project owns, and
 * the runtime trusts it exactly as it trusts an editor save. SITL examples
 * deploy via the Admin API as raw flow JSON, where Node-RED neither
 * materializes editor `defaults` onto omitted properties (DESIGN.md 14.41)
 * nor runs a validator. So every shipped node must already be what an editor
 * export is: every declared key present, every validator green.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadNodeType } = require('../nodes/html-assert');

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

/** A value the editor would ring as absent. */
function blank(value) {
  return value == null || value === '';
}

test('every shipped mavlink node is editor-shaped: all declared keys, every validator green', () => {
  // The editor definition is the schema (§6): `defaults` names every key a
  // saved node carries, and its validators are the whole protection. Admin
  // deploy materializes nothing and validates nothing, so the JSON has to
  // arrive already in that shape — the one integration/node-red-smoke.test.js
  // builds with editorShaped(). Validators run against the node as saved,
  // with the flow's other nodes visible to RED.nodes.node() for config-ref
  // rings. The one thing flow JSON cannot carry is a credential, so a signing
  // Connection validates with the passphrase the SITL harness injects on
  // deploy (sitl/run-example-suite.js signingCredentialsForFlows).
  const problems = [];
  for (const { file, nodes } of loadFlows()) {
    const lookup = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const types = new Map();
    for (const n of nodes) {
      if (!n.type.startsWith('mavlink-')) continue;
      const where = `${file}:${n.name || n.id}`;
      if (!types.has(n.type)) types.set(n.type, loadNodeType(n.type, lookup));
      const { defaults } = types.get(n.type);
      const signs = n.type === 'mavlink-connection' && (n.signOutbound || n.requireSigned);
      const self = signs ? { ...n, credentials: { has_signingPassphrase: true } } : n;
      for (const [key, def] of Object.entries(defaults)) {
        if (!(key in n)) {
          problems.push(`${where}: omits ${key} (editor default ${JSON.stringify(def.value)})`);
          continue;
        }
        if (def.required && blank(n[key])) problems.push(`${where}: ${key} is required and blank`);
        if (typeof def.validate !== 'function') continue;
        const verdict = def.validate.call(self, n[key], {});
        if (verdict !== true) problems.push(`${where}: ${key}=${JSON.stringify(n[key])} — ${verdict}`);
      }
    }
  }
  assert.deepEqual(problems, [], `shipped examples are not editor-shaped:\n${problems.join('\n')}`);
});

test('mavlink-in rateLimit is a string (Admin-API deploy)', () => {
  // parseRateLimit calls .split; a JSON number throws TypeError at deploy.
  const bad = [];
  for (const { file, nodes } of loadFlows()) {
    for (const n of nodes) {
      if (n.type !== 'mavlink-in') continue;
      if (n.rateLimit != null && typeof n.rateLimit !== 'string') {
        bad.push(`${file}:${n.name || n.id} (${typeof n.rateLimit})`);
      }
    }
  }
  assert.deepEqual(bad, [], 'numeric rateLimit → TypeError in parseRateLimit');
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
