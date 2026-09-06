'use strict';

/**
 * Executed dialog-lifecycle tests for the mavlink-payload editor's field-tips
 * fetch (mavlink-audit-20260905 #13, #14). Same shape as
 * test/nodes/command-html-async.test.js: the real editor script and shared
 * resource run against a stateful jQuery fake with a real element/child tree
 * (so `#payload-fields .mav-payload-field` actually resolves), and the test
 * releases network responses by hand because both findings are races that
 * only exist between a request/edit and a later response/render:
 *
 * 1. refreshFields() had no request-sequencing guard: a verb change fired
 *    while an earlier verb's field-tips fetch is still in flight let the
 *    stale response win the race and repaint fields for a selection the
 *    operator already left (#13).
 * 2. Dialect/vehicle/connection/delivery changes re-render the SAME verb's
 *    fields without going through reselect()/forgetValues(), so a value the
 *    operator just typed was silently reverted to the dialog-open stash the
 *    moment one of those controls changed (#14).
 *
 * Scaffolding helpers that only touch chrome (config pickers, row
 * visibility, CompID reloads, identity select, dialect population) are
 * stubbed at their contract boundary; refreshFields, renderFields,
 * collectValues, fieldInput and the stash/syncStash wiring under test run
 * for real.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'nodes', 'mavlink-payload.html'), 'utf8');
const resourceSrc = fs.readFileSync(path.join(root, 'resources', 'mavlink-editor.js'), 'utf8');

function makeElData(tag) {
  return { tag: tag || '', attrs: {}, classes: new Set(), _val: undefined, _text: '', children: [], handlers: {} };
}

function wrap(el) {
  const wrapper = {
    _el: el,
    length: 1,
    attr(name, value) {
      if (value === undefined) return el.attrs[name];
      el.attrs[name] = value;
      return wrapper;
    },
    addClass(c) { el.classes.add(c); return wrapper; },
    val(v) {
      if (v === undefined) return el._val;
      el._val = v;
      return wrapper;
    },
    text(t) {
      if (t === undefined) return el._text;
      el._text = t;
      return wrapper;
    },
    append(child) {
      const data = child && (child._el || child);
      if (data && typeof data === 'object') el.children.push(data);
      return wrapper;
    },
    empty() { el.children = []; return wrapper; },
    toggle() { return wrapper; },
    show: () => wrapper, hide: () => wrapper, css: () => wrapper, prop: () => wrapper, removeAttr: () => wrapper,
    is: () => false,
    on(ev, fn) {
      const key = ev.split('.')[0];
      (el.handlers[key] = el.handlers[key] || []).push(fn);
      return wrapper;
    },
    trigger(ev) {
      (el.handlers[ev] || []).slice().forEach((fn) => fn.call(el));
      return wrapper;
    },
    each() { return wrapper; },
    find() { return { length: 0, each() { return this; } }; },
  };
  return wrapper;
}

function makeHarness() {
  const requests = [];
  let registry = new Map();

  function $(sel) {
    if (sel && typeof sel === 'object') {
      return sel._el ? sel : wrap(sel);
    }
    if (typeof sel === 'string' && sel.charAt(0) === '<') {
      return wrap(makeElData(/^<(\w+)/.exec(sel)[1]));
    }
    const compound = /^#([\w-]+)\s+\.([\w-]+)$/.exec(sel);
    if (compound) {
      const root2 = registry.get(`#${compound[1]}`);
      const cls = compound[2];
      const matches = [];
      (function walk(node) {
        (node.children || []).forEach((c) => {
          if (c.classes?.has(cls)) matches.push(c);
          walk(c);
        });
      })(root2 || makeElData(''));
      return {
        length: matches.length,
        each(fn) { matches.forEach((el, i) => fn.call(el, i, el)); return this; },
      };
    }
    if (!registry.has(sel)) registry.set(sel, makeElData(''));
    return wrap(registry.get(sel));
  }
  $.getJSON = function (url, a, b) {
    const req = { url, ok: typeof a === 'function' ? a : b, fail: null };
    requests.push(req);
    return { fail(fn) { req.fail = fn; return this; } };
  };
  $.ajax = () => ({ done() { return this; }, fail() { return this; } });

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
        node: () => null,
      },
    },
    $,
    console,
    setTimeout,
  };
  context.window = context;
  vm.runInNewContext(resourceSrc, context);
  Object.assign(context.RED.mavlink, {
    ensureConfigNodePicker() {},
    refreshIdentitySelect() {},
    reloadTargetCompId() {},
    applyCompanionTargetVisibility() {},
    applyBuildTierRowVisibility() {},
    hasIdentityChoice: () => false,
    populateDialectSelect() {},
    currentCatalogQuery: () => ({ dialect: 'common' }),
  });

  const start = html.indexOf('<script type="text/javascript">');
  const open = html.indexOf('>', start) + 1;
  vm.runInNewContext(html.slice(open, html.indexOf('</script>', open)), context);

  function openDialog(node) {
    registry = new Map();
    registered['mavlink-payload'].oneditprepare.call(node);
  }

  /** The rendered field element for `key`, or null if not mounted. */
  function field(key) {
    let found = null;
    (function walk(node) {
      (node.children || []).forEach((c) => {
        if (c.attrs['data-field'] === key) found = c;
        walk(c);
      });
    })(registry.get('#payload-fields') || makeElData(''));
    return found && wrap(found);
  }

  /** Rendered field keys, in DOM order. */
  function fieldKeys() {
    const keys = [];
    (function walk(node) {
      (node.children || []).forEach((c) => {
        if (c.classes?.has('mav-payload-field')) keys.push(c.attrs['data-field']);
        walk(c);
      });
    })(registry.get('#payload-fields') || makeElData(''));
    return keys;
  }

  const forUrl = (fragment) => requests.filter((r) => r.url.includes(fragment));

  /** Press Done: run oneditsave against `node` and return what it saved. */
  function save(node) {
    registered['mavlink-payload'].oneditsave.call(node);
    return node.values;
  }

  return { $, openDialog, forUrl, field, fieldKeys, requests, save };
}

