'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const vehicleHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-vehicle.html'),
  'utf8'
);
const paramHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-param.html'),
  'utf8'
);

const { installEditorHelpers } = require('../helpers/editor-resource');

/** `change.mavEnumTip` fires on `change`… */
function baseEvent(event) {
  return String(event).split('.')[0];
}

/** …but unbinds only alongside its own namespace. */
function eventNamespace(event) {
  return String(event).split('.').slice(1).join('.');
}

/** The slice of a jQuery result set the shared enum helpers actually use. */
function matchSet(list) {
  return {
    length: list.length,
    attr: (name) => (list[0] ? list[0].attr(name) : undefined),
  };
}

/**
 * The jQuery-ish scaffolding every harness in this file needs: one element per
 * selector, a fresh element for any tag string, and a `$.getJSON` that records
 * requests instead of issuing them.
 *
 * Four copies of this existed. They had already drifted — one still tested for
 * the literal `'<option></option>'` where the others test `charAt(0) === '<'`,
 * which is the same tag-detection bug this PR fixed once in the production
 * path. One copy is one place for that to be right.
 *
 * @param {object} values  seed values keyed by selector
 * @returns {{element: Function, $: Function, requests: object[]}}
 */
function makeDom(values = {}) {
  const elements = new Map();
  const requests = [];

  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, new FakeElement(values[selector] || ''));
    }
    return elements.get(selector);
  }

  function $(selector) {
    // Any tag string builds a fresh element: the results panel renders its own
    // rows, and a shared stub would make every row the same node.
    if (String(selector).charAt(0) === '<') return new FakeElement();
    return element(selector);
  }

  $.getJSON = (url, query, success) => {
    const request = new FakeDeferred({ url, query });
    request.doneHandler = success;
    requests.push(request);
    return request;
  };

  return { element, $, requests };
}

class FakeElement {
  constructor(value = '') {
    // A found element, as in the real dialog: helpers branch on `.length` to
    // tell an absent field from an empty one.
    this.length = 1;
    this.value = value;
    this.label = '';
    this.attrs = {};
    // `handlers[event]` dispatches every binding for that event; `bound`
    // is the per-namespace registry behind it.
    this.handlers = {};
    this.bound = {};
    this.options = [];
    this.visible = true;
    this.disabled = false;
  }

  val(value) {
    if (value === undefined) return this.value;
    this.value = String(value);
    return this;
  }

  text(value) {
    if (value === undefined) return this.label;
    this.label = String(value);
    return this;
  }

  attr(name, value) {
    if (value === undefined) return this.attrs[name];
    if (value === null) delete this.attrs[name];
    else this.attrs[name] = String(value);
    return this;
  }

  removeAttr(name) {
    delete this.attrs[name];
    return this;
  }

  prop(name, value) {
    if (value === undefined) return this[name];
    this[name] = value;
    return this;
  }

  empty() {
    this.options = [];
    return this;
  }

  append(option) {
    this.options.push(option);
    return this;
  }

  on(events, handler) {
    for (const spec of String(events).split(/\s+/)) {
      const base = baseEvent(spec);
      if (!this.bound[base]) this.bound[base] = [];
      this.bound[base].push({ ns: eventNamespace(spec), handler });
      this.rebind(base);
    }
    return this;
  }

  off(events) {
    for (const spec of String(events).split(/\s+/)) {
      const base = baseEvent(spec);
      if (!this.bound[base]) continue;
      const ns = eventNamespace(spec);
      // jQuery semantics, and the reason they matter here: `off('change.ns')`
      // unbinds only that namespace. Collapsing it to `off('change')` would let
      // a helper's own tip-sync silently unbind the dialog's change handler,
      // and the harness would stop seeing what a fill does to the value box.
      this.bound[base] = ns ? this.bound[base].filter((b) => b.ns !== ns) : [];
      this.rebind(base);
    }
    return this;
  }

  rebind(base) {
    if (!this.bound[base] || !this.bound[base].length) {
      delete this.handlers[base];
      return;
    }
    this.handlers[base] = (event) => {
      for (const b of (this.bound[base] || []).slice()) {
        b.handler.call(this, event || { preventDefault() {} });
      }
    };
  }

