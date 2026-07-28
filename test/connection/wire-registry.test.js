'use strict';

/**
 * Wire registries follow the dialect include chain (bundle.files), not a
 * hardcoded MSC+ardupilotmega preload. Two connections with different profiles
 * therefore hold independent registries side by side.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundled, compileXml } = require('../../lib/metadata');
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
    /no wire class for message 'STATUSTEXT'/
  );
});

test('icarous wire carries only icarous messages — not the forced MSC spine', () => {
  const bundle = loadBundled('icarous');
  assert.deepEqual(bundle.files, ['icarous']);
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
    /no wire class for message 'HEARTBEAT'/
  );
});

test('two wires from different dialects coexist with independent registries', () => {
  const icarous = createWire({ bundle: loadBundled('icarous') });
  const apm = createWire({ bundle: loadBundled('ardupilotmega') });

  assert.doesNotThrow(() =>
    icarous.serialize({ name: 'ICAROUS_HEARTBEAT', fields: { status: 0 } }, { sysid: 1, compid: 1, seq: 0 })
  );
  assert.throws(
    () => icarous.serialize({ name: 'HEARTBEAT', fields: {} }, { sysid: 1, compid: 1, seq: 0 }),
    /no wire class for message 'HEARTBEAT'/
  );

  assert.doesNotThrow(() =>
    apm.serialize(
      { name: 'HEARTBEAT', fields: { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 0, mavlink_version: 3 } },
      { sysid: 1, compid: 1, seq: 0 }
    )
  );
  // ardupilotmega's bundled chain does not pull icarous (our chain is MSC+APM).
  assert.throws(
    () => apm.serialize({ name: 'ICAROUS_HEARTBEAT', fields: { status: 0 } }, { sysid: 1, compid: 1, seq: 0 }),
    /no wire class for message 'ICAROUS_HEARTBEAT'/
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
    /no wire class for message 'HEARTBEAT'/
  );
});
