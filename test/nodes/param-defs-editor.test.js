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

const { makeDom, FakeElement, FakeDeferred } = require('../helpers/fake-dom');

test('Vehicle parameter Update is single-flight and restores both result states', () => {
  const start = vehicleHtml.indexOf("$('#mav-param-defs-update').on('click'");
  const end = vehicleHtml.indexOf('        loadLibrary(() =>', start);
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
    RED: { mavlink: { adminApiUrl: (value) => value } },
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
  const start = paramHtml.indexOf('let _paramDefs = {};');
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
  // What a successful load must produce here is the hover text — description,
  // unit and range ride on `title`, not on a row that stays in the dialog.
  assert.equal(
    element('#node-input-paramId').attrs.title,
    'Previously loaded definition. | Unit: Hz'
  );

  context.loadParamDefsForTest();
  requests[1].reject({ responseJSON: { error: 'holding file is corrupt' } });

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
  const start = paramHtml.indexOf('let _paramDefs = {};');
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
 * The param id search. A datalist could only match the *start of the name*,
 * so finding a parameter meant already knowing what it was called — the exact
 * problem a seeded 6827-entry list makes worse, not better. Node-RED's stock
 * autoComplete widget owns the panel, keyboard navigation and blur handling;
 * what stays ours is the ranking in `searchParams` and the option shape
 * `autocompleteOptions` hands the widget, so that is what is exercised here.
 */
function mountParamSearch(defs, initialValue) {
  const start = paramHtml.indexOf('let _paramDefs = {};');
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
     this.searchForTest = searchParams;
     this.optionsForTest = autocompleteOptions;`,
    context
  );
  context.loadParamDefsForTest();
  requests[0].resolve({ defs });

  // Array.from re-homes the result in this realm: the editor script builds
  // its arrays inside the vm context, and a deep-equal would fail on the
  // foreign Array prototype rather than on the ids.
  const search = (query) => Array.from(context.searchForTest(query));
  return { context, element, search };
}

const SEARCH_DEFS = {
  RC1_MIN: { description: 'Minimum value for RC channel 1', unit: 'us' },
  RC1_MAX: { description: 'Maximum value for RC channel 1', unit: 'us' },
  BAT_V_EMPTY: { description: 'Empty cell voltage', unit: 'V' },
  ATC_RAT_RLL_P: { description: 'Roll axis rate controller P gain' },
};

test('the search matches descriptions, not just the start of the name', () => {
  const { search } = mountParamSearch(SEARCH_DEFS);

  // No parameter is *called* "minimum" — a datalist could never have
  // surfaced this, which is the entire reason the ranking is ours.
  assert.deepEqual(search('minimum'), ['RC1_MIN']);
  assert.deepEqual(search('voltage'), ['BAT_V_EMPTY']);
});

test('an exact or prefix name match outranks a description match', () => {
  const { search } = mountParamSearch(SEARCH_DEFS);

  assert.deepEqual(search('RC1_'), ['RC1_MAX', 'RC1_MIN'], 'prefix hits, in id order');

  // "RC channel 1" appears in both descriptions, so both match — but the one
  // whose *name* matches has to come first.
  assert.equal(search('RC1_MAX')[0], 'RC1_MAX');
});

test('search is case-insensitive and a blank query lists everything', () => {
  const { search } = mountParamSearch(SEARCH_DEFS);

  assert.deepEqual(search('bat_v'), ['BAT_V_EMPTY']);
  assert.equal(search('').length, Object.keys(SEARCH_DEFS).length);
});

test('an option carries the id as its value and a detail line with units', () => {
  const { context } = mountParamSearch(SEARCH_DEFS);
  const [option] = context.optionsForTest('RC1_MIN');

  assert.equal(option.value, 'RC1_MIN', 'the widget writes the id, not the label, into the field');
  const [id, detail] = option.label.options;
  assert.equal(id.label, 'RC1_MIN');
  assert.match(detail.label, /Minimum value for RC channel 1/);
  assert.match(detail.label, /us/, 'units ride the detail line');
});

test('the search is capped so a full seed cannot hand the widget 6827 rows', () => {
  const many = {};
  for (let i = 0; i < 400; i += 1) {
    many[`P_${String(i).padStart(4, '0')}`] = { description: 'bulk' };
  }
  const { search } = mountParamSearch(many);
  assert.equal(search('').length, 50);
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
  ARMING_CHECK: {
    description: 'Which checks arm requires',
    bits: [
      { bit: 0, label: 'All' },
      { bit: 1, label: 'Barometer' },
      { bit: 2, label: 'Compass' },
    ],
  },
  HIGH_OPTS: {
    description: 'A mask documenting the sign bit',
    bits: [
      { bit: 0, label: 'Low' },
      { bit: 31, label: 'High' },
    ],
  },
};

function mountValueField(defs, values) {
  const applied = [];
  const start = paramHtml.indexOf('let _paramDefs = {};');
  const end = paramHtml.indexOf('/* Reload defs when tier-influencing fields change. */', start);
  assert.ok(start >= 0 && end > start, 'Param definition loader is present');
  const seed = {'#node-input-delivery': 'build',
    '#node-input-dialect': '__vehicle',
    '#node-input-vehicle': 'profile-1',
    '#node-input-action': 'set', ...values || {}};

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
  // The box's input handler keeps the switches honest after a hand edit; it
  // registers alongside the select handler and belongs in the harness with it.
  const boxHandlerStart = paramHtml.indexOf("$('#node-input-value').on('input'");
  assert.ok(boxHandlerStart > 0, 'the value box input handler is present');
  const boxHandlerEnd = paramHtml.indexOf(handlerClose, boxHandlerStart) + handlerClose.length;

  vm.runInNewContext(
    `${paramHtml.slice(start, end)}
     ${paramHtml.slice(handlerStart, handlerEnd)}
     ${paramHtml.slice(boxHandlerStart, boxHandlerEnd)}
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

test('a bitmask parameter becomes a multi-select of switches, box still visible', () => {
  // ARMING_CHECK takes checks, not a sum the operator computes by hand.
  // Saved 6 = bits 1+2; the box stays visible so blank-defers-to-payload and
  // undocumented bits remain reachable.
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'ARMING_CHECK',
    '#node-input-value': '6',
  });
  context.refreshInfoForTest();

  const select = element('#mav-param-value-select');
  assert.equal(select.attr('multiple'), 'multiple');
  assert.deepEqual(select.options.map((o) => o.label),
    ['All (bit 0)', 'Barometer (bit 1)', 'Compass (bit 2)']);
  assert.deepEqual(select.val(), ['2', '4'], 'saved bits preselect their flags');
  assert.equal(select.visible, true);
  assert.equal(element('#node-input-value').visible, true, 'the box stays beside the picker');
});

test('picking bits writes the sum through, preserving undocumented remainder bits', () => {
  // Saved 9 = documented bit 0 (1) + undocumented bit 3 (8). Re-picking to
  // Barometer only must produce 2 + the untouched remainder 8 — firmware
  // accepts bits no metadata file lists, and a picker change must not
  // silently zero one the operator set by hand.
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'ARMING_CHECK',
    '#node-input-value': '9',
  });
  context.refreshInfoForTest();

  const select = element('#mav-param-value-select');
  assert.deepEqual(select.val(), ['1'], 'only the documented bit preselects');
  select.val(['2']);
  select.trigger('change');
  assert.equal(element('#node-input-value').val(), '10', '2 (picked) + 8 (remainder)');

  // Deselecting everything leaves exactly the remainder.
  select.val([]);
  select.trigger('change');
  assert.equal(element('#node-input-value').val(), '8');
});

