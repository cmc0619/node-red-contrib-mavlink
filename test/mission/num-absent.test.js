'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildItemInt, buildItem } = require('../../lib/mission');

const TARGET = { sysid: 1, compid: 1 };

test('absent mission numeric fields are not invented as 0', () => {
  // Incomplete item fields pass through as NaN so packing/send can choke —
  // not silent null-island zeros (§0).
  const int = buildItemInt({ frame: 3, command: 16 }, TARGET, 0, 0);
  assert.ok(Number.isNaN(int.fields.param1));
  assert.ok(Number.isNaN(int.fields.param2));
  assert.ok(Number.isNaN(int.fields.z));
  assert.ok(Number.isNaN(int.fields.x));
  assert.ok(Number.isNaN(int.fields.y));

  const legacy = buildItem({ frame: 3, command: 16, x: 1 }, TARGET, 0, 0);
  assert.equal(legacy.fields.x, 1);
  assert.ok(Number.isNaN(legacy.fields.y));
  assert.ok(Number.isNaN(legacy.fields.z));
});
