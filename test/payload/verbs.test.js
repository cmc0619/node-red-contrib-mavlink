'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAYLOAD_TOPICS,
  PAYLOAD_VERBS,
  verbsForTopic,
  buildPayloadMessage,
  fieldMetaFromBundle,
} = require('../../lib/payload');

/** Verbs accepted by buildPayloadMessage per topic (gimbal aim uses legacy path). */
const KNOWN_VERBS = {
  camera: ['photo', 'start-video', 'stop-video', 'set-mode', 'trigger-distance'],
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

test('verbsForTopic returns catalog entries and empty for unknown topics', () => {
  assert.deepEqual(verbsForTopic('camera'), PAYLOAD_VERBS.camera);
  assert.deepEqual(verbsForTopic('unknown'), []);
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

test('gimbal roi-set refuses a blank coordinate rather than aiming at 0,0 (#88)', () => {
  // buildPayloadMessage used to default lat/lon/alt to 0, so an operator who
  // left a field blank pointed the camera at the Gulf of Guinea with no error.
  const base = {
    topic: 'gimbal',
    verb: 'roi-set',
    target: { sysid: 1, compid: 1 },
    carrier: 'long',
  };

  for (const [missing, values] of [
    ['lat', { lon: 8.5, alt: 30 }],
    ['lon', { lat: 47.4, alt: 30 }],
    ['alt', { lat: 47.4, lon: 8.5 }],
  ]) {
    assert.throws(
      () => buildPayloadMessage({ ...base, values }),
      new RegExp(`${missing} is required`),
      `blank ${missing} must refuse`
    );
  }

  // An explicit 0 is a real coordinate and still sends — the guard is against
  // silence, not against the equator.
  const built = buildPayloadMessage({ ...base, values: { lat: 0, lon: 0, alt: 0 } });
  assert.equal(built.message.fields.param5, 0);
  assert.equal(built.message.fields.param6, 0);
});

test('whitespace is blank for a required ROI coordinate (#141)', () => {
  // The pre-#141 presence check treated ' ' as a value and Number(' ') is 0,
  // so a whitespace latitude slipped past the required check and aimed at the
  // equator. slotValue now refuses via the shared isBlank sentinel.
  for (const blank of [' ', '   ', '\t']) {
    assert.throws(
      () => buildPayloadMessage({
        topic: 'gimbal',
        verb: 'roi-set',
        target: { sysid: 1, compid: 1 },
        carrier: 'long',
        values: { lat: blank, lon: 8.5, alt: 30 },
      }),
      /lat is required/,
      `${JSON.stringify(blank)} must refuse`
    );
  }
});
