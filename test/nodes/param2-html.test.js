'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('mavlink-param2 is a separately registered Param node using Node-RED autocomplete', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'nodes', 'mavlink-param2.html'),
    'utf8'
  );
  assert.match(html, /RED\.nodes\.registerType\('mavlink-param2'/);
  assert.match(html, /paletteLabel:\s*'param 2'/);
  assert.match(html, /#node-input-paramId'\)\.autoComplete\(\{/);
  assert.doesNotMatch(html, /mav-param-results/);

  const types = {};
  require('../../nodes/mavlink-param2')({
    nodes: { registerType: (name, ctor) => { types[name] = ctor; } },
  });
  assert.equal(typeof types['mavlink-param2'], 'function');
  assert.equal(types['mavlink-param'], undefined);
});
