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
const { loadNodeDefaults } = require('./html-assert');

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

test('events save as a comma-joined string for the runtime node property', () => {
  assert.match(html, /function syncEventsHiddenFromSelect/, 'hidden field is synced from the multi-select');
  assert.match(html, /values\.join\(','\)/, 'selected events are comma-joined on save');
  assert.match(html, /oneditsave/, 'save hook writes the hidden events property');
  assert.match(html, /raw\.split\(','\)/, 'saved comma string is parsed back into selections');
});

test('mode is a closed vocabulary — the select offers exactly snapshot and feed', () => {
  const { mode } = loadNodeDefaults('mavlink-state');
  assert.equal(mode.validate.call({}, 'snapshot', {}), true);
  assert.equal(mode.validate.call({}, 'feed', {}), true);
  assert.match(String(mode.validate.call({}, 'snapshoot', {})), /must be one of/);
  assert.match(String(mode.validate.call({}, '', {})), /must be one of/, 'blank is not a mode');
});

test('events red-rings a token the peer table never emits; blank is the default set', () => {
  const { events } = loadNodeDefaults('mavlink-state');
  assert.equal(events.validate.length, 2, 'two args, or a reason string reads as valid (§14)');
  assert.equal(events.validate.call({}, '', {}), true, 'blank = full default set');
  assert.equal(events.validate.call({}, 'stale,expired,statustext', {}), true);
  assert.equal(events.validate.call({}, DEFAULT_EVENTS.join(','), {}), true, 'the full set passes');
  assert.match(String(events.validate.call({}, 'stale,exipred', {})), /does not emit/);
  // The dialog always writes the comma-joined string; a hand-edited array
  // would crater the runtime's split(','), so the ring must not vouch for it
  // (Codex, #331).
  assert.match(String(events.validate.call({}, ['stale'], {})), /comma-joined/);
});

test('target filters carry the uint8 range ring, compid included', () => {
  const { targetSystem, targetComponent } = loadNodeDefaults('mavlink-state');
  for (const field of [targetSystem, targetComponent]) {
    assert.equal(field.validate.call({}, '', {}), true, 'blank = any');
    assert.equal(field.validate.call({}, 0, {}), true, 'broadcast/all is legal');
    assert.equal(field.validate.call({}, 255, {}), true);
    assert.match(String(field.validate.call({}, 256, {})), /between 0 and 255/);
  }
});

test('DEFAULT_EVENTS covers every peer-table emission name', () => {
  const peerTableSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'lib', 'connection', 'peer-table.js'),
    'utf8'
  );
  const header = peerTableSrc.match(/\* Events:([\s\S]*?)\n \*\//);
  assert.ok(header, 'peer-table.js must document its event names');
  const documented = [...header[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual([...DEFAULT_EVENTS], documented);
});

test('a full event selection saves as blank — the default set stays unfrozen', () => {
  // Blank means "the full default set, whatever lib/state currently emits".
  // Writing the explicit 16-name list on open-and-save would freeze today's
  // list into the config, and an event lib/state grows later would silently
  // fall out of it.
  assert.match(html, /values\.length === STATE_EVENTS\.length \? '' :/,
    'the sync canonicalizes a full selection to blank');
});
