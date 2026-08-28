'use strict';

/**
 * Executed dialog-lifecycle tests for the mavlink-command editor's async
 * loads (CodeRabbit #371 round 2). The other command-html tests pin source;
 * these run the real editor script — oneditprepare and the shared
 * RED.mavlink.loadCatalog — against a stateful jQuery fake whose network
 * responses the test releases by hand, because both findings are races that
 * only exist between a request and its response:
 *
 * 1. loadPresets carries a staleness fence: without one, a response requested
 *    by a closed dialog A rebuilds the preset select of the dialog B now open
 *    — through the live global selectors, with A's saved preset — and B
 *    saves A's preset.
 * 2. Every commands-catalog call site owns its request sequence: sharing one
 *    lets a later fetch from another site discard the first caller's callback
 *    (loadCatalog's seq guard). On an Advanced-mode open the discarded
 *    callback is the one that fills the MAV_CMD dropdown, so the dialog comes
 *    up with an empty command list whenever the (smaller, faster) presets
 *    response lands mid-flight and starts the option-tips fetch.
 *
 * Scaffolding helpers that only touch chrome (config pickers, row
 * visibility, CompID reloads, tooltips, param controls) are stubbed at their
 * contract boundary; everything the findings are about runs for real.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'nodes', 'mavlink-command.html'), 'utf8');
const resourceSrc = fs.readFileSync(path.join(root, 'resources', 'mavlink-editor.js'), 'utf8');

const PRESET_GROUPS = [{
  group: 'flight',
  presets: [
    { id: 'disarm', name: 'Disarm', commandId: 400 },
    { id: 'takeoff', name: 'Takeoff', commandId: 22 },
  ],
}];

const COMMANDS_CATALOG = {
  commands: [
    { value: 400, name: 'MAV_CMD_COMPONENT_ARM_DISARM', description: 'Arm/disarm', params: [] },
    { value: 22, name: 'MAV_CMD_NAV_TAKEOFF', description: 'Takeoff', params: [] },
  ],
  enums: {},
  dialect: 'common',
};

/**
 * One dialog-capable editor context: the real shared resource plus the real
 * mavlink-command script, a per-selector element registry standing in for the
 * dialog DOM, and a queue of captured getJSON requests the test resolves.
 */
function makeHarness() {
  const requests = [];
  let registry = new Map();

  function dead() {
    const d = {};
    for (const k of ['append', 'attr', 'text', 'val', 'each', 'empty', 'on', 'find',
      'hide', 'show', 'css', 'prop', 'removeAttr', 'data']) d[k] = () => d;
    d.length = 0;
    return d;
  }

  /** A select-aware element: enough jQuery for the command dialog's wiring. */
  function makeEl(tag) {
    const el = {
      _tag: tag || '', _val: undefined, _text: '', _attrs: {}, _data: {},
      _select: false, _options: null, _children: [], _handlers: {},
    };
    const w = {
      _el: el,
      length: 1,
      val(v) {
        if (v === undefined) {
          if (!el._select) return el._val;
          // Real select semantics: a value with no matching option reads null.
          const opts = el._options || [];
          return opts.some((o) => o.v === String(el._val)) ? String(el._val) : null;
        }
        el._val = v;
        return w;
      },
      empty() {
        if (el._tag === '') { el._select = true; el._options = []; }
        return w;
      },
      append(child) {
        const c = child && child._el;
        if (el._tag === 'optgroup') {
          if (c) el._children.push(c);
          return w;
        }
        if (c && (c._tag === 'option' || c._tag === 'optgroup')) {
          el._select = true;
          if (!el._options) el._options = [];
          const added = c._tag === 'option' ? [c] : c._children;
          added.forEach((o) => el._options.push({ v: String(o._val), label: o._text }));
        }
        return w;
      },
      on(ev, fn) {
        const key = ev.split('.')[0];
        if (!el._handlers[key]) el._handlers[key] = [];
        el._handlers[key].push(fn);
        return w;
      },
      trigger(ev) {
        (el._handlers[ev] || []).slice().forEach((fn) => fn.call(w));
        return w;
      },
      find(sub) {
        const m = /^option\[value="(.*)"\]$/.exec(sub || '');
        if (m) return { length: (el._options || []).some((o) => o.v === m[1]) ? 1 : 0 };
        if (sub === 'option') {
          const items = (el._options || []).map((o) => ({
            val: () => o.v,
            attr(name, value) { if (value !== undefined) o[name] = value; return undefined; },
            removeAttr() { return this; },
          }));
          return { length: items.length, each(fn) { items.forEach((it, i) => fn.call(it, i, it)); return this; } };
        }
        return dead();
      },
      attr(name, value) {
        if (value === undefined) return el._attrs[name];
        el._attrs[name] = value;
        return w;
      },
      data(k, v) {
        if (v === undefined) return el._data[k];
        el._data[k] = v;
        return w;
      },
      text(t) {
        if (t === undefined) return el._text;
        el._text = t;
        return w;
      },
      hide: () => w, show: () => w, css: () => w, prop: () => w, toggle: () => w,
      is: () => false, each: () => w, off: () => w, removeAttr: () => w,
      replaceWith: () => w, next: () => ({ length: 0 }), closest: () => dead(),
    };
    return w;
  }

  function $(sel) {
    if (sel && typeof sel === 'object') return sel;
    if (typeof sel === 'string' && sel.charAt(0) === '<') {
      return makeEl(/^<(\w+)/.exec(sel)[1]);
    }
    if (!registry.has(sel)) registry.set(sel, makeEl(''));
    return registry.get(sel);
  }
  $.getJSON = function (url, a, b) {
    const req = { url, ok: typeof a === 'function' ? a : b, fail: null };
    requests.push(req);
    return { fail(fn) { req.fail = fn; return this; } };
  };
  $.ajax = () => ({ done() { return this; }, fail() { return this; } });

  const nodeLookup = {
    'conn-1': { vehicle: 'veh-1' },
    'veh-1': { dialect: 'common' },
  };
  const registered = {};
  const context = {
    RED: {
      settings: { httpAdminRoot: '/' },
      mavlink: {},
      validators: { number: () => () => true, regex: () => () => true },
      _: (k) => k,
      editor: { getEditStack: () => [] },
      nodes: {
        registerType(name, def) { registered[name] = def; },
        getType: (t) => (/^mavlink-/.test(t) ? function () {} : undefined),
        node: (id) => nodeLookup[id] || null,
      },
    },
    $,
    console,
    setTimeout,
  };
  context.window = context;
  vm.runInNewContext(resourceSrc, context);
  // Chrome-only helpers, stubbed at their contract boundary. The catalog
  // machinery under test (loadCatalog, resolveCatalogTarget, adminApiUrl,
  // populateDialectSelect, fillEnumSelect) stays real.
  Object.assign(context.RED.mavlink, {
    ensureConfigNodePicker() {},
    reloadTargetCompId() {},
    refreshIdentitySelect() {},
    applyBuildTierRowVisibility() {},
    applyCompanionTargetVisibility() {},
    bindSelectTitleSync() {},
    paramControl: () => $('<input></input>'),
    formRow: () => $('<div></div>'),
  });

  const start = html.indexOf('<script type="text/javascript">');
  const open = html.indexOf('>', start) + 1;
  vm.runInNewContext(html.slice(open, html.indexOf('</script>', open)), context);

  function seedSelect(sel, options, val) {
    const w = $(sel);
    w.empty();
    options.forEach((v) => w.append($('<option></option>').val(v)));
    if (val !== undefined) w.val(val);
  }

  /** Open the dialog for `node` over a fresh form, as the tray does. */
  function openDialog(node) {
    registry = new Map();
    seedSelect('#node-input-delivery', ['confirm', 'complete', 'send', 'build'], 'confirm');
    seedSelect('#node-input-connection', ['', 'conn-1'], 'conn-1');
    seedSelect('#node-input-mode', ['preset', 'advanced'], node.mode);
    seedSelect('#node-input-preset', []);
    seedSelect('#node-input-advancedCommand', []);
    seedSelect('#node-input-dialect', []);
    seedSelect('#node-input-identity', [''], '');
    seedSelect('#node-input-sendAs', ['int', 'long'], 'int');
    registered['mavlink-command'].oneditprepare.call(node);
  }

  const forUrl = (fragment) => requests.filter((r) => r.url.includes(fragment));

  return { $, openDialog, forUrl };
}