  trigger(event) {
    const handler = this.handlers[baseEvent(event)];
    if (handler) handler({ preventDefault() {} });
    return this;
  }

  /**
   * Enough of a selector engine for the shared enum helpers: they ask for an
   * option by value (`ensureSavedEnumOption`) and for the selected one
   * (`bindSelectTitleSync`). A miss returns an empty set, as jQuery does.
   */
  find(selector) {
    const byValue = /^option\[value="(.*)"\]$/.exec(String(selector));
    if (byValue) return matchSet(this.options.filter((o) => o.val() === byValue[1]));
    if (String(selector) === 'option:selected') {
      return matchSet(this.options.filter((o) => o.val() === this.value));
    }
    return matchSet([]);
  }

  userClick() {
    if (this.disabled || !this.handlers.click) return;
    this.handlers.click.call(this, { preventDefault() {} });
  }

  toggle(visible) {
    this.visible = !!visible;
    return this;
  }

  show() {
    this.visible = true;
    return this;
  }

  hide() {
    this.visible = false;
    return this;
  }
}

class FakeDeferred {
  constructor(options) {
    this.options = options;
    this.doneHandler = null;
    this.failHandler = null;
    this.alwaysHandler = null;
  }

  done(handler) {
    this.doneHandler = handler;
    return this;
  }

  fail(handler) {
    this.failHandler = handler;
    return this;
  }

  always(handler) {
    this.alwaysHandler = handler;
    return this;
  }

  resolve(data) {
    if (this.doneHandler) this.doneHandler(data);
    if (this.alwaysHandler) this.alwaysHandler();
  }

  reject(xhr) {
    if (this.failHandler) this.failHandler(xhr);
    if (this.alwaysHandler) this.alwaysHandler();
  }
}

test('Vehicle parameter Update is single-flight and restores both result states', () => {
  const start = vehicleHtml.indexOf("$('#mav-param-defs-update').on('click'");
  const end = vehicleHtml.indexOf('        loadLibrary(function ()', start);
  assert.ok(start >= 0 && end > start, 'Vehicle parameter Update handler is present');

  const button = new FakeElement();
  const status = new FakeElement();
  const urlInput = new FakeElement('https://example.test/apm.pdef.json');
  const requests = [];
  function $(selector) {
    if (selector instanceof FakeElement) return selector;
    if (selector === '#mav-param-defs-update') return button;
    if (selector === '#node-config-input-paramDefsUrl') return urlInput;
    throw new Error(`Unexpected selector in Vehicle Update harness: ${selector}`);
  }
  $.ajax = (options) => {
    const request = new FakeDeferred(options);
    requests.push(request);
    return request;
  };

  vm.runInNewContext(vehicleHtml.slice(start, end), {
    $,
    $paramDefsStatus: status,
    mavlinkAdminUrl: (value) => value,
    node: { id: 'profile-1' },
  });

  button.userClick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(button.disabled, true);
  assert.equal(status.label, 'Downloading parameter definitions...');

  button.userClick();
  assert.equal(requests.length, 1, 'a second human click is blocked while pending');

  requests[0].resolve({ count: 3 });
  assert.equal(button.disabled, false);
  assert.equal(status.label, 'Updated 3 parameter definitions.');

  button.userClick();
  assert.equal(requests.length, 2, 'the button starts another request after completion');
  requests[1].reject({ responseJSON: { error: 'download denied' } });
  assert.equal(button.disabled, false);
  assert.equal(status.label, 'Update failed: download denied');
});

