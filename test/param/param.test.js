'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { paramValueToWire } = require('../../lib/codec');
const {
  buildParamMessage,
  matchesParamEcho,
  createParamListCollector,
  resolveParamEncoding,
  PARAM_ENCODING,
  CAP_PARAM_ENCODE_BYTEWISE,
  CAP_PARAM_ENCODE_C_CAST,
} = require('../../lib/param');

test('PARAM_SET for PX4 integer params writes the int bits into the float slot', () => {
  const message = buildParamMessage({
    action: 'set',
    target: { sysid: 1, compid: 1 },
    paramId: 'MIS_TAKEOFF_ALT',
    value: 42,
    paramType: 'MAV_PARAM_TYPE_INT32',
    firmware: 'px4',
  });

  assert.equal(message.name, 'PARAM_SET');
  assert.equal(message.fields.param_id, 'MIS_TAKEOFF_ALT');
  assert.equal(message.fields.param_type, 6);
  assert.equal(message.fields.param_value, paramValueToWire(42, 'MAV_PARAM_TYPE_INT32'));
});

test('Param set confirms only by matching PARAM_VALUE echo, decoded through the PX4 union', () => {
  const request = {
    paramId: 'MIS_TAKEOFF_ALT',
    value: 42,
    paramType: 'MAV_PARAM_TYPE_INT32',
    firmware: 'px4',
  };
  const echo = {
    name: 'PARAM_VALUE',
    sysid: 1,
    compid: 1,
    fields: {
      param_id: 'MIS_TAKEOFF_ALT\u0000\u0000',
      param_type: 6,
      param_value: paramValueToWire(42, 'MAV_PARAM_TYPE_INT32'),
    },
  };

  assert.equal(matchesParamEcho(request, echo), true);
  assert.equal(matchesParamEcho({ ...request, value: 43 }, echo), false);
  assert.equal(matchesParamEcho(request, { ...echo, fields: { ...echo.fields, param_id: 'OTHER' } }), false);
});

test('PARAM_VALUE echo from another vehicle does not confirm a scoped set', () => {
  const request = {
    target: { sysid: 6, compid: 1 },
    paramId: 'FOO',
    value: 12,
    paramType: 'MAV_PARAM_TYPE_REAL32',
    firmware: 'ardupilot',
  };
  const fields = { param_id: 'FOO', param_type: 9, param_value: 12 };

  // Correct source (sysid 6) confirms.
  assert.equal(matchesParamEcho(request, { name: 'PARAM_VALUE', sysid: 6, compid: 1, fields }), true);
  // A matching id/value from another system (sysid 2) must not confirm.
  assert.equal(matchesParamEcho(request, { name: 'PARAM_VALUE', sysid: 2, compid: 1, fields }), false);
  // Wrong component on the right system is also rejected.
  assert.equal(matchesParamEcho(request, { name: 'PARAM_VALUE', sysid: 6, compid: 5, fields }), false);
});

test('PARAM_REQUEST_READ and PARAM_REQUEST_LIST build their distinct messages', () => {
  const read = buildParamMessage({
    action: 'read',
    target: { sysid: 9, compid: 1 },
    paramId: 'SYSID_THISMAV',
  });
  const list = buildParamMessage({
    action: 'request-list',
    target: { sysid: 9, compid: 1 },
  });

  assert.deepEqual(read, {
    name: 'PARAM_REQUEST_READ',
    fields: {
      target_system: 9,
      target_component: 1,
      param_id: 'SYSID_THISMAV',
      param_index: -1,
    },
  });
  assert.deepEqual(list, {
    name: 'PARAM_REQUEST_LIST',
    fields: { target_system: 9, target_component: 1 },
  });
});

test('resolveParamEncoding: explicit override wins over capabilities and firmware', () => {
  assert.equal(
    resolveParamEncoding({
      encoding: 'c-cast',
      capabilities: CAP_PARAM_ENCODE_BYTEWISE,
      firmware: 'px4',
    }),
    PARAM_ENCODING.C_CAST
  );
  assert.equal(
    resolveParamEncoding({
      encoding: 'bytewise',
      capabilities: CAP_PARAM_ENCODE_C_CAST,
      firmware: 'ardupilot',
    }),
    PARAM_ENCODING.BYTEWISE
  );
});

test('resolveParamEncoding: capabilities beat firmware when no explicit override', () => {
  assert.equal(
    resolveParamEncoding({
      capabilities: CAP_PARAM_ENCODE_BYTEWISE,
      firmware: 'ardupilot',
    }),
    PARAM_ENCODING.BYTEWISE
  );
  assert.equal(
    resolveParamEncoding({
      capabilities: CAP_PARAM_ENCODE_C_CAST,
      firmware: 'px4',
    }),
    PARAM_ENCODING.C_CAST
  );
});

test('resolveParamEncoding: firmware fallback when capabilities absent', () => {
  assert.equal(resolveParamEncoding({ firmware: 'px4' }), PARAM_ENCODING.BYTEWISE);
  assert.equal(resolveParamEncoding({ firmware: 'ardupilot' }), PARAM_ENCODING.C_CAST);
  assert.equal(resolveParamEncoding({}), PARAM_ENCODING.C_CAST);
});

test('PARAM_SET uses capability bitwise encoding even when firmware says ardupilot', () => {
  const message = buildParamMessage({
    action: 'set',
    target: { sysid: 1, compid: 1 },
    paramId: 'FOO',
    value: 42,
    paramType: 'MAV_PARAM_TYPE_INT32',
    firmware: 'ardupilot',
    capabilities: CAP_PARAM_ENCODE_BYTEWISE,
  });
  assert.equal(message.fields.param_value, paramValueToWire(42, 'MAV_PARAM_TYPE_INT32'));
});

test('PARAM_SET explicit c-cast overrides PX4 firmware', () => {
  const message = buildParamMessage({
    action: 'set',
    target: { sysid: 1, compid: 1 },
    paramId: 'FOO',
    value: 42,
    paramType: 'MAV_PARAM_TYPE_INT32',
    firmware: 'px4',
    encoding: 'c-cast',
  });
  assert.equal(message.fields.param_value, 42);
});

test('request-list collector emits a complete ordered parameter snapshot', () => {
  const collector = createParamListCollector();
  assert.equal(
    collector.accept({
      name: 'PARAM_VALUE',
      fields: { param_id: 'B', param_index: 1, param_count: 2, param_value: 2, param_type: 9 },
    }),
    null
  );
  const complete = collector.accept({
    name: 'PARAM_VALUE',
    fields: { param_id: 'A', param_index: 0, param_count: 2, param_value: 1, param_type: 9 },
  });

  assert.deepEqual(
    complete.map((p) => p.paramId),
    ['A', 'B']
  );
});