test('bit-31 masks arrive spelled negative and leave the same way (Gitar, #296)', () => {
  // Bitmask params are int32 on the wire and decode signed: LOG_BITMASK -2 is
  // every bit except bit 0, not garbage. The picker must read the unsigned
  // magnitude (bits 1 and 2 preselect) and write results back in int32
  // spelling so the Set stays encodable (writeInt32LE).
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'ARMING_CHECK',
    '#node-input-value': '-2',
  });
  context.refreshInfoForTest();

  const select = element('#mav-param-value-select');
  assert.deepEqual(select.val(), ['2', '4'], 'documented bits of the unsigned magnitude preselect');

  // Re-pick to bit 0 only: remainder (bits 3..31 = 4294967288) survives and
  // the sum leaves as the negative int32 it will read back as.
  select.val(['1']);
  select.trigger('change');
  assert.equal(element('#node-input-value').val(), '-7', '1 + high remainder, int32 spelling');

  select.val([]);
  select.trigger('change');
  assert.equal(element('#node-input-value').val(), '-8', 'remainder alone, still int32 spelling');
});

test('freshly picking bit 31 from a blank box writes the signed spelling (Gitar, #296 round 2)', () => {
  // The option value for bit 31 is the positive 2147483648, but the box must
  // receive the int32 spelling writeInt32LE accepts — the fold is
  // BigInt.asIntN(32), so a fresh pick and a preselected round-trip agree.
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'HIGH_OPTS',
    '#node-input-value': '',
  });
  context.refreshInfoForTest();

  const select = element('#mav-param-value-select');
  select.val(['2147483648']);
  select.trigger('change');
  assert.equal(element('#node-input-value').val(), '-2147483648');

  select.val(['1', '2147483648']);
  select.trigger('change');
  assert.equal(element('#node-input-value').val(), '-2147483647');

  // And the written value round-trips: reopening preselects the High bit.
  context.refreshInfoForTest();
  assert.deepEqual(element('#mav-param-value-select').val(), ['1', '2147483648']);
});

