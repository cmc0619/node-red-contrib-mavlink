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

test('a saved pick the list no longer offers is preserved, not widened (executed)', () => {
  // The removal of an event from the palette leaves saved flows naming it.
  // Such a pick selects nothing in the multi-select; canonicalizing that empty
  // selection would write blank — and blank is the *full* default set — so
  // merely opening a red node would widen its feed from one event to all of
  // them and clear the ring on save. The value must ride until the operator
  // picks. (Codex P1, #383.)
  const dialog = openStateDialog({ events: 'profile-mismatch' });
  assert.equal(dialog.hiddenEvents(), 'profile-mismatch', 'the illegal value is untouched');
  assert.notEqual(dialog.hiddenEvents(), '', 'blank would mean every event');

  // A mixed value is equally untouched — one unknown name protects the rest.
  const mixed = openStateDialog({ events: 'stale,profile-mismatch' });
  assert.equal(mixed.hiddenEvents(), 'stale,profile-mismatch');

  // Clicking Done without touching the control is the path that actually
  // persists, and it must not widen either (Codex P1, #383).
  const untouched = openStateDialog({ events: 'profile-mismatch' });
  untouched.save();
  assert.equal(untouched.hiddenEvents(), 'profile-mismatch', 'save leaves it alone');
  assert.notEqual(untouched.hiddenEvents(), '', 'blank would mean every event');

  // Picking anything is the operator's re-pick: the change handler writes it,
  // and saving keeps it.
  dialog.selectAll(['stale']);
  dialog.trigger();
  assert.equal(dialog.hiddenEvents(), 'stale');
  dialog.save();
  assert.equal(dialog.hiddenEvents(), 'stale', 're-pick survives the save hook');
});

test('a legal events value still canonicalizes on save', () => {
  // The guard must not cost the canonicalization it protects: an explicit full
  // list becomes blank so an event lib/state grows later is not frozen out.
  const full = openStateDialog({ events: DEFAULT_EVENTS.join(',') });
  full.save();
  assert.equal(full.hiddenEvents(), '', 'a full explicit list canonicalizes to blank');

  const partial = openStateDialog({ events: 'stale,expired' });
  partial.selectAll(['stale']);
  partial.save();
  assert.equal(partial.hiddenEvents(), 'stale', 'a narrowed pick is written on save');
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

/**
 * Execute the dialog script and run `oneditprepare` for a node, over a fake
 * DOM just deep enough for the events multi-select: `#mav-state-events-select`
 * models a multi-select (val() answers the selected array), and writes to
 * `#node-input-events` are captured. Chrome-only helpers are stubbed at their
 * contract boundary.
 *
 * @param {object} node  saved config the dialog opens over
 * @returns {{hiddenEvents: () => string, selectAll: (values: string[]) => void, trigger: () => void}}
 */
function openStateDialog(node) {
  const select = { options: [], selected: [], handlers: [] };
  const hidden = { value: undefined };
  function chain() {
    const c = {};
    for (const k of ['empty', 'append', 'on', 'val', 'each', 'hide', 'show', 'prop', 'attr']) c[k] = () => c;
    c.length = 0;
    return c;
  }
  function $(sel) {
    if (typeof sel === 'string' && sel.charAt(0) === '<') {
      const el = { _val: undefined, val(v) { if (v === undefined) return el._val; el._val = v; return el; }, text() { return el; } };
      return el;
    }
    if (sel === '#mav-state-events-select') {
      return {
        empty() { select.options = []; return this; },
        append(opt) { select.options.push(String(opt._val)); return this; },
        val(v) {
          if (v === undefined) return select.selected;
          // Real jQuery selects only values the element actually offers; a
          // name with no <option> silently selects nothing. Modelling that is
          // what makes a removed-event config reproduce here at all.
          const want = Array.isArray(v) ? v.map(String) : [String(v)];
          select.selected = want.filter((name) => select.options.indexOf(name) !== -1);
          return this;
        },
        on(_ev, fn) { select.handlers.push(fn); return this; },
      };
    }
    if (sel === '#node-input-events') {
      return { val(v) { if (v === undefined) return hidden.value; hidden.value = v; return this; } };
    }
    return chain();
  }
  $.getJSON = () => ({ fail() { return this; } });

  const registered = {};
  const context = {
    RED: {
      mavlink: {
        oneOf: () => () => true,
        validateUint8: () => () => true,
        ensureConfigNodePicker() {},
        loadEnumsCatalog() {},
        fillCompIdSelect() {},
      },
      nodes: { registerType(name, def) { registered[name] = def; } },
    },
    $,
    console,
  };
  vm.runInNewContext(script, context);
  // Node-RED fills #node-input-<property> from the saved node before
  // oneditprepare runs; model that so a preserved value is observable.
  hidden.value = node.events;
  registered['mavlink-state'].oneditprepare.call(node);
  return {
    hiddenEvents: () => hidden.value,
    selectAll: (values) => { select.selected = values.map(String); },
    trigger: () => select.handlers.forEach((fn) => fn()),
    // Clicking Done. Node-RED runs this before it reads the input fields back
    // into the node, so the hook still sees the previously saved value.
    save: () => registered['mavlink-state'].oneditsave.call(node),
  };
}

test('a full event selection saves as blank — the default set stays unfrozen (executed)', () => {
  // Blank means "the full default set, whatever lib/state currently emits".
  // Writing the explicit list on open-and-save would freeze today's names
  // into the config, and an event lib/state grows later would silently fall
  // out of it. Open-and-save on a blank config is the exact reported path:
  // the builder selects everything, and the initial sync must write blank.
  const dialog = openStateDialog({ events: '' });
  assert.equal(dialog.hiddenEvents(), '', 'a blank config round-trips as blank');

  // Explicitly selecting every event is the same set — also blank.
  dialog.selectAll([...DEFAULT_EVENTS]);
  dialog.trigger();
  assert.equal(dialog.hiddenEvents(), '', 'a hand-picked full selection canonicalizes to blank');
});

test('a partial event selection saves the picked names (executed)', () => {
  const dialog = openStateDialog({ events: 'stale,expired' });
  assert.equal(dialog.hiddenEvents(), 'stale,expired', 'the saved picks round-trip');

  dialog.selectAll(['stale']);
  dialog.trigger();
  assert.equal(dialog.hiddenEvents(), 'stale', 'a narrowed selection saves the pick');
});
