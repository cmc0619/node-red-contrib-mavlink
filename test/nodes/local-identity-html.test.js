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
    this.attrs = {};
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
    this.attrs[name] = String(value);
    return this;
  }

  removeAttr(name) {
    delete this.attrs[name];
    return this;
  }
}

class FakeSelect {
  constructor(value, enforceOptions = false) {
    this.options = [];
    this.selected = value || '';
    this.enforceOptions = enforceOptions;
    this.attrs = {};
    this.triggered = [];
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
    const next = String(value);
    if (this.enforceOptions && !this.options.some((option) => option.value === next)) {
      this.selected = null;
    } else {
      this.selected = next;
    }
    return this;
  }

  attr(name, value) {
    if (value === undefined) return this.attrs[name];
    this.attrs[name] = String(value);
    return this;
  }

  removeAttr(name) {
    delete this.attrs[name];
    return this;
  }

  off() {
    return this;
  }

  on() {
    return this;
  }

  trigger(eventName) {
    this.triggered.push(eventName);
    return this;
  }

  find(selector) {
    if (selector === 'option:selected') {
      const selected = this.options.find((option) => option.value === this.selected);
      return selected || {
        length: 0,
        attr() { return undefined; },
      };
    }
    const value = selector.match(/option\[value="([^"]*)"\]/)[1];
    return { length: this.options.some((option) => option.value === value) ? 1 : 0 };
  }
}

function loadHelpers(initialValues = {}) {
  const elements = new Map();
  let identityDefinition = null;

  function $(selector) {
    if (selector === '<option></option>' || selector === '<option>') {
      return new FakeOption();
    }
    if (!elements.has(selector)) {
      const enforceOptions = selector === '#node-config-input-sourceComponentId';
      const element = new FakeSelect(undefined, enforceOptions);
      if (initialValues[selector] !== undefined) {
        if (enforceOptions) {
          element.append(new FakeOption().val(initialValues[selector]));
        }
        element.val(initialValues[selector]);
      }
      elements.set(selector, element);
    }
    return elements.get(selector);
  }
  $.getJSON = function (url, query, cb) {
    $.lastRequest = { url, query };
    cb({ dialect: 'common', enums: { MAV_TYPE: [] } });
    return { fail() { return this; } };
  };

  const context = {
    RED: {
      settings: { httpAdminRoot: '/' },
      mavlink: {},
      nodes: {
        registerType(type, definition) {
          if (type === 'mavlink-local-identity') {
            identityDefinition = definition;
          }
        },
      },
    },
    $,
  };
  vm.runInNewContext(script, context);
  context.identityDefinition = identityDefinition;
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

  context.RED.mavlink.loadEnumsCatalog(['MAV_TYPE', 'MAV_COMPONENT'], (catalog) => {
    payload = catalog;
  });

  assert.deepEqual(JSON.parse(JSON.stringify(context.$.lastRequest)), {
    url: '/mavlink/enums',
    query: { names: 'MAV_TYPE,MAV_COMPONENT' },
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
  assert.deepEqual(select.triggered, ['change']);
});

test('fillEnumSelect seeds a saved CompID before dialect labels arrive', () => {
  const context = loadHelpers();
  const select = new FakeSelect();

  context.RED.mavlink.fillCompIdSelect(select, [], { saved: 190 });

  assert.equal(select.selected, '190');
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].value, '190');
  assert.match(select.options[0].label, /not in dialect/);
  assert.deepEqual(select.triggered, ['change']);
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

test('identity oneditprepare loads MAV_TYPE by enum name, not numeric value', () => {
  assert.match(
    html,
    /fillEnumSelect\(\$hbType[\s\S]*valueKey:\s*'name'/
  );
  assert.match(html, /saved:\s*\$hbType\.val\(\)\s*\|\|\s*node\.heartbeatType/);
  assert.match(html, /saved:\s*\$hbAp\.val\(\)\s*\|\|\s*node\.heartbeatAutopilot/);
  assert.match(html, /saved:\s*\$compid\.val\(\)\s*\|\|\s*node\.sourceComponentId/);
});

test('identity oneditprepare seeds CompID before async enum catalog', () => {
  // Sync seed must appear before loadEnumsCatalog so post-prepare validation
  // sees the saved numeric CompID while MAV_COMPONENT is still loading.
  const seedIdx = html.indexOf("fillCompIdSelect($compid, [],");
  const loadIdx = html.indexOf("loadEnumsCatalog(['MAV_TYPE', 'MAV_AUTOPILOT', 'MAV_COMPONENT']");
  assert.ok(seedIdx !== -1, 'sync CompID seed');
  assert.ok(loadIdx !== -1, 'async enum load');
  assert.ok(seedIdx < loadIdx, 'seed before async catalog');
  assert.match(html, /\$select\.trigger\('change'\)/);
});

test('adminApiUrl respects a non-root httpAdminRoot', () => {
  const context = loadHelpers();
  context.RED.settings.httpAdminRoot = '/red';
  assert.equal(context.RED.mavlink.adminApiUrl('/mavlink/enums'), '/red/mavlink/enums');
});

test('loadEnumsCatalog ignores responses after the dialog token is cancelled', () => {
  const context = loadHelpers();
  let calls = 0;
  const token = { cancelled: true };
  context.RED.mavlink.loadEnumsCatalog(['MAV_TYPE'], () => {
    calls += 1;
  }, token);
  assert.equal(calls, 0);
});

test('Companion save clears hidden source IDs before Node-RED copies editor inputs', () => {
  const context = loadHelpers({
    '#node-config-input-role': 'companion',
    '#node-config-input-sourceSystemId': '255',
    '#node-config-input-sourceComponentId': '190',
  });
  const node = {
    role: 'gcs',
    sourceSystemId: 255,
    sourceComponentId: 190,
  };

  context.identityDefinition.oneditsave.call(node);

  // Node-RED copies editor values to the node after oneditsave returns.
  node.role = context.$('#node-config-input-role').val();
  node.sourceSystemId = context.$('#node-config-input-sourceSystemId').val();
  const sourceComponentId = context.$('#node-config-input-sourceComponentId').val();
  if (sourceComponentId != null) {
    node.sourceComponentId = sourceComponentId;
  }

  assert.equal(node.role, 'companion');
  assert.equal(node.sourceSystemId, '');
  assert.equal(node.sourceComponentId, '');
});
