'use strict';

/**
 * Wire registries follow the dialect include chain (bundle.files), not a
 * hardcoded MSC+ardupilotmega preload. Two connections with different profiles
 * therefore hold independent registries side by side.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled } = require('../../lib/metadata/bundled');
const { compileXml } = require('../../lib/metadata/compile');
const { createWire } = require('../../lib/connection/wire');

test('wire registry follows the bundle include chain — minimal has HEARTBEAT, not STATUSTEXT', () => {
  const wire = createWire({ bundle: loadBundled('minimal') });
  const hb = wire.serialize(
    { name: 'HEARTBEAT', fields: { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 0, mavlink_version: 3 } },
    { sysid: 1, compid: 1, seq: 0 }
  );
  assert.equal(wire.decode(hb).length, 1);

  assert.throws(
    () => wire.serialize({ name: 'STATUSTEXT', fields: { severity: 6, text: 'x' } }, { sysid: 1, compid: 1, seq: 1 }),
    TypeError
  );
});

test('common HEARTBEAT supplies its dialect version when omitted or overridden', () => {
  const wire = createWire({ bundle: loadBundled('common') });
  const baseFields = {
    type: 6,
    autopilot: 8,
    base_mode: 0,
    custom_mode: 0,
    system_status: 0,
  };

  const omitted = wire.serialize(
    { name: 'HEARTBEAT', fields: baseFields },
    { sysid: 1, compid: 1, seq: 0 }
  );
  const wrong = wire.serialize(
    { name: 'HEARTBEAT', fields: { ...baseFields, mavlink_version: 1 } },
    { sysid: 1, compid: 1, seq: 1 }
  );

  assert.equal(wire.decode(omitted)[0].fields.mavlink_version, 3);
  assert.equal(wire.decode(wrong)[0].fields.mavlink_version, 3);
  assert.equal(wire.decode(wrong)[0].fields.type, 6);
});

const VERSIONED_XML = (version) => `<?xml version="1.0"?>
<mavlink>
  <version>${version}</version>
  <messages>
    <message id="60002" name="VERSIONED_STATUS">
      <field type="uint8_t" name="value">Value.</field>
      <field type="uint8_t_mavlink_version" name="mavlink_version">Version.</field>
    </message>
  </messages>
</mavlink>`;

const versionedBundle = (version) => compileXml(
  { 'versioned.xml': VERSIONED_XML(version) },
  'versioned.xml'
);

test('custom dialect constants fill outbound version without changing ordinary uint8 fields', () => {
  const receiver = createWire({ bundle: versionedBundle(7) });
  const sender = createWire({ bundle: versionedBundle(4) });

  const omitted = receiver.serialize(
    { name: 'VERSIONED_STATUS', fields: { value: 9 } },
    { sysid: 1, compid: 1, seq: 0 }
  );
  const wrong = receiver.serialize(
    { name: 'VERSIONED_STATUS', fields: { value: 10, mavlink_version: 1 } },
    { sysid: 1, compid: 1, seq: 1 }
  );
  const inbound = sender.serialize(
    { name: 'VERSIONED_STATUS', fields: { value: 11 } },
    { sysid: 1, compid: 1, seq: 2 }
  );

  assert.equal(receiver.decode(omitted)[0].fields.value, 9);
  assert.equal(receiver.decode(omitted)[0].fields.mavlink_version, 7);
  assert.equal(receiver.decode(wrong)[0].fields.value, 10);
  assert.equal(receiver.decode(wrong)[0].fields.mavlink_version, 7);
  assert.equal(receiver.decode(inbound)[0].fields.value, 11);
  assert.equal(receiver.decode(inbound)[0].fields.mavlink_version, 4);
});

test('icarous wire carries only icarous messages — not the forced MSC spine', () => {
  const bundle = loadBundled('icarous');
  assert.deepEqual(bundle.files, ['icarous.xml']);
  assert.ok(bundle.messages.ICAROUS_HEARTBEAT);
  assert.equal(bundle.messages.HEARTBEAT, undefined);

  const wire = createWire({ bundle });
  const frame = wire.serialize(
    { name: 'ICAROUS_HEARTBEAT', fields: { status: 0 } },
    { sysid: 1, compid: 1, seq: 0 }
  );
  assert.equal(wire.decode(frame)[0].name, 'ICAROUS_HEARTBEAT');

  assert.throws(
    () => wire.serialize({ name: 'HEARTBEAT', fields: {} }, { sysid: 1, compid: 1, seq: 1 }),
    TypeError
  );
});

test('two wires from different dialects coexist with independent registries', () => {
  const icarous = createWire({ bundle: loadBundled('icarous') });
  const minimal = createWire({ bundle: loadBundled('minimal') });
  const apm = createWire({ bundle: loadBundled('ardupilotmega') });

  assert.doesNotThrow(() =>
    icarous.serialize({ name: 'ICAROUS_HEARTBEAT', fields: { status: 0 } }, { sysid: 1, compid: 1, seq: 0 })
  );
  assert.throws(
    () => icarous.serialize({ name: 'HEARTBEAT', fields: {} }, { sysid: 1, compid: 1, seq: 0 }),
    TypeError
  );

  assert.doesNotThrow(() =>
    minimal.serialize(
      { name: 'HEARTBEAT', fields: { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 0, mavlink_version: 3 } },
      { sysid: 1, compid: 1, seq: 0 }
    )
  );
  assert.throws(
    () => minimal.serialize({ name: 'ICAROUS_HEARTBEAT', fields: { status: 0 } }, { sysid: 1, compid: 1, seq: 0 }),
    TypeError
  );

  // Upstream ardupilotmega.xml includes icarous — the seed preserves that.
  assert.doesNotThrow(() =>
    apm.serialize({ name: 'ICAROUS_HEARTBEAT', fields: { status: 0 } }, { sysid: 1, compid: 1, seq: 0 })
  );
});

test('custom dialect with no includes starts empty — only its own messages encode', () => {
  const bundle = compileXml(
    {
      'widgetlink.xml': `<?xml version="1.0"?>
<mavlink>
  <version>3</version>
  <messages>
    <message id="60001" name="WIDGET_STATUS">
      <field type="uint16_t" name="state">State.</field>
      <field type="uint8_t" name="widget_id">Widget id.</field>
    </message>
  </messages>
</mavlink>`,
    },
    'widgetlink.xml'
  );
  const wire = createWire({ bundle });
  const frame = wire.serialize(
    { name: 'WIDGET_STATUS', fields: { widget_id: 7, state: 513 } },
    { sysid: 255, compid: 190, seq: 3 }
  );
  assert.equal(wire.decode(frame)[0].name, 'WIDGET_STATUS');
  assert.throws(
    () => wire.serialize({ name: 'HEARTBEAT', fields: {} }, { sysid: 1, compid: 1, seq: 0 }),
    TypeError
  );
});
