'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAYLOAD_TOPICS,
  PAYLOAD_VERBS,
  buildPayloadMessage,
  fieldMetaFromBundle,
} = require('../../lib/payload');

/** Verbs accepted by buildPayloadMessage per topic (gimbal aim uses legacy path). */
const KNOWN_VERBS = {
  camera: ['photo', 'stop-photo', 'start-video', 'stop-video', 'set-mode', 'trigger-distance'],
  gimbal: ['aim', 'set-mode', 'roi-set', 'roi-clear'],
  servo: ['set', 'repeat'],
  gripper: ['operate'],
  winch: ['operate'],
  parachute: ['operate'],
};

test('PAYLOAD_TOPICS lists every payload topic', () => {
  assert.deepEqual(PAYLOAD_TOPICS, Object.keys(KNOWN_VERBS));
});

test('PAYLOAD_VERBS catalog matches known verbs per topic', () => {
  for (const topic of PAYLOAD_TOPICS) {
    const values = PAYLOAD_VERBS[topic].map((v) => v.value);
    const labels = PAYLOAD_VERBS[topic].map((v) => v.label);
    assert.deepEqual(values, KNOWN_VERBS[topic], `${topic} verb list drift`);
    assert.equal(new Set(labels).size, labels.length, `${topic} labels must be unique`);
    for (const entry of PAYLOAD_VERBS[topic]) {
      assert.match(entry.label, /\S/, `${topic}/${entry.value} needs a label`);
    }
  }
});

test('every catalog verb builds without error', () => {
  for (const topic of PAYLOAD_TOPICS) {
    for (const { value: verb } of PAYLOAD_VERBS[topic]) {
      const input = {
        topic,
        verb,
        target: { sysid: 1, compid: 1 },
        values: {},
        carrier: 'long',
      };
      if (topic === 'gimbal' && verb === 'aim') {
        input.path = 'legacy';
      }
      // roi-set is the one verb whose coordinates are required rather than
      // defaulted — a blank ROI must fail loud rather than aim at 0,0 (§10).
      // Supply them so this still exercises the build path.
      if (topic === 'gimbal' && verb === 'roi-set') {
        input.values = { lat: 47.397742, lon: 8.545594, alt: 30 };
      }
      assert.doesNotThrow(() => buildPayloadMessage(input), `${topic}/${verb}`);
    }
  }
});

test('shared field keys map to colliding enum families, so a stashed id must not cross verbs', () => {
  // `mode` and `action` are one row key each, reused across verbs that resolve
  // to different enums — and every one of those enums starts at 0. A dialog
  // that carries a stashed id across a verb switch silently reinterprets it:
  // gripper HOLD (2) arrives preselected as PARACHUTE_RELEASE (2).
  //
  // This is why `mavlink-payload.html` keys its saved-value lookup on the enum
  // family (`savedForEnum`) rather than the field name. Any replacement dialog
  // has to do the same; the shape of the form is not enough.
  const metadata = require('../../lib/metadata');
  const bundle = metadata.loadBundled('ardupilotmega');
  const catalog = metadata.catalogFromBundle(bundle);

  const sharedKeys = {
    mode: ['camera|set-mode|', 'gimbal|set-mode|'],
    action: ['gripper|operate|', 'winch|operate|', 'parachute|operate|'],
  };

  for (const [key, recipeKeys] of Object.entries(sharedKeys)) {
    const families = recipeKeys.map((recipeKey) => {
      const meta = fieldMetaFromBundle(bundle, ...recipeKey.split('|'));
      assert.ok(meta[key], `${recipeKey} renders a ${key} row`);
      assert.ok(meta[key].enum, `${recipeKey} ${key} is enum-backed`);
      return meta[key].enum;
    });

    assert.equal(
      new Set(families).size,
      families.length,
      `${key} resolves to a distinct enum per verb: ${families.join(', ')}`
    );

    // The collision that makes carrying a value across them unsafe.
    const zeroBased = families.filter((name) =>
      (catalog.enums[name] || []).some((entry) => Number(entry.value) === 0)
    );
    assert.equal(
      zeroBased.length,
      families.length,
      `every ${key} family starts at 0, so ids overlap: ${families.join(', ')}`
    );
  }
});

