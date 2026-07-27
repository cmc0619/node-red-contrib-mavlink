'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'nodes', 'mavlink-local-identity.html'),
  'utf8'
);
const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];

class FakeOption {
  constructor() {
    this.value = '';
    this.label = '';
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
}

class FakeSelect {
  constructor(value) {
    this.options = [];
    this.selected = value || '';
  }

  empty() {
    this.options = [];
    this.selected = '';
    return this;
  }

  append(option) {
    this.options.push(option);
    return this;
  }

  val(value) {
    if (value === undefined) return this.selected;
    this.selected = String(value);
    return this;
  }

  find(selector) {
    const value = selector.match(/option\[value="([^"]*)"\]/)[1];
    return { length: this.options.some((option) => option.value === value) ? 1 : 0 };
  }
}

function loadHelpers() {
  function $(selector) {
    if (selector === '<option></option>' || selector === '<option>') {
      return new FakeOption();
    }
    return new FakeSelect();
  }
  $.getJSON = function (url, query, cb) {
    $.lastRequest = { url, query };
    cb({ dialect: 'common', enums: { MAV_TYPE: [] } });
    return { fail() { return this; } };
  };

  const context = {
    RED: {
      mavlink: {},
      nodes: { registerType() {} },
    },
    $,
  };
  vm.runInNewContext(script, context);
  return context;
}

test('enumOptionLabel mirrors the server-side NAME (value) format', () => {
  const context = loadHelpers();

  assert.equal(
    context.RED.mavlink.enumOptionLabel({
      name: 'MAV_TYPE_GCS',
      value: 6,
      description: 'Ground control station.',
    }),
    'MAV_TYPE_GCS (6)'
  );
});

test('loadEnumsCatalog calls the shared enum route with a comma names list', () => {
  const context = loadHelpers();
  let payload = null;

  context.RED.mavlink.loadEnumsCatalog(['MAV_TYPE', 'MAV_COMP_ID'], (catalog) => {
    payload = catalog;
  });

  assert.deepEqual(JSON.parse(JSON.stringify(context.$.lastRequest)), {
    url: '/mavlink/enums',
    query: { names: 'MAV_TYPE,MAV_COMP_ID' },
  });
  assert.equal(payload.dialect, 'common');
});

test('fillEnumSelect writes numeric string values and re-selects saved entries', () => {
  const context = loadHelpers();
  const select = new FakeSelect();

  context.RED.mavlink.fillEnumSelect(
    select,
    [
      { name: 'MAV_TYPE_GENERIC', value: 0, label: 'MAV_TYPE_GENERIC (0)' },
      { name: 'MAV_TYPE_GCS', value: 6, label: 'MAV_TYPE_GCS (6)' },
    ],
    { allowEmpty: true, emptyLabel: 'Any type', saved: 6 }
  );

  assert.deepEqual(
    select.options.map((option) => ({ value: option.value, label: option.label })),
    [
      { value: '', label: 'Any type' },
      { value: '0', label: 'MAV_TYPE_GENERIC (0)' },
      { value: '6', label: 'MAV_TYPE_GCS (6)' },
    ]
  );
  assert.equal(select.selected, '6');
});

test('fillCompIdSelect allows an empty filter option', () => {
  const context = loadHelpers();
  const select = new FakeSelect();

  context.RED.mavlink.fillCompIdSelect(
    select,
    [{ name: 'MAV_COMP_ID_AUTOPILOT1', value: 1, label: 'MAV_COMP_ID_AUTOPILOT1 (1)' }],
    { allowEmpty: true, emptyLabel: 'Any component', saved: '' }
  );

  assert.deepEqual(
    select.options.map((option) => ({ value: option.value, label: option.label })),
    [
      { value: '', label: 'Any component' },
      { value: '1', label: 'MAV_COMP_ID_AUTOPILOT1 (1)' },
    ]
  );
  assert.equal(select.selected, '');
});