function commandNode(over) {
  return Object.assign({
    id: 'cmd-1', mode: 'preset', preset: '', advancedCommand: '',
    params: '{}', dialect: '', connection: 'conn-1', vehicle: '', identity: '',
  }, over);
}

test('a closed dialog\'s late preset response cannot reprogram the dialog now open', () => {
  const h = makeHarness();

  // Dialog A opens and closes before its preset list arrives.
  h.openDialog(commandNode({ preset: 'disarm' }));
  // Dialog B (another Command node) opens over a fresh form; its own preset
  // request is now the live one.
  h.openDialog(commandNode({ preset: 'takeoff' }));
  assert.equal(h.forUrl('/mavlink/command/presets').length, 2, 'each open requested the presets');

  // A's response lands after B opened. Without a fence, A's builder filled
  // B's select through the global selectors and selected A's saved preset —
  // Done would then save 'disarm' on the takeoff node.
  h.forUrl('/mavlink/command/presets')[0].ok({ groups: PRESET_GROUPS });
  assert.notEqual(h.$('#node-input-preset').val(), 'disarm',
    'the closed dialog\'s saved preset must not land in the open dialog');

  // B's own response still builds B's dropdown as ever.
  h.forUrl('/mavlink/command/presets')[1].ok({ groups: PRESET_GROUPS });
  const catalogRequests = h.forUrl('/mavlink/command/commands');
  catalogRequests[catalogRequests.length - 1].ok(COMMANDS_CATALOG);
  assert.equal(h.$('#node-input-preset').val(), 'takeoff', 'the live dialog keeps its own preset');
});

test('concurrent catalog fetches from different call sites do not cancel each other', () => {
  const h = makeHarness();

  // Advanced open starts the commands-catalog fetch for the MAV_CMD dropdown.
  h.openDialog(commandNode({ mode: 'advanced', advancedCommand: '400' }));

  // The (smaller) presets response lands while that fetch is in flight; its
  // builder starts its own catalog fetch for the preset option tips. On a
  // single shared request sequence that later fetch outdates the dropdown's
  // and loadCatalog's seq guard discards the callback that fills the MAV_CMD
  // list, leaving the dialog without a command list. Per-site sequences keep
  // both fetches live.
  h.forUrl('/mavlink/command/presets')[0].ok({ groups: PRESET_GROUPS });
  const catalogRequests = h.forUrl('/mavlink/command/commands');
  assert.equal(catalogRequests.length, 2,
    'the dropdown fill and the preset tips each fetch on their own sequence');
  catalogRequests.forEach((req) => req.ok(COMMANDS_CATALOG));

  const sel = h.$('#node-input-advancedCommand');
  assert.equal(sel.val(), '400', 'the saved MAV_CMD is selected from the filled dropdown');
});