test('Param definition GET failures clear stale UI and render server and fallback errors', () => {
  const start = paramHtml.indexOf('var _paramDefs = {};');
  const end = paramHtml.indexOf('/* Reload defs when tier-influencing fields change. */', start);
  assert.ok(start >= 0 && end > start, 'Param definition loader is present');

  const values = {
    '#node-input-delivery': 'build',
    '#node-input-dialect': '__vehicle',
    '#node-input-vehicle': 'profile-1',
    '#node-input-firmware': 'ardupilot',
    '#node-input-paramId': 'MAV17_RAW_SENS',
    '#node-input-action': 'read',
  };
  const { element, $, requests } = makeDom(values);

  const context = {
    $,
    node: {},
    // Script-scope in the real file, outside the sliced region.
    _paramDefsByKey: {},
    paramDefsKey: () => 'test-key',
    RED: {
      mavlink: {},
      nodes: {
        node(id) {
          return id === 'profile-1' ? { dialect: 'ardupilotmega' } : null;
        },
      },
    },
  };
  installEditorHelpers(context);
  // The real one walks the DOM with .closest()/.after(); field meta is not
  // what this harness exercises.
  context.RED.mavlink.applyFieldMeta = () => {};
  vm.runInNewContext(
    `${paramHtml.slice(start, end)}\nthis.loadParamDefsForTest = loadParamDefs;`,
    context
  );

  context.loadParamDefsForTest();
  requests[0].resolve({
    defs: {
      MAV17_RAW_SENS: { description: 'Previously loaded definition.', unit: 'Hz' },
    },
    notice: 'stale notice',
  });
  // The panel stays closed until the operator types or focuses; what a
  // successful load must produce here is the hover text — description, unit
  // and range ride on `title`, not on a row that stays in the dialog.
  assert.equal(element('#mav-param-results').visible, false);
  assert.equal(
    element('#node-input-paramId').attrs.title,
    'Previously loaded definition. | Unit: Hz'
  );

  context.loadParamDefsForTest();
  requests[1].reject({ responseJSON: { error: 'holding file is corrupt' } });

  assert.equal(element('#mav-param-results').options.length, 0, 'stale hits are cleared');
  assert.equal(element('#mav-param-results').visible, false);
  assert.equal(element('#node-input-paramId').attrs.title, undefined);
  assert.equal(element('#row-param-defs-tip').visible, true);
  assert.equal(element('#mav-param-defs-tip-text').label, 'holding file is corrupt');

  context.loadParamDefsForTest();
  requests[2].reject({});
  assert.equal(
    element('#mav-param-defs-tip-text').label,
    'Parameter definitions unavailable.'
  );
});

/**
 * The four ways loadParamDefs can decline to ask the server. Each used to be a
 * bare `return`, which left `_defsLoaded` false — and the notice row renders
 * only when `_defsLoaded` is true. So the states most likely to be hit (no
 * Connection yet, or a Connection without a Vehicle Profile) were exactly the
 * ones that produced no datalist, no tooltip, and no explanation: an operator
 * typed a real param id and nothing happened.
 */
test('Param definition loader explains every path on which it does not ask', () => {
  const start = paramHtml.indexOf('var _paramDefs = {};');
  const end = paramHtml.indexOf('/* Reload defs when tier-influencing fields change. */', start);
  assert.ok(start >= 0 && end > start, 'Param definition loader is present');

  function run(values, nodesById) {
    const { element, $, requests } = makeDom(values);
    const context = {
      $,
      node: {},
      // Script-scope in the real file, outside the sliced region.
      _paramDefsByKey: {},
      paramDefsKey: () => 'test-key',
      RED: {
        mavlink: {},
        nodes: { node: (id) => (nodesById || {})[id] || null },
      },
    };
    installEditorHelpers(context);
    context.RED.mavlink.applyFieldMeta = () => {};
    vm.runInNewContext(
      `${paramHtml.slice(start, end)}\nthis.loadParamDefsForTest = loadParamDefs;`,
      context
    );
    context.loadParamDefsForTest();
    return { element, requests };
  }

  const cases = [
    ['no Connection on a wire tier', { '#node-input-delivery': 'send' }, null, /Connection/i],
    [
      'Connection without a Vehicle Profile',
      { '#node-input-delivery': 'send', '#node-input-connection': 'conn-1' },
      { 'conn-1': {} },
      /Vehicle Profile/i,
    ],
    ['no dialect on the Build tier', { '#node-input-delivery': 'build' }, null, /dialect/i],
    [
      'no firmware behind an explicit dialect',
      { '#node-input-delivery': 'build', '#node-input-dialect': 'ardupilotmega' },
      null,
      /firmware/i,
    ],
  ];

  for (const [label, values, nodesById, expected] of cases) {
    const { element, requests } = run(values, nodesById);
    assert.equal(requests.length, 0, `${label}: must not reach the server`);
    assert.equal(element('#row-param-defs-tip').visible, true, `${label}: notice row is shown`);
    assert.match(element('#mav-param-defs-tip-text').label, expected, `${label}: says why`);
    assert.equal(element('#node-input-paramId').attrs.list, undefined, `${label}: no stale datalist`);
  }
});

