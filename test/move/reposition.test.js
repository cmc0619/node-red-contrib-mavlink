'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRepositionMessage } = require('../../lib/move');

const target = { sysid: 5, compid: 1 };
const goodPosition = { lat: 47.1234567, lon: 8.5, alt: 25 };

/** A valid reposition input; override per test. */
function input(overrides = {}) {
  return {
    mode: 'position',
    frame: 3,
    target,
    position: goodPosition,
    ...overrides,
  };
}



test('reposition coerces the frame it is handed and never substitutes one', () => {
  // The Action surface derives GLOBAL (0) or GLOBAL_RELATIVE_ALT (3) for this
  // carrier; the editor is what keeps a local frame off it. A frame that does
  // not coerce rides non-finite rather than being replaced with a legal number.
  assert.equal(buildRepositionMessage(input({ frame: 0 })).fields.frame, 0);
  assert.equal(buildRepositionMessage(input({ frame: 7 })).fields.frame, 7);
  for (const frame of [undefined, 'WARP', '', '   ']) {
    const message = buildRepositionMessage(input({ frame }));
    assert.ok(!Number.isFinite(message.fields.frame), `frame ${JSON.stringify(frame)} stays unresolved`);
  }
});
