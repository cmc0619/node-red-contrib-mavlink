'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAYLOAD_TOPICS,
  PAYLOAD_VERBS,
  verbsForTopic,
  buildPayloadMessage,
} = require('../../lib/payload');

/** Verbs accepted by buildPayloadMessage per topic (gimbal aim uses legacy path). */
const KNOWN_VERBS = {
  camera: ['photo', 'start-video', 'stop-video', 'set-mode', 'trigger-distance'],
  gimbal: ['aim', 'set-mode', 'roi-set', 'roi-clear'],
  servo: ['set', 'repeat'],
  release: ['gripper', 'winch', 'parachute'],
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
      if (topic === 'gimbal' && verb === 'roi-set') {
        // Required — blank must not become 0,0 (issue #88).
        input.values = { lat: -35, lon: 149, alt: 50 };
      }
      assert.doesNotThrow(() => buildPayloadMessage(input), `${topic}/${verb}`);
    }
  }
});
