'use strict';

/**
 * Formation editor validators executed for real (fe50ee6 rule): the runtime
 * trusts the saved config, so when a runtime guard is deleted the editor
 * validator that replaced it must be run here, not grepped for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadNodeDefaults } = require('./html-assert');

test('spacing validator is the only guard: finite and > 0, blank red', () => {
  const defaults = loadNodeDefaults('mavlink-formation');
  const validate = defaults.spacing.validate;

  assert.equal(validate.call({}, 10), true);
  assert.equal(validate.call({}, '10'), true, 'numeric strings pass (text input)');
  assert.equal(validate.call({}, 0.5), true, 'sub-metre spacing is a legitimate distance');
  assert.equal(validate.call({}, 0), false, '0 stacks every vehicle on one point — a commanded collision');
  assert.equal(validate.call({}, -5), false, 'negative spacing silently mirrors the pattern');
  assert.equal(validate.call({}, ''), false, 'blank must not silently become 0');
  assert.equal(validate.call({}, 'abc'), false, 'non-numeric text reds');
});

test('timeoutMs validator requires an integer >= 1 — a saved 0 arms confirm at 0 ms', () => {
  // Same rationale as mavlink-fanout's timeoutMs: RED.validators.number()
  // accepts 0 and negatives and min="1" is not enforced on save; a saved 0
  // would report every member unconfirmed, blaming the vehicles for a config
  // bug.
  const defaults = loadNodeDefaults('mavlink-formation');
  const validate = defaults.timeoutMs.validate;

  assert.equal(validate.call({}, 1), true);
  assert.equal(validate.call({}, 10000), true);
  assert.equal(validate.call({}, 0), false, '0 ms arms the confirm wait at 0 — red');
  assert.equal(validate.call({}, ''), false, 'blank is rejected at deploy');
  assert.equal(validate.call({}, 1.5), false, 'fractional milliseconds red');
});
