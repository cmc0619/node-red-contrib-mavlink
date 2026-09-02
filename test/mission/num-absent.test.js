'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildItemInt, buildItem } = require('../../lib/mission');

const TARGET = { sysid: 1, compid: 1 };

test('absent mission numeric fields pass through unset — not invented as 0', () => {
  // Incomplete item fields stay undefined in the builder — do not invent 0 (§0).
  const int = buildItemInt({ frame: 3, command: 16 }, TARGET, 0, 0);
  assert.equal(int.fields.param1, undefined);
  assert.equal(int.fields.param2, undefined);
  assert.equal(int.fields.z, undefined);
  assert.equal(int.fields.x, undefined);
  assert.equal(int.fields.y, undefined);

  const legacy = buildItem({ frame: 3, command: 16, x: 1 }, TARGET, 0, 0);
  assert.equal(legacy.fields.x, 1);
  assert.equal(legacy.fields.y, undefined);
  assert.equal(legacy.fields.z, undefined);
});

test('blank mission numeric strings stay unset — Number("") must not invent 0', () => {
  const int = buildItemInt({ frame: 3, command: 16, param1: '', z: '   ' }, TARGET, 0, 0);
  assert.equal(int.fields.param1, undefined);
  assert.equal(int.fields.z, undefined);
  const legacy = buildItem({ frame: 3, command: 16, y: '', z: null }, TARGET, 0, 0);
  assert.equal(legacy.fields.y, undefined);
  assert.equal(legacy.fields.z, null);
});

test('a blank or null mission frame rides as given — the pack refuses it, the builder does not', () => {
  const blank = buildItemInt(
    { frame: '', command: 16, x: 47.4, y: 8.5, z: 10 },
    TARGET,
    0,
    0
  );
  assert.equal(blank.fields.frame, '');
  const nullFrame = buildItemInt(
    { frame: null, command: 16, x: 1.5, y: 2.5 },
    TARGET,
    0,
    0
  );
  assert.equal(nullFrame.fields.frame, null);
});
