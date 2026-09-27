'use strict';

/**
 * settleAck — the one AckWaiter-outcome classification Command, Move and
 * Payload share (review R51/R53): one result vocabulary, output 0 carrying
 * the record, `unconfirmed` for silence.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { settleAck } = require('../../lib/command/ack');

function harness() {
  const h = { sent: [], statuses: [], doneArgs: null };
  h.node = { type: 'mavlink-test', status: (s) => h.statuses.push(s) };
  h.send = (m) => h.sent.push(m);
  h.done = (...args) => { h.doneArgs = args; };
  return h;
}

const outcome = (over) => ({
  result: 'accepted',
  resultCode: 0,
  resultParam2: 0,
  confirmedBy: 'ack',
  retries: 0,
  elapsed: 12,
  detail: null,
  ...over,
});

test('settleAck: accepted emits the record on both outputs', () => {
  const h = harness();
  settleAck(h.node, h.send, h.done, outcome(), { label: 'Arm', fields: { command: 'X' } });
  const [[out0, out1]] = h.sent;
  assert.equal(out1.result, 'accepted');
  assert.equal(out1.node, 'mavlink-test');
  assert.equal(out1.command, 'X');
  assert.equal(out0.payload, out1, 'output 0 carries the record');
  assert.equal(h.statuses[0].text, 'Arm accepted');
  assert.deepEqual(h.doneArgs, []);
});

test('settleAck: accepted hands the record to onAccepted, which owns done', async () => {
  const h = harness();
  let handed;
  await settleAck(h.node, h.send, h.done, outcome(), {
    label: 'Arm',
    fields: {},
    onAccepted: async (record) => { handed = record; },
  });
  assert.equal(handed.result, 'accepted');
  assert.equal(h.sent.length, 0);
  assert.equal(h.doneArgs, null);
});

test('settleAck: silence reports unconfirmed on output 1, and output 0 only when continuing', () => {
  const quiet = harness();
  settleAck(quiet.node, quiet.send, quiet.done, outcome({ result: 'timeout', resultCode: null }), {
    label: 'Go', fields: {},
  });
  assert.equal(quiet.sent[0][0], null);
  assert.equal(quiet.sent[0][1].result, 'unconfirmed');
  assert.equal(quiet.statuses[0].text, 'Go unconfirmed');

  const cont = harness();
  settleAck(cont.node, cont.send, cont.done, outcome({ result: 'timeout', resultCode: null }), {
    label: 'Go', fields: {}, continueUnconfirmed: true,
  });
  assert.equal(cont.sent[0][0].payload.result, 'unconfirmed');
});

test('settleAck: any other terminal is its MAV_RESULT name on output 1 only', () => {
  const h = harness();
  settleAck(h.node, h.send, h.done, outcome({ result: 'denied', resultCode: 2 }), { label: 'Arm', fields: {} });
  assert.equal(h.sent[0][0], null);
  assert.equal(h.sent[0][1].result, 'denied');
  assert.equal(h.sent[0][1].resultCode, 2);
  assert.equal(h.statuses[0].fill, 'red');
  assert.deepEqual(h.doneArgs, []);
});
