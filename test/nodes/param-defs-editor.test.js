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

class FakeElement {
  constructor(value = '') {
    this.value = value;
    this.label = '';
    this.attrs = {};
    this.handlers = {};
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
    for (const event of events.split(/\s+/)) this.handlers[event] = handler;
    return this;
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
  const elements = new Map();
  const requests = [];
  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, new FakeElement(values[selector] || ''));
    }
    return elements.get(selector);
  }
  function $(selector) {
    if (selector === '<option></option>') return new FakeElement();
    return element(selector);
  }
  $.getJSON = (url, query, success) => {
    const request = new FakeDeferred({ url, query });
    request.doneHandler = success;
    requests.push(request);
    return request;
  };

  const context = {
    $,
    node: {},
    RED: {
      mavlink: {
        adminApiUrl: (value) => value,
        enumOptionLabel: (entry) => `${entry.label} (${entry.value})`,
      },
      nodes: {
        node(id) {
          return id === 'profile-1' ? { dialect: 'ardupilotmega' } : null;
        },
      },
    },
  };
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
  assert.equal(element('#mav-param-id-list').options.length, 1);
  assert.equal(element('#row-param-info').visible, true);
  assert.equal(element('#node-input-paramId').attrs.title, 'Previously loaded definition.');

  context.loadParamDefsForTest();
  requests[1].reject({ responseJSON: { error: 'holding file is corrupt' } });

  assert.equal(element('#mav-param-id-list').options.length, 0);
  assert.equal(element('#node-input-paramId').attrs.list, undefined);
  assert.equal(element('#node-input-paramId').attrs.title, undefined);
  assert.equal(element('#row-param-info').visible, false);
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
    const elements = new Map();
    const requests = [];
    function element(selector) {
      if (!elements.has(selector)) elements.set(selector, new FakeElement(values[selector] || ''));
      return elements.get(selector);
    }
    function $(selector) {
      if (selector === '<option></option>') return new FakeElement();
      return element(selector);
    }
    $.getJSON = (url, query, success) => {
      const request = new FakeDeferred({ url, query });
      request.doneHandler = success;
      requests.push(request);
      return request;
    };
    const context = {
      $,
      node: {},
      RED: {
        mavlink: { adminApiUrl: (v) => v, enumOptionLabel: (e) => `${e.label} (${e.value})` },
        nodes: { node: (id) => (nodesById || {})[id] || null },
      },
    };
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
