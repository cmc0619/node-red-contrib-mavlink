'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mav = require('node-mavlink');
const { loadBundled, compileXml } = require('../../lib/metadata');
const { normalizeType } = require('../../lib/codec/types');
const { buildMessageClass } = require('../../lib/connection/wire-classes');
const { createWire } = require('../../lib/connection/wire');

/**
 * Default field bag for a round-trip pin — zeros / empty arrays / empty string.
 * 64-bit kinds use BigInt so node-mavlink serializers accept them.
 *
 * @param {object} message  bundle message metadata
 * @returns {Object<string, *>}
 */
function defaultFields(message) {
  const fields = {};
  for (const f of message.fields) {
    const t = normalizeType(f.type);
    if (t === 'char') {
      fields[f.name] = f.arrayLength ? '' : '\0';
    } else if (f.arrayLength) {
      fields[f.name] = [];
    } else if (t === 'int64_t' || t === 'uint64_t') {
      fields[f.name] = 0n;
    } else {
      fields[f.name] = 0;
    }
  }
  return fields;
}

/**
 * The golden pin: every message in the seeded ardupilotmega dialect must
 * serialize and decode through a wire built only from synthesized classes
 * (no mavlink-mappings REGISTRY preload). Layout/CRC mistakes fail here.
 */
test('every seeded ardupilotmega message round-trips through synthesized wire classes', () => {
  const bundle = loadBundled('ardupilotmega');
  const wire = createWire({ bundle });
  let compared = 0;
  for (const message of Object.values(bundle.messages)) {
    const frame = wire.serialize(
      { name: message.name, fields: defaultFields(message) },
      { sysid: 1, compid: 1, seq: compared & 0xff }
    );
    assert.ok(Buffer.isBuffer(frame) && frame.length > 0, `${message.name}: empty frame`);
    const decoded = wire.decode(frame);
    assert.equal(decoded.length, 1, `${message.name}: decode count`);
    assert.equal(decoded[0].name, message.name, `${message.name}: name`);
    compared += 1;
  }
  assert.ok(compared > 250, `expected hundreds of seeded messages, got ${compared}`);
});

/**
 * Where the older mavlink-mappings generator still has a class and the seeded
 * XML has not drifted that message's layout, layouts must match. Drift (seed
 * ahead of the npm generator) is skipped — the seed is authority.
 */
test('synthesized layout matches mavlink-mappings when the seed has not drifted', () => {
  const bundle = loadBundled('ardupilotmega');
  let compared = 0;
  let skipped = 0;
  for (const name of ['minimal', 'standard', 'common', 'ardupilotmega']) {
    for (const gen of Object.values((mav[name] && mav[name].REGISTRY) || {})) {
      const meta = bundle.messages[gen.MSG_NAME];
      if (!meta) {
        skipped += 1;
        continue;
      }
      const synth = buildMessageClass(mav, meta);
      if (synth.PAYLOAD_LENGTH !== gen.PAYLOAD_LENGTH || synth.FIELDS.length !== gen.FIELDS.length) {
        skipped += 1;
        continue;
      }
      assert.equal(synth.MSG_ID, gen.MSG_ID, `${gen.MSG_NAME}: MSG_ID`);
      assert.equal(synth.MAGIC_NUMBER, gen.MAGIC_NUMBER, `${gen.MSG_NAME}: MAGIC_NUMBER`);
      compared += 1;
    }
  }
  assert.ok(compared > 200, `expected many still-matching messages, got ${compared} (skipped ${skipped})`);
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

test('unknown wire types fail loudly instead of guessing a size', () => {
  const bundle = customBundle();
  bundle.messages.WIDGET_STATUS.fields[0].type = 'uint128_t';
  assert.throws(
    () => buildMessageClass(mav, bundle.messages.WIDGET_STATUS),
    /unknown MAVLink wire type 'uint128_t'/
  );
});
