'use strict';

/**
 * Shipped example flows track the current config shape.
 *
 * The flows under `examples/` are data, not code, so a renamed config key
 * leaves them behind silently: the runtime reads the new key, finds nothing,
 * and falls back to its default. For `mavlink-in` that default is "no filter",
 * which turns an imported HEARTBEAT example into a firehose (#211).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXAMPLES = path.join(__dirname, '..', '..', 'examples');

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
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === 'object') {
      if (typeof value.type === 'string') found.push(value);
      Object.values(value).forEach(walk);
    }
  }(flow));
  return found;
}

test('mavlink-in nodes in shipped examples use the messages list (#211)', () => {
  const files = exampleFiles(EXAMPLES);
  assert.ok(files.length > 0, 'there are example flows to check');

  for (const file of files) {
    const rel = path.relative(EXAMPLES, file);
    const nodes = nodesOf(JSON.parse(fs.readFileSync(file, 'utf8')));
    for (const node of nodes.filter((n) => n.type === 'mavlink-in')) {
      assert.ok(
        !('message' in node),
        `${rel}: ${node.id} still carries the retired singular "message" key`
      );
      assert.ok(
        Array.isArray(node.messages),
        `${rel}: ${node.id} must set "messages" to an array`
      );
    }
  }
});