/**
 * The results panel. A datalist could only match the *start of the name*, so
 * finding a parameter meant already knowing what it was called — the exact
 * problem a seeded 6827-entry list makes worse, not better.
 */
function mountParamPanel(defs, initialValue) {
  const start = paramHtml.indexOf('var _paramDefs = {};');
  const end = paramHtml.indexOf('/* Reload defs when tier-influencing fields change. */', start);
  assert.ok(start >= 0 && end > start, 'Param definition loader is present');

  const values = {
    '#node-input-delivery': 'build',
    '#node-input-dialect': '__vehicle',
    '#node-input-vehicle': 'profile-1',
    '#node-input-paramId': initialValue || '',
    '#node-input-action': 'read',
  };
  const { element, $, requests } = makeDom(values);

  const context = {
    $,
    node: {},
    // Script-scope in the real file, outside the sliced region.
    _paramDefsByKey: {},
    paramDefsKey: () => 'test-key',
    RED: {
      mavlink: {},
      nodes: { node: (id) => (id === 'profile-1' ? { dialect: 'ardupilotmega' } : null) },
    },
  };
  installEditorHelpers(context);
  context.RED.mavlink.applyFieldMeta = () => {};
  vm.runInNewContext(
    `${paramHtml.slice(start, end)}
     this.loadParamDefsForTest = loadParamDefs;
     this.renderForTest = renderParamResults;
     this.moveForTest = moveParamSelection;
     this.hitsForTest = function () { return _hits.slice(); };
     this.hitIndexForTest = function () { return _hitIndex; };`,
    context
  );
  context.loadParamDefsForTest();
  requests[0].resolve({ defs });

  /** Ids currently rendered, read off the panel's own rows. */
  const rendered = () => element('#mav-param-results').options
    .map((row) => row.attrs['data-param-id']);

  return { context, element, rendered };
}

const PANEL_DEFS = {
  RC1_MIN: { description: 'Minimum value for RC channel 1', unit: 'us' },
  RC1_MAX: { description: 'Maximum value for RC channel 1', unit: 'us' },
  BAT_V_EMPTY: { description: 'Empty cell voltage', unit: 'V' },
  ATC_RAT_RLL_P: { description: 'Roll axis rate controller P gain' },
};

test('the results panel searches descriptions, not just the start of the name', () => {
  const { context, rendered } = mountParamPanel(PANEL_DEFS);

  context.renderForTest('minimum');
  // No parameter is *called* "minimum" — the old datalist could never have
  // surfaced this, which is the entire reason the panel exists.
  assert.deepEqual(rendered(), ['RC1_MIN']);

  context.renderForTest('voltage');
  assert.deepEqual(rendered(), ['BAT_V_EMPTY']);
});

test('an exact or prefix name match outranks a description match', () => {
  const { context, rendered } = mountParamPanel(PANEL_DEFS);

  context.renderForTest('RC1_');
  assert.deepEqual(rendered(), ['RC1_MAX', 'RC1_MIN'], 'prefix hits, in id order');

  // "RC channel 1" appears in both descriptions, so both match — but the one
  // whose *name* matches has to come first.
  context.renderForTest('RC1_MAX');
  assert.equal(rendered()[0], 'RC1_MAX');
});

test('search is case-insensitive and a blank query lists everything', () => {
  const { context, rendered } = mountParamPanel(PANEL_DEFS);

  context.renderForTest('bat_v');
  assert.deepEqual(rendered(), ['BAT_V_EMPTY']);

  context.renderForTest('');
  assert.equal(rendered().length, Object.keys(PANEL_DEFS).length);
});