function payloadNode(over) {
  return {
    id: 'pl-1', topic: 'camera', verb: 'photo', path: 'legacy', delivery: 'build',
    dialect: '', vehicle: '', connection: '', identity: '', sendAs: 'int', frame: '3',
    values: {}, ...over,
  };
}

function fieldTips(fields) {
  return { fields, enums: {}, carrierMatters: false };
}

test('a stale field-tips response from a verb the operator already left does not repaint the fields (mavlink-audit-20260905 #13)', () => {
  const harness = makeHarness();
  harness.openDialog(payloadNode());

  // First load, for 'photo'.
  harness.$('#node-input-dialect').trigger('change');
  const first = harness.forUrl('/mavlink/payload/field-tips')[0];
  assert.ok(first, 'dialect change loads the field tips');

  // Operator moves to 'zoom' before the photo response lands.
  harness.$('#node-input-verb').val('zoom');
  harness.$('#node-input-verb').trigger('change');
  const second = harness.forUrl('/mavlink/payload/field-tips')[1];
  assert.ok(second, 'verb change starts its own field-tips fetch');

  // zoom's (later, correct) response lands first...
  second.ok(fieldTips({ zoomLevel: { default: 0 } }));
  assert.deepEqual(harness.fieldKeys(), ['zoomLevel']);

  // ...then photo's (earlier, now-stale) response arrives late.
  first.ok(fieldTips({ speed: { default: 0 } }));
  assert.deepEqual(harness.fieldKeys(), ['zoomLevel'],
    'a response for an abandoned verb selection must not repaint the fields');
});

test('field-tips responses that resolve in request order still render normally', () => {
  const harness = makeHarness();
  harness.openDialog(payloadNode());

  harness.$('#node-input-dialect').trigger('change');
  harness.forUrl('/mavlink/payload/field-tips')[0].ok(fieldTips({ speed: { default: 0 } }));
  assert.deepEqual(harness.fieldKeys(), ['speed']);

  harness.$('#node-input-verb').val('zoom');
  harness.$('#node-input-verb').trigger('change');
  harness.forUrl('/mavlink/payload/field-tips')[1].ok(fieldTips({ zoomLevel: { default: 0 } }));
  assert.deepEqual(harness.fieldKeys(), ['zoomLevel']);
});

