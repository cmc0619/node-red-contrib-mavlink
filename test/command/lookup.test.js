'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { commandByValue } = require('../../lib/command');

test('commandByValue finds commands by numeric or string value', () => {
  const command = { name: 'MAV_CMD_FIXTURE', value: '400' };
  const bundle = { commands: { MAV_CMD_FIXTURE: command } };

  assert.equal(commandByValue(bundle, 400), command);
  assert.equal(commandByValue(bundle, '400'), command);
});

test('commandByValue returns null for absent bundles and unknown commands', () => {
  assert.equal(commandByValue(null, 400), null);
  assert.equal(commandByValue({ commands: {} }, 400), null);
});
