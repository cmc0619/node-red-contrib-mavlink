'use strict';

/**
 * mavlink-out help: the three payload shapes in the order the runtime reads
 * them, and ports named the way the node-ports list numbers them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'nodes', 'mavlink-out.html'), 'utf8');
const help = html.slice(html.indexOf('data-help-name="mavlink-out"'));

test('Out help documents the topic shape, its precedence, and dialect field spelling', () => {
  const envelope = help.indexOf('Build-tier envelope');
  const topic = help.indexOf('Topic shape');
  const plain = help.indexOf('<code>{ name, fields }</code> — decoded-shape');
  assert.ok(envelope !== -1 && topic !== -1 && plain !== -1, 'all three shapes are listed');
  assert.ok(envelope < topic && topic < plain, 'listed in the order the runtime reads them');
  assert.match(help, /a <code>msg\.topic<\/code> that is present/);
  assert.match(help, /<dt class="optional">topic /, 'msg.topic is a listed input');
  assert.match(help, /<code>target_system<\/code>,\s*not <code>targetSystem<\/code>/, 'snake_case field names (N3)');
});

test('Out help names its ports as the node-ports list shows them, never 0/1', () => {
  assert.match(help, /<ol class="node-ports">/);
  assert.doesNotMatch(help, /Output [01]\b/);
});
