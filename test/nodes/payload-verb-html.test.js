'use strict';

/**
 * Payload verb editor: topic-dependent <select> on mavlink-payload and
 * mavlink-swarm (DESIGN.md §9).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PAYLOAD_VERBS } = require('../../lib/payload');

const payloadHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-payload.html'),
  'utf8'
);
const swarmHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-swarm.html'),
  'utf8'
);

function assertVerbSelect(html, label) {
  assert.match(
    html,
    /<select id="node-input-verb">/,
    `${label}: verb must be a select`
  );
  assert.ok(
    !html.includes('type="text" id="node-input-verb"'),
    `${label}: free-form verb input must be gone`
  );
}

test('mavlink-payload verb is a topic-dependent select', () => {
  assertVerbSelect(payloadHtml, 'mavlink-payload');
  assert.match(payloadHtml, /PAYLOAD_VERBS/, 'editor mirrors the payload verb catalog');
  assert.match(
    payloadHtml,
    /\$\('#node-input-topic'\)\.on\('change'/,
    'topic change refreshes verb options'
  );
  assert.match(payloadHtml, /function refreshVerbOptions/, 'verb options are rebuilt');
});

test('mavlink-swarm verb is a topic-dependent select', () => {
  assertVerbSelect(swarmHtml, 'mavlink-swarm');
  assert.match(swarmHtml, /PAYLOAD_VERBS/, 'editor mirrors the payload verb catalog');
  assert.match(
    swarmHtml,
    /\$\('#node-input-topic'\)\.on\('change'/,
    'topic change refreshes verb options'
  );
  assert.match(swarmHtml, /function refreshVerbOptions/, 'verb options are rebuilt');
});

test('editor catalog includes every lib/payload verb value', () => {
  for (const [topic, verbs] of Object.entries(PAYLOAD_VERBS)) {
    for (const { value } of verbs) {
      assert.match(payloadHtml, new RegExp(`value:\\s*'${value}'`), `payload editor missing ${topic}/${value}`);
      assert.match(swarmHtml, new RegExp(`value:\\s*'${value}'`), `swarm editor missing ${topic}/${value}`);
    }
  }
});
