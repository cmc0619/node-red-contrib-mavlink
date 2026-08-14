'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildManualMessage, AXIS_INVALID } = require('../../lib/move');

const target = { sysid: 5, compid: 1 };

test('manual builds MANUAL_CONTROL addressed to a system, with no target_component', () => {
  // The dialect's field is `target` — a system id. There is no
  // target_component on this message, and inventing one would put a field on
  // the wire the encoder has no slot for.
  const message = buildManualMessage({ x: 0.5, y: -0.25, z: 1, r: 0, target });
  assert.equal(message.name, 'MANUAL_CONTROL');
  assert.equal(message.fields.target, 5);
  assert.ok(!('target_component' in message.fields), 'MANUAL_CONTROL has no compid');
  assert.ok(!('target_system' in message.fields), 'the field is `target`, not `target_system`');
});

test('sticks are -1..1 on the operator surface and ±1000 on the wire, scaled once', () => {
  const fields = buildManualMessage({ x: 1, y: -1, z: 0.5, r: 0, target }).fields;
  assert.equal(fields.x, 1000, 'full deflection');
  assert.equal(fields.y, -1000);
  assert.equal(fields.z, 500);
  // An explicit 0 is a commanded centre, not an absent axis — the distinction
  // the whole module turns on.
  assert.equal(fields.r, 0, 'an explicit 0 is centred, not disabled');
});

test('a blank axis is DISABLED, not centred — the ArduSub thrust hazard', () => {
  // The dialect: "A value of INT16_MAX indicates that this axis is invalid."
  // This is the safety story. The spec normalises every axis to [-1000, 1000]
  // centred on 0, but ArduSub reads z as 0..1000 with neutral 500, so a
  // helpfully-centred 0 is FULL REVERSE vertical thrust. Sending "invalid" for
  // an untouched axis sidesteps the disagreement on every firmware, with no
  // per-family axis map to guess at.
  const fields = buildManualMessage({ r: 0.5, target }).fields;
  assert.equal(fields.x, AXIS_INVALID, 'untouched pitch is disabled');
  assert.equal(fields.y, AXIS_INVALID, 'untouched roll is disabled');
  assert.equal(fields.z, AXIS_INVALID, 'untouched thrust is disabled — never a centred 0');
  assert.equal(fields.r, 500, 'the driven axis is scaled');
  assert.equal(AXIS_INVALID, 32767, 'INT16_MAX');

  for (const blank of [undefined, null, '', '   ']) {
    assert.equal(
      buildManualMessage({ z: blank, target }).fields.z,
      AXIS_INVALID,
      `blank ${JSON.stringify(blank)} disables the axis`
    );
  }
});

test('buttons: blank is 0, because "no button pressed" is a real joystick state', () => {
  // Unlike an axis, which a blank means the operator is not driving at all, a
  // blank button mask is genuinely "none held" — the state a joystick reports
  // on every frame it is idle.
  assert.equal(buildManualMessage({ target }).fields.buttons, 0);
  assert.equal(buildManualMessage({ buttons: 5, target }).fields.buttons, 5);
  assert.equal(buildManualMessage({ buttons: 65535, target }).fields.buttons, 65535);
});

test('manual does not clamp — the editor bounds the sticks, the driver scales what it is handed', () => {
  // §2: the operator surface is bounded in the dialog; the runtime coerces and
  // sends. A value past full deflection is the flow author's to see.
  assert.equal(buildManualMessage({ x: 2, target }).fields.x, 2000);
  assert.equal(buildManualMessage({ x: -3.5, target }).fields.x, -3500);
  // Non-numeric would serialize as garbage, which is a different thing.
  assert.throws(() => buildManualMessage({ x: 'left', target }), /expected a finite number/);
  assert.throws(() => buildManualMessage({ buttons: 'A', target }), /expected a finite number/);
});
