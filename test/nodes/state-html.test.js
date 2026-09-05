'use strict';

/**
 * mavlink-state editor: events are a fixed multi-select (DESIGN.md §6).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadNodeDefaults } = require('./html-assert');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-state.html'),
  'utf8'
);
const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];

/** The editor's event list — the one place the full peer-table set is spelled out. */
const STATE_EVENTS = (() => {
  const match = script.match(/const STATE_EVENTS = (\[[\s\S]*?\]);/);
  assert.ok(match, 'STATE_EVENTS array must be declared in the editor script');
  return vm.runInNewContext(match[1], {});
})();

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

test('STATE_EVENTS in the editor covers every peer-table emission name', () => {
  const peerTableSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'lib', 'connection', 'peer-table.js'),
    'utf8'
  );
  const header = peerTableSrc.match(/\* Events:([\s\S]*?)\n \*\//);
  assert.ok(header, 'peer-table.js must document its event names');
  const documented = [...header[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual([...STATE_EVENTS], documented);
});

test('events save as a comma-joined string for the runtime node property', () => {
  assert.match(html, /function syncEventsHiddenFromSelect/, 'hidden field is synced from the multi-select');
  assert.match(html, /values\.join\(','\)/, 'selected events are comma-joined on save');
  assert.match(html, /raw\.split\(','\)/, 'saved comma string is parsed back into selections');
});

test('a saved pick the list no longer offers is preserved until the operator re-picks (executed)', () => {
  // The removal of an event from the palette leaves saved flows naming it.
  // Such a pick selects nothing in the multi-select and stays red-ringed; the
  // dialog writes nothing over it until the operator picks. (Codex P1, #383.)
  const dialog = openStateDialog({ events: 'profile-mismatch' });
  assert.equal(dialog.hiddenEvents(), 'profile-mismatch', 'the illegal value is untouched');

  // A mixed value is equally untouched — one unknown name protects the rest.
  const mixed = openStateDialog({ events: 'stale,profile-mismatch' });
  assert.equal(mixed.hiddenEvents(), 'stale,profile-mismatch');

  // Picking anything is the operator's re-pick: the change handler writes it,
  // and saving keeps it.
  dialog.selectAll(['stale']);
  dialog.trigger();
  assert.equal(dialog.hiddenEvents(), 'stale');
});

test('mode is a closed vocabulary — the select offers exactly snapshot and feed', () => {
  const { mode } = loadNodeDefaults('mavlink-state');
  assert.equal(mode.validate.call({}, 'snapshot', {}), true);
  assert.equal(mode.validate.call({}, 'feed', {}), true);
  assert.match(String(mode.validate.call({}, 'snapshoot', {})), /must be one of/);
  assert.match(String(mode.validate.call({}, '', {})), /must be one of/, 'blank is not a mode');
});

test('events red-rings blank and a token the peer table never emits', () => {
  const { events } = loadNodeDefaults('mavlink-state');
  assert.equal(events.validate.length, 2, 'two args, or a reason string reads as valid (§14)');
  const feed = { id: 's1', mode: 'feed' };
  // Blank picks nothing: the feed would subscribe to no event, so it reds.
  assert.match(String(events.validate.call(feed, '', {})), /no event/);
  assert.match(String(events.validate.call(feed, ' , ', {})), /no event/, 'separators alone pick nothing');
  assert.equal(events.validate.call(feed, 'stale,expired,statustext', {}), true);
  assert.equal(events.validate.call(feed, STATE_EVENTS.join(','), {}), true, 'the full set passes');
  assert.match(String(events.validate.call(feed, 'stale,exipred', {})), /does not emit/);
  // Snapshot never reads the selection, so nothing about it can red a
  // snapshot node — two shipped snapshot examples save it blank.
  assert.equal(events.validate.call({ id: 's2', mode: 'snapshot' }, '', {}), true, 'snapshot ignores a blank selection');
  assert.equal(events.validate.call({ id: 's2', mode: 'snapshot' }, ['stale'], {}), true, 'snapshot ignores the shape too');
  // The dialog always writes the comma-joined string; a hand-edited array
  // would crater the runtime's split(','), so the ring must not vouch for it
  // (Codex, #331).
  assert.match(String(events.validate.call(feed, ['stale'], {})), /comma-joined/);
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
        reloadCompIdSelect() {},
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
  };
}

test('a full event selection saves the full list; a blank config selects nothing (executed)', () => {
  // Blank is not a pick: the builder selects no option for it, the value
  // rides untouched (red-ringed) and the operator re-picks.
  const dialog = openStateDialog({ events: '' });
  assert.equal(dialog.hiddenEvents(), '', 'a blank config is left for the operator to re-pick');

  // Selecting every event writes every name — the runtime subscribes to
  // exactly what is saved.
  dialog.selectAll([...STATE_EVENTS]);
  dialog.trigger();
  assert.equal(dialog.hiddenEvents(), STATE_EVENTS.join(','), 'a full selection saves the full list');
});

test('a partial event selection saves the picked names (executed)', () => {
  const dialog = openStateDialog({ events: 'stale,expired' });
  assert.equal(dialog.hiddenEvents(), 'stale,expired', 'the saved picks round-trip');

  dialog.selectAll(['stale']);
  dialog.trigger();
  assert.equal(dialog.hiddenEvents(), 'stale', 'a narrowed selection saves the pick');
});
