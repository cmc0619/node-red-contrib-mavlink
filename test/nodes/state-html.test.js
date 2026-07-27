'use strict';

/**
 * mavlink-state editor: events are a fixed multi-select (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { DEFAULT_EVENTS } = require('../../lib/state');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-state.html'),
  'utf8'
);
const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];

test('events is a multi-select, not a CSV text field (§6)', () => {
  assert.match(
    html,
    /<select id="mav-state-events-select"[^>]*multiple/,
    'Events must be a native multi-select'
  );
  assert.match(html, /<input type="hidden" id="node-input-events">/, 'comma-joined value is stored in a hidden input');
  assert.ok(
    !html.includes('placeholder="stale,expired,statustext"'),
    'the CSV text placeholder must be gone'
  );
});

test('STATE_EVENTS in the editor matches lib/state DEFAULT_EVENTS', () => {
  const match = script.match(/var STATE_EVENTS = (\[[\s\S]*?\]);/);
  assert.ok(match, 'STATE_EVENTS array must be declared in the editor script');
  const editorEvents = vm.runInNewContext(match[1], {});
  assert.deepEqual([...editorEvents], [...DEFAULT_EVENTS]);
});

test('events save as a comma-joined string for runtime backward compatibility', () => {
  assert.match(html, /function syncEventsHiddenFromSelect/, 'hidden field is synced from the multi-select');
  assert.match(html, /values\.join\(','\)/, 'selected events are comma-joined on save');
  assert.match(html, /oneditsave/, 'save hook writes the hidden events property');
  assert.match(html, /raw\.split\(','\)/, 'saved comma string is parsed back into selections');
});
