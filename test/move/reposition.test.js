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
  // The Action surface derives GLOBAL (0), GLOBAL_RELATIVE_ALT (3) or
  // GLOBAL_TERRAIN_ALT (10) for this carrier; the editor is what keeps a local
  // frame off it. A frame that does not coerce rides non-finite rather than
  // being replaced with a legal number.
  assert.equal(buildRepositionMessage(input({ frame: 0 })).fields.frame, 0);
  assert.equal(buildRepositionMessage(input({ frame: 10 })).fields.frame, 10);
  assert.equal(buildRepositionMessage(input({ frame: 7 })).fields.frame, 7);
  for (const frame of [undefined, 'WARP', '', '   ']) {
    const message = buildRepositionMessage(input({ frame }));
    assert.ok(!Number.isFinite(message.fields.frame), `frame ${JSON.stringify(frame)} stays unresolved`);
  }
});

test('GCS parity: blank reposition speed and yaw encode the spec sentinels (#240)', () => {
  // QGC/MAVSDK transmit speed -1 (vehicle default) and yaw NaN (current
  // heading mode) for unspecified fields; a zero-fill would command 0 m/s and
  // yaw-to-north on every goto. Radius 0 is the spec's "ignore".
  const blank = buildRepositionMessage(input()).fields;
  assert.equal(blank.param1, -1, 'blank speed encodes -1 (vehicle default)');
  assert.equal(blank.param3, 0, 'blank radius encodes 0 (ignored)');
  assert.ok(Number.isNaN(blank.param4), 'blank yaw encodes NaN (keep current heading mode)');

  // Explicit values — including 0 — are typed and win over the sentinels.
  const explicit = buildRepositionMessage(input({ speed: 5, yaw: 0 })).fields;
  assert.equal(explicit.param1, 5);
  assert.equal(explicit.param4, 0, 'an explicit 0 yaw is a command to heading 0');
});