test('a row carries the id and a detail line with units', () => {
  const { context, element } = mountParamPanel(PANEL_DEFS);
  context.renderForTest('RC1_MIN');

  const row = element('#mav-param-results').options[0];
  assert.equal(row.options[0].label, 'RC1_MIN');
  assert.match(row.options[1].label, /Minimum value for RC channel 1/);
  assert.match(row.options[1].label, /us/, 'units ride the detail line');
});

test('choosing a row fills the field and closes the panel', () => {
  const { context, element } = mountParamPanel(PANEL_DEFS);
  context.renderForTest('minimum');

  const row = element('#mav-param-results').options[0];
  // mousedown, not click: the input's blur fires first and would otherwise
  // tear the panel down before a click could land.
  row.handlers.mousedown({ preventDefault() {} });

  assert.equal(element('#node-input-paramId').val(), 'RC1_MIN');
  assert.equal(element('#mav-param-results').visible, false);
  // Everything the operator needs about the parameter rides on hover, so the
  // dialog does not keep a reference row in front of them after they picked.
  assert.equal(
    element('#node-input-paramId').attrs.title,
    'Minimum value for RC channel 1 | Unit: us'
  );
});

test('every row selects its own parameter, not the last one rendered', () => {
  // The classic closure-over-loop-variable bug: one shared `id` would make
  // each row choose whatever the loop finished on.
  const { context, element } = mountParamPanel(PANEL_DEFS);
  context.renderForTest('RC1_');

  element('#mav-param-results').options[1].handlers.mousedown({ preventDefault() {} });
  assert.equal(element('#node-input-paramId').val(), 'RC1_MIN');
});

test('arrow keys move the selection and wrap', () => {
  const { context } = mountParamPanel(PANEL_DEFS);
  context.renderForTest('RC1_');
  assert.equal(context.hitIndexForTest(), 0);

  context.moveForTest(1);
  assert.equal(context.hitIndexForTest(), 1);
  context.moveForTest(1);
  assert.equal(context.hitIndexForTest(), 0, 'wraps past the end');
  context.moveForTest(-1);
  assert.equal(context.hitIndexForTest(), 1, 'and wraps backwards');
});

test('the panel is capped so a full seed cannot render 6827 rows', () => {
  const many = {};
  for (let i = 0; i < 400; i += 1) {
    many[`P_${String(i).padStart(4, '0')}`] = { description: 'bulk' };
  }
  const { context, rendered } = mountParamPanel(many);
  context.renderForTest('');
  assert.equal(rendered().length, 50);
});

/**
 * The Value field. A parameter with a documented enumeration does not take
 * "a number" — FLTMODE1 takes a flight mode — and one with documented bounds
 * should not let 50 reach a vehicle expecting 800-2200.
 */
const VALUE_DEFS = {
  FLTMODE1: {
    description: 'Flight mode when pwm is <= 1230',
    values: [
      { value: 0, label: 'Stabilize' },
      { value: 2, label: 'AltHold' },
      { value: 5, label: 'Loiter' },
    ],
  },
  RC1_MIN: {
    description: 'RC minimum PWM pulse width',
    unit: 'PWM',
    min: 800,
    max: 2200,
    increment: 1,
  },
};