test('a value typed into a field survives an unrelated Vehicle Profile change on the same verb (mavlink-audit-20260905 #14)', () => {
  const harness = makeHarness();
  harness.openDialog(payloadNode());

  harness.$('#node-input-dialect').trigger('change');
  harness.forUrl('/mavlink/payload/field-tips')[0].ok(fieldTips({ speed: { default: 0 } }));
  assert.equal(harness.field('speed').val(), 0);

  // The operator types into the rendered control.
  harness.field('speed').val(42);

  // An unrelated control changes; it re-renders the same verb's fields
  // (dialect unchanged, so the field-tips response looks the same).
  harness.$('#node-input-vehicle').trigger('change');
  const reload = harness.forUrl('/mavlink/payload/field-tips')[1];
  assert.ok(reload, 'vehicle change reloads field tips');
  reload.ok(fieldTips({ speed: { default: 0 } }));

  assert.equal(harness.field('speed').val(), 42,
    'the typed value must not be reverted to the dialog-open stash');
});

test('a value typed into a field survives an unrelated Dialect change on the same verb (mavlink-audit-20260905 #14)', () => {
  const harness = makeHarness();
  harness.openDialog(payloadNode());

  harness.$('#node-input-dialect').trigger('change');
  harness.forUrl('/mavlink/payload/field-tips')[0].ok(fieldTips({ speed: { default: 0 } }));

  harness.field('speed').val(7);
  harness.$('#node-input-dialect').trigger('change');
  harness.forUrl('/mavlink/payload/field-tips')[1].ok(fieldTips({ speed: { default: 0 } }));

  assert.equal(harness.field('speed').val(), 7,
    'the typed value must not be reverted to the dialog-open stash');
});

test('a closed dialog\'s late field-tips response cannot paint fields into the dialog now open (mavlink-audit-20260905 #13)', () => {
  const harness = makeHarness();

  // Dialog A opens and requests its fields, then closes before they arrive.
  harness.openDialog(payloadNode({ id: 'pl-A' }));
  harness.$('#node-input-dialect').trigger('change');
  const fromA = harness.forUrl('/mavlink/payload/field-tips')[0];

  // Dialog B (another Payload node) opens over a fresh form and requests its own.
  harness.openDialog(payloadNode({ id: 'pl-B', verb: 'zoom' }));
  harness.$('#node-input-dialect').trigger('change');
  const fromB = harness.forUrl('/mavlink/payload/field-tips')[1];

  // A's response lands after B opened. A per-dialog sequence cannot see B's
  // open, so A's callback would render through the shared #payload-fields
  // selector — into B's form.
  fromA.ok(fieldTips({ speed: { default: 0 } }));
  assert.deepEqual(harness.fieldKeys(), [], 'the closed dialog\'s fields must not land in the open one');

  fromB.ok(fieldTips({ zoomLevel: { default: 0 } }));
  assert.deepEqual(harness.fieldKeys(), ['zoomLevel'], 'the open dialog still gets its own');
});

test('Done pressed while a new recipe\'s metadata is in flight does not save the old recipe\'s controls (mavlink-audit-20260905 #13)', () => {
  const harness = makeHarness();
  const node = payloadNode();
  harness.openDialog(node);

  harness.$('#node-input-dialect').trigger('change');
  harness.forUrl('/mavlink/payload/field-tips')[0].ok(fieldTips({ speed: { default: 0 } }));
  harness.field('speed').val(42);

  // Recipe changes; zoom's metadata is requested but has not arrived.
  harness.$('#node-input-verb').val('zoom');
  harness.$('#node-input-verb').trigger('change');
  assert.equal(harness.forUrl('/mavlink/payload/field-tips').length, 2, 'the new recipe was requested');

  // Done now. The photo controls must already be gone: `mode` / `action` are
  // shared keys whose enums differ per device, so a scrape of the previous
  // recipe's controls under the new verb is a wrong value, not a stale one.
  const saved = harness.save(node);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'speed'), false,
    'the previous recipe\'s control must not be saved under the new verb');
});