test('gimbal roi-set coerces a blank coordinate — the editor is what reds it (#88)', () => {
  // A blank lat/lon/alt takes the slot's fallback and rides: DO_SET_ROI_LOCATION
  // has no sentinel for an unset coordinate, so the *editor* requires all
  // three (mavlink-payload.html `values`, REQUIRED_VALUES) and the driver
  // sends what it is handed (§0).
  const base = {
    topic: 'gimbal',
    verb: 'roi-set',
    target: { sysid: 1, compid: 1 },
    carrier: 'long',
  };
  const blank = buildPayloadMessage({ ...base, values: { lon: 8.5, alt: 30 } });
  assert.equal(blank.message.fields.param5, 0, 'the blank slot takes the recipe fallback');
  assert.equal(blank.message.fields.param6, 8.5);

  // The slot still carries `required` — as metadata for the dialog.
  const { PAYLOAD_RECIPES } = require('../../lib/payload');
  assert.ok(PAYLOAD_RECIPES['gimbal|roi-set|'].params[4].required);

  // An explicit 0 is a real coordinate and still sends — the guard is against
  // silence, not against the equator.
  const built = buildPayloadMessage({ ...base, values: { lat: 0, lon: 0, alt: 0 } });
  assert.equal(built.message.fields.param5, 0);
  assert.equal(built.message.fields.param6, 0);
});

test('an explicit NaN rate rides onto the wire — a legal float, not an error', () => {
  // GIMBAL_MANAGER_SET_PITCHYAW selects angle vs rate control by NaN-ing the
  // unused pair; the dialect marks all four fields invalid=NaN. A driver never
  // refuses trusted input, so NaN passes through as the value it is.
  const built = buildPayloadMessage({
    topic: 'gimbal',
    verb: 'aim',
    path: 'manager',
    target: { sysid: 1, compid: 1 },
    values: { pitch: 15, pitchRate: NaN },
  });
  assert.equal(built.message.name, 'GIMBAL_MANAGER_SET_PITCHYAW');
  assert.equal(built.message.fields.pitch, 15);
  assert.ok(Number.isNaN(built.message.fields.pitch_rate), 'pitch_rate carries NaN');
});

test('an unparseable value coerces to NaN and still builds (driver rule)', () => {
  // Blank falls back; anything else is Number()'d. 'abc' is not blank, so the
  // field carries Number('abc') = NaN rather than a throw.
  const built = buildPayloadMessage({
    topic: 'gimbal',
    verb: 'aim',
    path: 'manager',
    target: { sysid: 1, compid: 1 },
    values: { pitch: 'abc' },
  });
  assert.ok(Number.isNaN(built.message.fields.pitch), 'pitch carries NaN');
});

test('carrier dispatch is affirmative: only CARRIER members select a builder (§5, §9)', () => {
  const base = {
    topic: 'servo',
    verb: 'set',
    target: { sysid: 1, compid: 1 },
    values: {},
  };
  assert.equal(buildPayloadMessage({ ...base, carrier: 'int' }).message.name, 'COMMAND_INT');
  assert.equal(buildPayloadMessage({ ...base, carrier: 'long' }).message.name, 'COMMAND_LONG');
  // A non-member selects no builder: `message` ships undefined and craters at
  // the tier that touches it — never a silent LONG for a carrier nobody chose.
  assert.equal(buildPayloadMessage({ ...base, carrier: 'bogus' }).message, undefined);
});

test('whitespace is blank for an ROI coordinate — it takes the fallback, not Number(\' \')', () => {
  // Number(' ') is a finite 0, so without the shared isBlank sentinel a
  // whitespace latitude would read as a *commanded* equator rather than an
  // unset slot. It still reaches the wire as the fallback — the editor is
  // what refuses it — but it must not read as a value the operator typed.
  for (const ws of [' ', '   ', '\t']) {
    const built = buildPayloadMessage({
      topic: 'gimbal',
      verb: 'roi-set',
      target: { sysid: 1, compid: 1 },
      carrier: 'long',
      values: { lat: ws, lon: 8.5, alt: 30 },
    });
    assert.equal(built.message.fields.param5, 0, `${JSON.stringify(ws)} is blank`);
  }
});
