'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mav = require('node-mavlink');
const { loadBundled, compileXml } = require('../../lib/metadata');
const { normalizeType } = require('../../lib/codec/types');
const { synthesizeWireClasses, buildMessageClass } = require('../../lib/connection/wire-classes');
const { createWire } = require('../../lib/connection/wire');

/**
 * The golden pin: synthesized classes must be byte-identical in layout to the
 * generated `mavlink-mappings` classes, for every message of every bundled
 * dialect. Any divergence in wire order, sizing, extension handling, or the
 * CRC_EXTRA hash fails here before it can corrupt a single frame.
 */
test('synthesized classes match every generated class across bundled dialects', () => {
  const generated = {};
  for (const name of ['minimal', 'standard', 'common', 'ardupilotmega']) {
    for (const cls of Object.values((mav[name] && mav[name].REGISTRY) || {})) {
      generated[cls.MSG_NAME] = cls;
    }
  }

  const bundle = loadBundled('ardupilotmega');
  let compared = 0;
  for (const [name, gen] of Object.entries(generated)) {
    const meta = bundle.messages[name];
    assert.ok(meta, `${name}: generated message missing from the compiled bundle`);
    const synth = buildMessageClass(mav, meta);

    assert.equal(synth.MSG_ID, gen.MSG_ID, `${name}: MSG_ID`);
    assert.equal(synth.MAGIC_NUMBER, gen.MAGIC_NUMBER, `${name}: MAGIC_NUMBER (CRC_EXTRA)`);
    assert.equal(synth.PAYLOAD_LENGTH, gen.PAYLOAD_LENGTH, `${name}: PAYLOAD_LENGTH`);
    assert.equal(synth.FIELDS.length, gen.FIELDS.length, `${name}: field count`);
    for (let i = 0; i < gen.FIELDS.length; i++) {
      const g = gen.FIELDS[i];
      const s = synth.FIELDS[i];
      const ctx = `${name}.${g.source}`;
      assert.equal(s.source, g.source, `${ctx}: wire order`);
      assert.equal(s.offset, g.offset, `${ctx}: offset`);
      assert.equal(s.size, g.size, `${ctx}: element size`);
      assert.equal(s.length, g.length, `${ctx}: array length`);
      assert.equal(s.extension, g.extension, `${ctx}: extension flag`);
      // The dts metadata collapses the uint8_t_mavlink_version alias; compare
      // normalized scalar types and array-ness separately.
      assert.equal(
        normalizeType(s.type.replace('[]', '')),
        normalizeType(g.type.replace('[]', '')),
        `${ctx}: type`
      );
      assert.equal(s.type.endsWith('[]'), g.type.endsWith('[]'), `${ctx}: array type marker`);
    }
    compared += 1;
  }
  assert.equal(compared, Object.keys(generated).length);
  assert.ok(compared > 250, `expected to cross-validate hundreds of messages, got ${compared}`);
});

const CUSTOM_XML = `<?xml version="1.0"?>
<mavlink>
  <version>3</version>
  <messages>
    <message id="60001" name="WIDGET_STATUS">
      <description>Custom message present in no bundled dialect.</description>
      <field type="uint16_t" name="state">State.</field>
      <field type="uint8_t" name="widget_id">Widget id.</field>
      <field type="char[16]" name="label">Label.</field>
      <extensions/>
      <field type="uint32_t" name="uptime_ms">Uptime.</field>
    </message>
  </messages>
</mavlink>
`;

/** @returns {object} compiled custom bundle */
function customBundle() {
  return compileXml({ 'widgetlink.xml': CUSTOM_XML }, 'widgetlink.xml');
}

