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

test('closed vocabularies red on membership: shape, anchorMode, delivery (§5 editor half)', () => {
  // The runtime dispatches these tokens with affirmative cases only, so a
  // hand-edited stray deploys a node that selects no behavior — the editor is
  // the one place that can see it.
  const defaults = loadNodeDefaults('mavlink-formation');

  for (const shape of ['line', 'column', 'grid', 'wedge', 'circle', 'sphere']) {
    assert.equal(defaults.shape.validate.call({}, shape, {}), true, shape);
  }
  assert.match(String(defaults.shape.validate.call({}, 'blob', {})), /must be one of/);
  assert.match(String(defaults.shape.validate.call({}, '', {})), /must be one of/, 'blank shape reds');

  assert.equal(defaults.anchorMode.validate.call({}, 'leader', {}), true);
  assert.equal(defaults.anchorMode.validate.call({}, 'fixed', {}), true);
  assert.match(String(defaults.anchorMode.validate.call({}, 'follower', {})), /must be one of/);

  for (const tier of ['build', 'send', 'confirm']) {
    assert.equal(defaults.delivery.validate.call({}, tier, {}), true, tier);
  }
  assert.match(String(defaults.delivery.validate.call({}, 'blast', {})), /must be one of/);
});

test('fixed-anchor lat/lon red outside the ellipsoid and on blank; other modes skip', () => {
  const defaults = loadNodeDefaults('mavlink-formation');
  const onFixed = (key, v) => defaults[key].validate.call({ anchorMode: 'fixed' }, v);

  assert.equal(onFixed('lat', 47.4), true);
  assert.equal(onFixed('lat', -90), true);
  assert.equal(onFixed('lat', 91), false, 'latitude past the pole is a typo, not a position');
  assert.equal(onFixed('lat', ''), false, 'blank must not silently become null island');
  assert.equal(onFixed('lon', 179.9), true);
  assert.equal(onFixed('lon', -181), false);
  assert.equal(onFixed('lon', 'abc'), false);
  // A hidden field's stale value must not block the dialog in leader mode.
  assert.equal(defaults.lat.validate.call({ anchorMode: 'leader' }, 91), true);
  assert.equal(defaults.lon.validate.call({ anchorMode: 'leader' }, ''), true);
});

test('intervalMs requires a number >= 0 — the runtime reads a present value as Number()', () => {
  // Blank would ride as Number('') = 0 and a negative paces nothing: an
  // unthrottled fleet send either way. min="0" is not enforced on save.
  const defaults = loadNodeDefaults('mavlink-formation');
  const validate = defaults.intervalMs.validate;

  assert.equal(validate.call({}, 0), true, '0 is a legitimate no-pause interval, stated explicitly');
  assert.equal(validate.call({}, 250), true);
  assert.equal(validate.call({}, -100), false, 'negative pacing reds');
  assert.equal(validate.call({}, ''), false, 'blank reds — it would ride as 0');
  assert.equal(validate.call({}, 'abc'), false);
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
