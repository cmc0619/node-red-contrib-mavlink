'use strict';

/**
 * Executed dialog-lifecycle tests for the Connection editor's serial-path
 * combo: the real editor script and the real shared resource run against a
 * stateful jQuery fake whose /mavlink/serial-ports responses the test
 * releases by hand (the command-html-async harness pattern). The pinned
 * behaviors: enumerated ports fill the dropdown, a saved path absent from
 * the enumeration keeps a '(saved value)' sentinel instead of snapping to
 * blank, picking a port writes it into the bound free-text input, and the
 * refresh button re-fetches.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'nodes', 'mavlink-connection.html'), 'utf8');
const resourceSrc = fs.readFileSync(path.join(root, 'resources', 'mavlink-editor.js'), 'utf8');

/**
 * One dialog-capable editor context: the real shared resource plus the real
 * mavlink-connection script, a per-selector element registry standing in for
 * the dialog DOM, and a queue of captured getJSON requests the test resolves.
 */
function makeHarness() {
  const requests = [];
  let registry = new Map();

  /** A select-aware element: enough jQuery for the connection dialog's wiring. */
  function makeEl(tag) {
    const el = {
      _tag: tag || '', _val: undefined, _text: '', _select: false, _options: null,
      _handlers: {},
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
        if (c && c._tag === 'option') {
          el._select = true;
          if (!el._options) el._options = [];
          el._options.push({ v: String(c._val), label: c._text });
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
            text: () => o.label,
          }));
          return { length: items.length, each(fn) { items.forEach((it, i) => fn.call(it, i, it)); return this; } };
        }
        return { length: 0 };
      },
      editableList() { return w; },
      text(t) {
        if (t === undefined) return el._text;
        el._text = t;
        return w;
      },
      toggle: () => w, hide: () => w, show: () => w, css: () => w, attr: () => w,
      prop: () => w, is: () => false, each: () => w, off: () => w,
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
  $.getJSON = function (url, ok) {
    const req = { url, ok, fail: null };
    requests.push(req);
    return { fail(fn) { req.fail = fn; return this; } };
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
        node: () => null,
      },
    },
    $,
    console,
    setTimeout,
  };
  context.window = context;
  vm.runInNewContext(resourceSrc, context);
  // Config-node pickers are chrome; stub at the contract boundary (same split
  // as the command async harness). adminApiUrl stays real — the request URL
  // is part of what is pinned here.
  Object.assign(context.RED.mavlink, { ensureConfigNodePicker() {} });

  const start = html.indexOf('<script type="text/javascript">');
  const open = html.indexOf('>', start) + 1;
  vm.runInNewContext(html.slice(open, html.indexOf('</script>', open)), context);

  /** Open the dialog for `node` over a fresh form, as the tray does. */
  function openDialog(node) {
    registry = new Map();
    // Node-RED populates the bound fields before oneditprepare runs.
    $('#node-config-input-mode').val(node.mode || 'udp');
    $('#node-config-input-serialPath').val(node.serialPath || '');
    registered['mavlink-connection'].oneditprepare.call(node);
  }

  const options = () => {
    const found = [];
    $('#mav-conn-serial-ports').find('option').each(function () {
      found.push({ value: this.val(), label: this.text() });
    });
    return found;
  };

  const forUrl = (fragment) => requests.filter((r) => r.url.includes(fragment));

  return { $, openDialog, options, forUrl, requests };
}

function connectionNode(over) {
  return Object.assign({
    id: 'c1', mode: 'serial', serialPath: '', additionalIdentities: [],
  }, over);
}

const PORTS = {
  ports: [
    { path: '/dev/ttyUSB0', manufacturer: 'FTDI' },
    { path: '/dev/ttyACM0' },
  ],
};

test('enumerated ports fill the dropdown; the saved path stays selected with its label', () => {
  const h = makeHarness();
  h.openDialog(connectionNode({ serialPath: '/dev/ttyUSB0' }));
  h.forUrl('/mavlink/serial-ports')[0].ok(PORTS);

  assert.deepEqual(
    h.options(),
    [
      { value: '', label: '\u2014' },
      { value: '/dev/ttyUSB0', label: '/dev/ttyUSB0 — FTDI' },
      { value: '/dev/ttyACM0', label: '/dev/ttyACM0' },
    ],
    'ports list with the manufacturer in the label when the host knows it'
  );
  assert.equal(h.$('#mav-conn-serial-ports').val(), '/dev/ttyUSB0');
  assert.equal(h.$('#node-config-input-serialPath').val(), '/dev/ttyUSB0',
    'the bound input is untouched by the fill');
});