test('a box value outside signed int32 is left alone, not folded (CodeRabbit, #296)', () => {
  // 4294967296 is bit 32 — unencodable by writeInt32LE in either spelling.
  // The fold would silently rewrite it to whatever survives truncation; the
  // picker must refuse instead, leaving the red-flagged value for the
  // operator to fix.
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'ARMING_CHECK',
    '#node-input-value': '4294967296',
  });
  context.refreshInfoForTest();

  const select = element('#mav-param-value-select');
  assert.deepEqual(select.val(), [], 'no documented bit pretends to cover bit 32');
  select.val(['2']);
  select.trigger('change');
  assert.equal(element('#node-input-value').val(), '4294967296', 'the box is untouched');
});

test('hand-editing the box resyncs the switches before the next pick (Codex, #296)', () => {
  // Open with mask 1 (bit 0 selected), hand-edit the box to the undocumented
  // mask 8. Stale switches would fold the deselected bit 0 straight back in
  // on the next pick: picking Barometer must produce 2 + 8, not 1 + 2 + 8.
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'ARMING_CHECK',
    '#node-input-value': '1',
  });
  context.refreshInfoForTest();

  const select = element('#mav-param-value-select');
  assert.deepEqual(select.val(), ['1'], 'the saved bit preselects');

  element('#node-input-value').val('8');
  element('#node-input-value').trigger('input');
  assert.deepEqual(select.val(), [], 'the hand-edited mask deselects the stale switch');

  select.val(['2']);
  select.trigger('change');
  assert.equal(element('#node-input-value').val(), '10', '2 (picked) + 8 (remainder), no resurrected bit 0');
});

test('deselecting every switch on a blank box leaves it blank, not "0"', () => {
  // Blank defers to msg.payload. A look-and-untick that writes "0" silently
  // converts that node into one that sets the mask to zero — for ARMING_CHECK,
  // every check disabled. Deselect-to-remainder still applies when there is a
  // remainder to keep; here there is none.
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'ARMING_CHECK',
    '#node-input-value': '',
  });
  context.refreshInfoForTest();

  const select = element('#mav-param-value-select');
  select.val(['2']);
  select.trigger('change');
  assert.equal(element('#node-input-value').val(), '2', 'picking still writes the mask');

  select.val([]);
  select.trigger('change');
  assert.equal(element('#node-input-value').val(), '0',
    'a mask the operator built and then cleared is an explicit zero');

  // But a box that was never filled stays blank through the same gesture.
  const blank = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'ARMING_CHECK',
    '#node-input-value': '',
  });
  blank.context.refreshInfoForTest();
  blank.element('#mav-param-value-select').trigger('change');
  assert.equal(blank.element('#node-input-value').val(), '',
    'no selection and no box value: still deferring to msg.payload');
});