function mountValueField(defs, values) {
  const applied = [];
  const start = paramHtml.indexOf('var _paramDefs = {};');
  const end = paramHtml.indexOf('/* Reload defs when tier-influencing fields change. */', start);
  assert.ok(start >= 0 && end > start, 'Param definition loader is present');
  const seed = Object.assign({
    '#node-input-delivery': 'build',
    '#node-input-dialect': '__vehicle',
    '#node-input-vehicle': 'profile-1',
    '#node-input-action': 'set',
  }, values || {});

  const { element, $, requests } = makeDom(seed);

  const context = {
    $,
    node: {},
    // Script-scope in the real file, outside the sliced region.
    _paramDefsByKey: {},
    paramDefsKey: () => 'test-key',
    RED: {
      mavlink: {},
      nodes: { node: () => ({ dialect: 'ardupilotmega' }) },
    },
  };
  installEditorHelpers(context);
  // The real helper uses .closest()/.after(); record the call instead.
  context.RED.mavlink.applyFieldMeta = (inputId, meta) => {
    applied.push({ inputId, meta });
  };
  // The select's change handler is registered in oneditprepare, outside the
  // sliced region — but the shared filler ends a fill by firing change, so a
  // harness without the handler cannot see a fill clobber the value box.
  const handlerStart = paramHtml.indexOf("$('#mav-param-value-select').on('change'");
  assert.ok(handlerStart > 0, 'the value select change handler is present');
  const handlerClose = '\n      });';
  const handlerEnd = paramHtml.indexOf(handlerClose, handlerStart) + handlerClose.length;

  vm.runInNewContext(
    `${paramHtml.slice(start, end)}
     ${paramHtml.slice(handlerStart, handlerEnd)}
     this.loadParamDefsForTest = loadParamDefs;
     this.refreshInfoForTest = refreshParamInfo;`,
    context
  );
  context.loadParamDefsForTest();
  requests[0].resolve({ defs });
  return { context, element, applied };
}

test('an enumerated parameter becomes a select, with a custom escape', () => {
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'FLTMODE1',
    '#node-input-value': '2',
  });
  context.refreshInfoForTest();

  const select = element('#mav-param-value-select');
  const labels = select.options.map((o) => o.label);
  assert.deepEqual(labels, ['Stabilize (0)', 'AltHold (2)', 'Loiter (5)', 'Custom value…']);
  assert.equal(select.val(), '2', 'the saved value preselects its own option');
  assert.equal(select.visible, true);
  assert.equal(element('#node-input-value').visible, false, 'the box hides behind the select');
});

test('a value the enumeration does not cover lands in custom mode, still visible', () => {
  // Firmware accepts values no metadata file lists; dropping to a blank select
  // would silently discard one the operator deliberately set.
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'FLTMODE1',
    '#node-input-value': '17',
  });
  context.refreshInfoForTest();

  assert.equal(element('#mav-param-value-select').val(), '__custom');
  assert.equal(element('#node-input-value').visible, true);
  assert.equal(element('#node-input-value').val(), '17', 'and the value is untouched');
});

test('a parameter with no enumeration keeps the plain box', () => {
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'RC1_MIN',
    '#node-input-value': '1000',
  });
  context.refreshInfoForTest();

  assert.equal(element('#mav-param-value-select').visible, false);
  assert.equal(element('#node-input-value').visible, true);
});

test('bounds, step and unit are published on the field', () => {
  const { context, element, applied } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'RC1_MIN',
  });
  context.refreshInfoForTest();

  const value = element('#node-input-value');
  assert.equal(value.attrs.min, '800');
  assert.equal(value.attrs.max, '2200');
  assert.equal(value.attrs.step, '1');
  // The unit reaches the field through the shared helper now, so assert the
  // call rather than a private span — and that `unit` was mapped to its
  // `units` key, which is the easy thing to get silently wrong.
  const meta = applied[applied.length - 1];
  assert.equal(meta.inputId, 'node-input-value');
  assert.equal(meta.meta.units, 'PWM');
});

test('switching to an undocumented parameter clears the previous bounds', () => {
  // Stale min/max from the last parameter would reject perfectly good values.
  const { context, element, applied } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'RC1_MIN',
  });
  context.refreshInfoForTest();
  assert.equal(element('#node-input-value').attrs.min, '800');

  element('#node-input-paramId').val('SCR_USER1');
  context.refreshInfoForTest();
  assert.equal(element('#node-input-value').attrs.min, undefined);
  assert.equal(element('#node-input-value').attrs.max, undefined);
  assert.equal(applied[applied.length - 1].meta.units, '', 'stale units are cleared');
});

test('the Read action leaves the value field alone', () => {
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'FLTMODE1',
    '#node-input-action': 'read',
  });
  context.refreshInfoForTest();
  assert.equal(element('#mav-param-value-select').visible, false);
});
