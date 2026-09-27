'use strict';

/**
 * Shipped example flows track the current config shape.
 *
 * The flows under `examples/` are data, not code, so a renamed config key
 * leaves them behind silently: the runtime reads the new key, finds nothing,
 * and falls back to its default. Three ways that has bitten already —
 *
 *   - `mavlink-in`'s `message` → `messages` (#211): default is "no filter", so
 *     an imported HEARTBEAT example became a firehose.
 *   - `mavlink-mission`'s `action` → `operation`: default is `download`, so a
 *     SITL example labelled *upload* actually downloaded.
 *   - `mavlink-payload`'s flat params → the `values` blob: default is `{}`, so
 *     an example reading "aim pitch -45, yaw 90" sent 0, 0.
 *
 * Only the first was caught, and only because a test was written for it by
 * name. This checks the shape instead: every key on a shipped mavlink node
 * must be one the node actually declares.
 *
 * `defaults` comes from evaluating the real editor HTML (`loadNodeDefaults`),
 * not from a list maintained here — so renaming a key updates this guard for
 * free, and the examples are what break.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadNodeDefaults } = require('./html-assert');

const EXAMPLES = path.join(__dirname, '..', '..', 'examples');

/**
 * Keys the Node-RED runtime puts on a node itself — never declared in
 * `defaults`, and not the flow author's to get wrong.
 */
const STRUCTURAL = new Set([
  'id', 'type', 'z', 'g', 'x', 'y', 'wires', 'credentials',
  'info', 'd', 'l', 'icon', 'inputs', 'outputs',
  'inputLabels', 'outputLabels', 'env',
]);

/** Every *.json under examples/, including examples/sitl/. */
function exampleFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return exampleFiles(full);
    return entry.name.endsWith('.json') ? [full] : [];
  });
}

/** Flatten a flow file to its node objects. */
function nodesOf(flow) {
  const found = [];
  (function walk(value) {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') {
      if (typeof value.type === 'string') found.push(value);
      Object.values(value).forEach(walk);
    }
  }(flow));
  return found;
}

/** Declared `defaults` keys per node type, evaluated once. */
const declaredCache = new Map();
function declaredKeys(type) {
  if (!declaredCache.has(type)) {
    declaredCache.set(type, new Set(Object.keys(loadNodeDefaults(type))));
  }
  return declaredCache.get(type);
}

test('every key on a shipped mavlink node is one the node declares', () => {
  const files = exampleFiles(EXAMPLES);
  assert.ok(files.length > 0, 'there are example flows to check');

  const unknown = [];
  for (const file of files) {
    const rel = path.relative(EXAMPLES, file);
    for (const node of nodesOf(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      if (!node.type.startsWith('mavlink-')) continue;

      let declared;
      try {
        declared = declaredKeys(node.type);
      } catch {
        unknown.push(`${rel}: ${node.id} — unregistered type "${node.type}"`);
        continue;
      }

      for (const key of Object.keys(node)) {
        if (STRUCTURAL.has(key) || declared.has(key)) continue;
        unknown.push(`${rel}: ${node.id} (${node.type}) — undeclared key "${key}"`);
      }
    }
  }

  assert.deepEqual(unknown, [], `undeclared keys in shipped examples:\n${unknown.join('\n')}`);
});

test('every mavlink-vehicle in an example serializes dialectRevision', () => {
  // Same Admin-API trap as SITL (#317): editor default `seed` is not written
  // into the flow JSON, and affirmative dialect picks no longer invent it.
  const missing = [];
  for (const file of exampleFiles(EXAMPLES)) {
    const rel = path.relative(EXAMPLES, file);
    for (const node of nodesOf(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      if (node.type !== 'mavlink-vehicle') continue;
      if (node.dialectRevision == null || node.dialectRevision === '') {
        missing.push(`${rel}: ${node.name || node.id}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `omitted dialectRevision → Vehicle Profile has no loaded dialect:\n${  missing.join('\n')}`
  );
});

test('mavlink-in nodes use the messages list, not the retired singular key (#211)', () => {
  // Kept explicit on top of the shape check above: `messages` must be an
  // *array*, which "is it a declared key" alone would not catch.
  for (const file of exampleFiles(EXAMPLES)) {
    const rel = path.relative(EXAMPLES, file);
    for (const node of nodesOf(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      if (node.type !== 'mavlink-in') continue;
      assert.ok(!('message' in node), `${rel}: ${node.id} still carries "message"`);
      assert.ok(Array.isArray(node.messages), `${rel}: ${node.id} must set "messages" to an array`);
    }
  }
});

test('every payload node in an example resolves to a real recipe', () => {
  // A topic/verb pair with no recipe throws at build time, so the example is
  // dead on arrival — `examples/18` shipped three of them under a `release`
  // topic that never existed. `path` matters: gimbal/aim has separate legacy
  // and manager recipes, so build exactly as the node does.
  const { buildPayloadMessage } = require('../../lib/payload');
  for (const file of exampleFiles(EXAMPLES)) {
    const rel = path.relative(EXAMPLES, file);
    for (const node of nodesOf(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      if (node.type !== 'mavlink-payload') continue;
      assert.doesNotThrow(
        () => buildPayloadMessage({ topic: node.topic, verb: node.verb, path: node.path, carrier: 'long', target: { sysid: 1, compid: 1 }, values: {} }),
        `${rel}: ${node.id} has no recipe for ${node.topic}/${node.verb}/${node.path || ''}`
      );
    }
  }
});

test('no example saves a value key its dialog does not render', () => {
  // A pinned or driver-owned slot carries the recipe's own value (the legacy
  // gimbal aim pins MAV_MOUNT_MODE_MAVLINK_TARGETING), and a key stem the
  // runtime does not read (`actionValue` for `action`) is sent unset. The
  // dialog renders exactly fieldMetaFromBundle's keys, so a saved key outside
  // them is one the operator never set and the wire never reads (Codex, #224).
  const { fieldMetaFromBundle } = require('../../lib/payload');
  const bundle = require('../../lib/metadata/bundled').loadBundled('ardupilotmega');
  const offenders = [];
  for (const file of exampleFiles(EXAMPLES)) {
    const rel = path.relative(EXAMPLES, file);
    for (const node of nodesOf(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      if (node.type !== 'mavlink-payload' || !node.values) continue;
      const pathKey = node.topic === 'gimbal' && node.verb === 'aim' ? node.path : '';
      const rendered = fieldMetaFromBundle(bundle, node.topic, node.verb, pathKey);
      for (const key of Object.keys(node.values)) {
        if (!(key in rendered)) offenders.push(`${rel}: ${node.id} saves "${key}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `saved keys must be rendered keys:\n${offenders.join('\n')}`);
});
