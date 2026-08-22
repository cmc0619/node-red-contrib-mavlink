'use strict';

/**
 * Bitmask token resolution (lib/codec/mask.js). Pins the sign handling: an
 * explicit '+' is a positive number, exactly as scalar fields read it through
 * Number() — it must resolve, not be reported "negative".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { assembleBitmask } = require('../../lib/codec/mask');

const ENUM = {
  entries: [
    { name: 'BIT_A', value: 1 },
    { name: 'BIT_B', value: 4 },
  ],
};

test("a '+'-prefixed numeric token is positive, matching scalar Number() reads", () => {
  assert.equal(assembleBitmask(ENUM, ['+5'], false, 'flags'), 5);
  assert.equal(assembleBitmask(ENUM, ['+5'], true, 'flags'), 5n);
});

test('a negative numeric token still fails as negative', () => {
  assert.throws(() => assembleBitmask(ENUM, ['-5'], false, 'flags'), /negative/);
});