test('custom dialect message round-trips through the real wire', () => {
  const wire = createWire({ bundle: customBundle() });
  const frame = wire.serialize(
    { name: 'WIDGET_STATUS', fields: { widget_id: 7, state: 513, label: 'ebony', uptime_ms: 42 } },
    { sysid: 255, compid: 190, seq: 3 }
  );
  assert.ok(Buffer.isBuffer(frame) && frame.length > 0);

  // Decoding proves the splitter accepted the synthesized CRC_EXTRA and the
  // parser laid fields out at the same offsets serialization used.
  const frames = wire.decode(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].name, 'WIDGET_STATUS');
  assert.equal(frames[0].sysid, 255);
  assert.equal(frames[0].compid, 190);
  assert.equal(frames[0].fields.widget_id, 7);
  assert.equal(frames[0].fields.state, 513);
  assert.equal(frames[0].fields.label, 'ebony');
  assert.equal(frames[0].fields.uptime_ms, 42);
});

test('custom dialect without includes does not inherit the MSC wire preload', () => {
  // Registry starts empty and follows bundle.files; widgetlink has no
  // <include>, so HEARTBEAT is absent until the dialect graph provides it.
  const wire = createWire({ bundle: customBundle() });
  assert.throws(
    () => wire.serialize({ name: 'HEARTBEAT', fields: {} }, { sysid: 1, compid: 1, seq: 0 }),
    /no wire class for message 'HEARTBEAT'/
  );
});

test('partial name/id collisions fail loudly; matching includes are skipped', () => {
  const bundle = customBundle();
  // Name-only collision (different id) used to silently keep the bundled class.
  assert.throws(
    () => synthesizeWireClasses(mav, bundle, {
      names: new Set(['WIDGET_STATUS']),
      ids: new Set(),
      byName: { WIDGET_STATUS: { MSG_NAME: 'WIDGET_STATUS', MSG_ID: 0, MAGIC_NUMBER: 1, PAYLOAD_LENGTH: 1 } },
    }),
    /collides with a bundled message name/
  );
  // Id-only collision.
  assert.throws(
    () => synthesizeWireClasses(mav, bundle, { names: new Set(), ids: new Set([60001]), byName: {} }),
    /collides with a bundled message id/
  );
  // Same identity + matching layout (dialect <include> of a bundled message): skip.
  const hb = mav.minimal.Heartbeat;
  const withHeartbeat = compileXml({
    'w.xml': `<?xml version="1.0"?><mavlink><version>3</version><messages>
      <message id="0" name="HEARTBEAT">
        <field type="uint32_t" name="custom_mode">x</field>
        <field type="uint8_t" name="type">t</field>
        <field type="uint8_t" name="autopilot">a</field>
        <field type="uint8_t" name="base_mode">b</field>
        <field type="uint8_t" name="system_status">s</field>
        <field type="uint8_t_mavlink_version" name="mavlink_version">v</field>
      </message>
      <message id="60001" name="WIDGET_STATUS">
        <field type="uint8_t" name="widget_id">w</field>
        <field type="uint16_t" name="state">s</field>
      </message>
    </messages></mavlink>`,
  }, 'w.xml');
  const classes = synthesizeWireClasses(mav, withHeartbeat, {
    names: new Set(['HEARTBEAT']),
    ids: new Set([0]),
    byName: { HEARTBEAT: hb },
  });
  assert.deepEqual(classes.map((c) => c.MSG_NAME), ['WIDGET_STATUS']);

  // Same identity with a redefined layout fails loudly (Greptile).
  const redefined = compileXml({
    'w.xml': `<?xml version="1.0"?><mavlink><version>3</version><messages>
      <message id="0" name="HEARTBEAT">
        <field type="uint8_t" name="only_field">different layout</field>
      </message>
    </messages></mavlink>`,
  }, 'w.xml');
  assert.throws(
    () => synthesizeWireClasses(mav, redefined, {
      names: new Set(['HEARTBEAT']),
      ids: new Set([0]),
      byName: { HEARTBEAT: hb },
    }),
    /redefines the bundled wire layout/
  );
});

test('unknown wire types fail loudly instead of guessing a size', () => {
  const bundle = customBundle();
  bundle.messages.WIDGET_STATUS.fields[0].type = 'uint128_t';
  assert.throws(
    () => buildMessageClass(mav, bundle.messages.WIDGET_STATUS),
    /unknown MAVLink wire type 'uint128_t'/
  );
});