test('switching from a bitmask parameter back to an enum restores single-select mode', () => {
  // The multiple attribute must not leak between parameters: an enum select
  // wearing it would return arrays to the single-value handler.
  const { context, element } = mountValueField(VALUE_DEFS, {
    '#node-input-paramId': 'ARMING_CHECK',
    '#node-input-value': '1',
  });
  context.refreshInfoForTest();
  assert.equal(element('#mav-param-value-select').attr('multiple'), 'multiple');

  element('#node-input-paramId').val('FLTMODE1');
  element('#node-input-value').val('2');
  context.refreshInfoForTest();
  const select = element('#mav-param-value-select');
  assert.equal(select.attr('multiple'), undefined, 'multiple cleared for the enum');
  assert.equal(select.val(), '2', 'single-select semantics restored');
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

test('a published type is the only type on offer; an unpublished one leaves the choice', () => {
  // PX4 states a type for every parameter and ArduPilot states none, so the
  // control follows what was published rather than which firmware it is.
  const { context, element } = mountValueField(
    {
      BAT_N_CELLS: { description: 'Cells', type: 'MAV_PARAM_TYPE_INT32' },
      ATC_RAT_RLL_P: { description: 'Roll P gain' },
    },
    { '#node-input-paramId': 'BAT_N_CELLS' }
  );
  context.refreshInfoForTest();

  const $type = element('#node-input-paramType');
  assert.equal($type.val(), 'MAV_PARAM_TYPE_INT32', 'set from the definition');
  assert.equal($type.options.length, 1, 'and nothing else can be picked');
  assert.match($type.attrs.title, /Published by the firmware/);

  // A pulldown with one choice is not a choice (owner ruling): the published
  // type is *stated*, and the select — still the field Node-RED saves — hides.
  const $display = element('#mav-param-type-display');
  assert.equal($type.visible, false, 'the one-choice select is hidden');
  assert.equal($display.visible, true, 'the published type is displayed instead');
  assert.match($display.text(), /INT32 \(6\) — published by the firmware/);

  // A parameter whose firmware publishes nothing gets the full list back —
  // narrowing must not be one-way, and the choice returns as a choice.
  element('#node-input-paramId').val('ATC_RAT_RLL_P');
  context.refreshInfoForTest();
  assert.ok($type.options.length > 1, 'the choice returns');
  assert.match($type.attrs.title, /publishes no type/);
  assert.equal($type.visible, true, 'the select is a select again');
  assert.equal($display.visible, false, 'the display steps aside');
});

test('the Type select ships empty and is filled from the shared table', () => {
  // The table's home is lib/codec/param-union.js, mirrored once for the editor
  // in resources/mavlink-editor.js and pinned there by test. A per-node copy
  // would be a third one that has to agree with the other two.
  assert.match(paramHtml, /<select id="node-input-paramType"><\/select>/);
  assert.match(paramHtml, /RED\.mavlink\.PARAM_TYPE_OPTIONS/, 'filled from the shared table');
  assert.doesNotMatch(paramHtml, /_paramTypeOptions\s*=\s*\[/, 'and keeps no copy of its own');
});

/**
 * Mount the real `applyActionRows` and report which rows it leaves visible.
 *
 * The row matrix is the whole point of the function, and it was previously
 * asserted by matching `.toggle(` calls in the source — which proves the file
 * says something, not that the combination of action and mode resolves the way
 * the protocol requires.
 *
 * @param {string} action  the Action select's value
 * @param {string} lookup  the persisted Identify-by value
 * @returns {{visible: string[], index: string}}
 */
function mountActionRows(action, lookup) {
  const start = paramHtml.indexOf('function applyActionRows() {');
  assert.ok(start > 0, 'applyActionRows is present');
  const end = paramHtml.indexOf('\n      }', start);
  assert.ok(end > start, 'and terminates at the expected anchor');

  const { element, $ } = makeDom({
    '#node-input-action': action,
    '#node-input-lookup': lookup,
  });
  const context = {
    $,
    RED: { mavlink: {} },
    // The dialog's `node` closure; the stubbed indexAddressed ignores it.
    node: {},
    // The two collaborators, stubbed only because they are proven elsewhere:
    // liveOr in mavlink-editor-resource.test.js, the results panel above.
    indexAddressed: () => action === 'read' && lookup === 'index',
    hideParamResults: () => {},
    // The Type row also answers to firmware — ArduPilot hides it outright,
    // since nothing reads the declared type there. That half is sliced from
    // the real file by the value-field harness below; only the action half is
    // under test here.
    applyTypeRowVisibility: () => element('#row-paramType').toggle(action === 'set'),
  };
  vm.runInNewContext(
    `${paramHtml.slice(start, end + '\n      }'.length)}\nthis.run = applyActionRows;`,
    context
  );
  context.run();

  const rows = ['#row-param-lookup', '#row-paramId', '#row-paramIndex', '#row-value', '#row-paramType'];
  return {
    visible: rows.filter((r) => element(r).visible),
    index: element('#node-input-paramIndex').val(),
  };
}

test('each action shows exactly the fields its wire message carries', () => {
  // read → PARAM_REQUEST_READ (param_id or param_index)
  assert.deepEqual(
    mountActionRows('read', 'name').visible,
    ['#row-param-lookup', '#row-paramId'],
    'by name: the choice and the name, no value and no type'
  );
  assert.deepEqual(
    mountActionRows('read', 'index').visible,
    ['#row-param-lookup', '#row-paramIndex'],
    'by index: the index replaces the name rather than joining it'
  );

  // set → PARAM_SET (param_id, param_value, param_type). No param_index field
  // exists, so the choice is not offered and the name is the only address.
  for (const lookup of ['name', 'index']) {
    assert.deepEqual(
      mountActionRows('set', lookup).visible,
      ['#row-paramId', '#row-value', '#row-paramType'],
      `set with a saved lookup of ${lookup}`
    );
  }

  // request-list → PARAM_REQUEST_LIST, which carries nothing but the target.
  for (const lookup of ['name', 'index']) {
    assert.deepEqual(
      mountActionRows('request-list', lookup).visible, [],
      `request-list with a saved lookup of ${lookup}: it names no parameter`
    );
  }
});

test('a hidden index carries the sentinel, and a hidden value is left alone', () => {
  // param_index -1 means "use param_id", so a leftover index would win over
  // the name on the wire — it is stamped every time the field is hidden.
  for (const [action, lookup] of [['read', 'name'], ['set', 'index'], ['request-list', 'index']]) {
    assert.equal(mountActionRows(action, lookup).index, '-1', `${action}/${lookup}`);
  }
  // …and never when the operator is the one editing it.
  assert.notEqual(mountActionRows('read', 'index').index, '-1');
});
