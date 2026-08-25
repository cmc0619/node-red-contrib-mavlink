'use strict';

/**
 * Executed dialog-lifecycle tests for the mavlink-command editor's async
 * loads (CodeRabbit #371 round 2). The other command-html tests pin source;
 * these run the real editor script — oneditprepare and the shared
 * RED.mavlink.loadCatalog — against a stateful jQuery fake whose network
 * responses the test releases by hand, because both findings are races that
 * only exist between a request and its response:
 *
 * 1. loadPresets carried no staleness fence, so a response requested by a
 *    closed dialog A rebuilt the preset select of the dialog B now open —
 *    through the live global selectors, with A's saved preset — and B would
 *    save A's preset.
 * 2. Two cold loadCommandsCatalog calls each started a fetch, and the second
 *    (loadCatalog's seq guard) discarded the first caller's callback. On an
 *    Advanced-mode open the discarded callback is the one that fills the
 *    MAV_CMD dropdown, so the dialog came up with an empty command list
 *    whenever the (smaller, faster) presets response landed mid-flight.
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
function makeHarness(vehicleProfile) {
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
    'veh-1': Object.assign({ dialect: 'common' }, vehicleProfile),
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
  // The two param-render boundaries record what they were handed: the seed a
  // control was built with is the whole subject of the slot-collision tests.
  const rendered = { params: [], rows: [] };
  Object.assign(context.RED.mavlink, {
    ensureConfigNodePicker() {},
    reloadTargetCompId() {},
    refreshIdentitySelect() {},
    applyBuildTierRowVisibility() {},
    applyCompanionTargetVisibility() {},
    bindSelectTitleSync() {},
    paramControl: (spec, enums, opts) => {
      rendered.params.push({ index: Number(opts.attrValue), saved: opts.saved });
      return $('<input></input>');
    },
    formRow: (label, control) => {
      rendered.rows.push({ label, control });
      return $('<div></div>');
    },
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
  /** Drain the controls rendered since the last take — one entry per field. */
  const takeParams = () => rendered.params.splice(0, rendered.params.length);
  const takeRows = () => rendered.rows.splice(0, rendered.rows.length);

  return { $, openDialog, forUrl, takeParams, takeRows };
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

test('an Advanced open shares one in-flight catalog fetch — the MAV_CMD dropdown fills', () => {
  const h = makeHarness();

  // Advanced open starts the commands-catalog fetch for the MAV_CMD dropdown.
  h.openDialog(commandNode({ mode: 'advanced', advancedCommand: '400' }));

  // The (smaller) presets response lands while that fetch is in flight; its
  // builder also wants the catalog. Starting a second fetch here made
  // loadCatalog's seq guard discard the first — and with it the callback
  // that fills the MAV_CMD dropdown, leaving the dialog without a command
  // list. A pending caller must join the in-flight fetch instead.
  h.forUrl('/mavlink/command/presets')[0].ok({ groups: PRESET_GROUPS });
  h.forUrl('/mavlink/command/commands').forEach((req) => req.ok(COMMANDS_CATALOG));

  const sel = h.$('#node-input-advancedCommand');
  assert.equal(sel.val(), '400', 'the saved MAV_CMD is selected from the filled dropdown');
  assert.equal(h.forUrl('/mavlink/command/commands').length, 1,
    'concurrent cold callers share one fetch');
});

/**
 * Slot collision: the saved `params` blob is keyed by slot number, and a slot
 * number means whatever the selected command says it means — param 5 is a
 * latitude on Set Home and something else entirely on the next command. The
 * dialog therefore seeds a form from the blob only while it is painting the
 * command it was opened on; once the operator picks another command (or the
 * other mode) the seeds are dropped and every later render starts empty,
 * including a render of the command that was saved.
 */
const SLOT_PRESETS = [{
  group: 'flight',
  presets: [
    { id: 'takeoff', name: 'Takeoff', commandId: 22 },
    { id: 'set_home', name: 'Set Home', commandId: 179 },
    { id: 'set_mode', name: 'Set Mode', commandId: 176 },
  ],
}];

const SLOT_CATALOG = {
  commands: [
    { value: 22, name: 'MAV_CMD_NAV_TAKEOFF', params: [
      { index: 1, label: 'Pitch' },
      { index: 7, label: 'Altitude' },
    ] },
    { value: 179, name: 'MAV_CMD_DO_SET_HOME', params: [
      { index: 1, label: 'Use Current' },
      { index: 5, label: 'Latitude' },
      { index: 6, label: 'Longitude' },
      { index: 7, label: 'Altitude' },
    ] },
    { value: 176, name: 'MAV_CMD_DO_SET_MODE', params: [
      { index: 1, label: 'Mode' },
      { index: 2, label: 'Custom Mode' },
    ] },
  ],
  enums: {},
  dialect: 'common',
};