test('a saved path absent from the enumeration keeps a (saved value) sentinel', () => {
  const h = makeHarness();
  h.openDialog(connectionNode({ serialPath: '/dev/serial/by-id/usb-vehicle' }));
  h.forUrl('/mavlink/serial-ports')[0].ok({ ports: [{ path: '/dev/ttyUSB0' }] });

  const sentinel = h.options().find((o) => o.value === '/dev/serial/by-id/usb-vehicle');
  assert.ok(sentinel, 'the saved-but-missing path must remain selectable');
  assert.equal(sentinel.label, '/dev/serial/by-id/usb-vehicle (saved value)');
  assert.equal(h.$('#mav-conn-serial-ports').val(), '/dev/serial/by-id/usb-vehicle',
    'and stays selected — opening the dialog must not silently re-point the link');
});

test('serialport not installed (empty list) leaves the free-text path alone', () => {
  const h = makeHarness();
  h.openDialog(connectionNode({ serialPath: '/dev/ttyS1' }));
  h.forUrl('/mavlink/serial-ports')[0].ok({ ports: [] });

  assert.deepEqual(h.options().map((o) => o.value), ['', '/dev/ttyS1'],
    'nothing enumerated: the saved free-text path survives as the sentinel');
  assert.equal(h.$('#node-config-input-serialPath').val(), '/dev/ttyS1');
});

test('a failed fetch still leaves the saved path visible', () => {
  const h = makeHarness();
  h.openDialog(connectionNode({ serialPath: 'COM3' }));
  h.forUrl('/mavlink/serial-ports')[0].fail();

  assert.deepEqual(h.options().map((o) => o.value), ['', 'COM3']);
  assert.equal(h.$('#node-config-input-serialPath').val(), 'COM3');
});

test('picking a detected port writes it into the bound input', () => {
  const h = makeHarness();
  h.openDialog(connectionNode({ serialPath: '/dev/ttyUSB0' }));
  h.forUrl('/mavlink/serial-ports')[0].ok(PORTS);

  h.$('#mav-conn-serial-ports').val('/dev/ttyACM0').trigger('change');
  assert.equal(h.$('#node-config-input-serialPath').val(), '/dev/ttyACM0',
    'the pick lands in the field Node-RED saves');

  // Picking the blank entry must not wipe a path the operator typed.
  h.$('#node-config-input-serialPath').val('/dev/ttyS9');
  h.$('#mav-conn-serial-ports').val('').trigger('change');
  assert.equal(h.$('#node-config-input-serialPath').val(), '/dev/ttyS9');
});

test('the refresh button re-fetches and refills the dropdown', () => {
  const h = makeHarness();
  h.openDialog(connectionNode({ serialPath: '/dev/ttyUSB0' }));
  h.forUrl('/mavlink/serial-ports')[0].ok(PORTS);
  assert.deepEqual(h.options().map((o) => o.value), ['', '/dev/ttyUSB0', '/dev/ttyACM0']);

  h.$('#mav-conn-serial-refresh').trigger('click');
  const reqs = h.forUrl('/mavlink/serial-ports');
  assert.equal(reqs.length, 2, 'refresh issues a new request');
  reqs[1].ok({ ports: [{ path: '/dev/ttyUSB0' }, { path: '/dev/ttyUSB1' }] });
  assert.deepEqual(h.options().map((o) => o.value), ['', '/dev/ttyUSB0', '/dev/ttyUSB1'],
    'a hot-plugged port appears without reopening the dialog');
  assert.equal(h.$('#mav-conn-serial-ports').val(), '/dev/ttyUSB0',
    'the current path stays selected across the refill');
});

test('the fetch honours httpAdminRoot (14.31)', () => {
  const h = makeHarness();
  h.openDialog(connectionNode());
  assert.equal(h.forUrl('/mavlink/serial-ports')[0].url, '/mavlink/serial-ports',
    'adminApiUrl joins the route under the admin root, never a bare path');
});