/** Open, then release both catalogs, leaving the saved command painted. */
function openWithCatalogs(h, node) {
  h.openDialog(node);
  h.forUrl('/mavlink/command/presets').forEach((req) => req.ok({ groups: SLOT_PRESETS }));
  h.forUrl('/mavlink/command/commands').forEach((req) => req.ok(SLOT_CATALOG));
}

const seeds = (fields) => fields.map((f) => f.saved);
/**
 * The fields left on screen. `refreshParamFields` repaints the whole form, and
 * an Advanced repaint runs twice — `buildAdvancedDropdown`'s fill re-fires
 * `change` (which renders) and `refreshAdvancedCommands` renders again behind
 * it — so the last `count` controls are the ones the operator is looking at.
 */
const onScreen = (fields, count) => fields.slice(-count);

test('preset params seed the command they were saved under', () => {
  const h = makeHarness();
  openWithCatalogs(h, commandNode({ preset: 'takeoff', params: '{"1":15,"7":30}' }));

  assert.deepEqual(h.takeParams(), [{ index: 1, saved: 15 }, { index: 7, saved: 30 }],
    'the saved blob fills the form of the preset the node was saved with');
});

test('switching preset renders empty fields, and switching back leaves them empty', () => {
  const h = makeHarness();
  openWithCatalogs(h, commandNode({ preset: 'takeoff', params: '{"1":15,"7":30}' }));
  h.takeParams();

  // Set Home exposes param 5/6 as a coordinate; Takeoff's 15 and 30 were a
  // pitch and an altitude. Carrying them over is how a lat/lon appears that
  // the operator never typed.
  h.$('#node-input-preset').val('set_home').trigger('change');
  const setHome = h.takeParams();
  assert.deepEqual(setHome.map((f) => f.index), [1, 5, 6, 7], 'Set Home rendered its own slots');
  assert.deepEqual(seeds(setHome), [undefined, undefined, undefined, undefined],
    'no slot carries a value typed under Takeoff');

  h.$('#node-input-preset').val('takeoff').trigger('change');
  assert.deepEqual(h.takeParams(), [{ index: 1, saved: undefined }, { index: 7, saved: undefined }],
    'the values are gone for good once the command changed — coming back does not restore them');
});

test('switching mode drops the seeds too — the same slots, a different command', () => {
  const h = makeHarness();
  openWithCatalogs(h, commandNode({
    mode: 'preset', preset: 'takeoff', advancedCommand: '179', params: '{"1":15,"7":30}',
  }));
  h.takeParams();

  h.$('#node-input-mode').val('advanced').trigger('change');
  assert.deepEqual(seeds(onScreen(h.takeParams(), 4)), [undefined, undefined, undefined, undefined],
    'the Advanced form for another MAV_CMD starts empty');
});

test('an Advanced open seeds its saved MAV_CMD, and a different one starts empty', () => {
  const h = makeHarness();
  h.openDialog(commandNode({
    mode: 'advanced', advancedCommand: '22', params: '{"1":15,"7":30}',
  }));
  h.forUrl('/mavlink/command/commands').forEach((req) => req.ok(SLOT_CATALOG));
  assert.deepEqual(onScreen(h.takeParams(), 2), [{ index: 1, saved: 15 }, { index: 7, saved: 30 }],
    'the dropdown fill is the dialog painting its own config, not a command change');

  // The preset list lands late and its builder fires a change at the preset
  // select. That is the dialog painting too — it must not wipe the seeds.
  h.forUrl('/mavlink/command/presets').forEach((req) => req.ok({ groups: SLOT_PRESETS }));
  assert.deepEqual(onScreen(h.takeParams(), 2), [{ index: 1, saved: 15 }, { index: 7, saved: 30 }],
    'a late preset response re-renders the same command with its values intact');

  h.$('#node-input-advancedCommand').val('179').trigger('change');
  assert.deepEqual(seeds(onScreen(h.takeParams(), 4)), [undefined, undefined, undefined, undefined],
    'the newly picked MAV_CMD renders empty slots');

  h.$('#node-input-advancedCommand').val('22').trigger('change');
  assert.deepEqual(seeds(onScreen(h.takeParams(), 2)), [undefined, undefined],
    'and the original command stays empty');
});

test('the PX4 DO_SET_MODE pair follows the same rule', () => {
  const HOLD = 4 * 65536 + 3 * 16777216; // main 4, sub 3 — the packed option value
  const px4Select = (rows) => rows
    .map((r) => r.control)
    .find((c) => c.attr && c.attr('data-kind') === 'px4mode');

  const h = makeHarness({ firmware: 'px4' });
  openWithCatalogs(h, commandNode({ preset: 'set_mode', params: '{"1":1,"2":4,"3":3}' }));

  assert.equal(px4Select(h.takeRows()).val(), String(HOLD),
    'the saved main/sub pair recomposes into the mode dropdown');

  h.$('#node-input-preset').val('takeoff').trigger('change');
  h.takeRows();
  h.$('#node-input-preset').val('set_mode').trigger('change');
  assert.equal(px4Select(h.takeRows()).val(), null,
    'param 2 and 3 are dropped with every other slot — the pair is not recomposed');
});
