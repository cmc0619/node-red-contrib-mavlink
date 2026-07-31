'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { paramValueToWire, paramValueFromWire } = require('../../lib/codec');
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

test('resolveParamEncoding: known firmware when capabilities absent; missing fails loud', () => {
  assert.equal(resolveParamEncoding({ firmware: 'px4' }), PARAM_ENCODING.BYTEWISE);
  assert.equal(resolveParamEncoding({ firmware: 'ardupilot' }), PARAM_ENCODING.C_CAST);
  assert.throws(() => resolveParamEncoding({}), /param encoding unresolved/);
});

test('resolveParamEncoding: present-but-invalid override rejects (no silent fallthrough)', () => {
  assert.throws(
    () => resolveParamEncoding({
      encoding: 'bitwise',
      capabilities: CAP_PARAM_ENCODE_BYTEWISE,
      firmware: 'px4',
    }),
    /unsupported param encoding/
  );
  assert.throws(
    () => buildParamMessage({
      action: 'set',
      target: { sysid: 1, compid: 1 },
      paramId: 'FOO',
      value: 1,
      paramType: 'MAV_PARAM_TYPE_INT32',
      encoding: 'nope',
      firmware: 'ardupilot',
    }),
    /unsupported param encoding/
  );
  // Absent / empty override still falls through.
  assert.equal(
    resolveParamEncoding({ encoding: '', firmware: 'px4' }),
    PARAM_ENCODING.BYTEWISE
  );
  assert.equal(
    resolveParamEncoding({ encoding: null, firmware: 'ardupilot' }),
    PARAM_ENCODING.C_CAST
  );
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

test('echo decodes by the vehicle-declared param_type, not the request type', () => {
  // Reproduces SITL 13 (live ArduPilot): the example sets ARMING_CHECK — an
  // integer parameter on the vehicle — through a node configured REAL32. The
  // vehicle applies the set and echoes bytewise with its own type (INT16), so
  // decoding by the request's REAL32 reads the int bits as a denormal float and
  // the confirm tier reported "echo timeout" for a set that had succeeded.
  const request = {
    target: { sysid: 1, compid: 1 },
    paramId: 'ARMING_CHECK',
    value: 1,
    paramType: 'MAV_PARAM_TYPE_REAL32',
    firmware: 'ardupilot',
    capabilities: CAP_PARAM_ENCODE_BYTEWISE,
  };
  const echo = {
    name: 'PARAM_VALUE',
    sysid: 1,
    compid: 1,
    fields: {
      param_id: 'ARMING_CHECK',
      param_type: 4, // MAV_PARAM_TYPE_INT16 — what the vehicle actually reports
      param_value: paramValueToWire(1, 'MAV_PARAM_TYPE_INT16'),
    },
  };

  assert.equal(matchesParamEcho(request, echo), true);

  // Still discriminating: a different value must not confirm.
  assert.equal(
    matchesParamEcho(request, {
      ...echo,
      fields: { ...echo.fields, param_value: paramValueToWire(2, 'MAV_PARAM_TYPE_INT16') },
    }),
    false
  );

  // A frame carrying no usable type falls back to the request's type.
  assert.equal(
    matchesParamEcho(
      { ...request, paramType: 'MAV_PARAM_TYPE_INT16' },
      { ...echo, fields: { ...echo.fields, param_type: 0 } }
    ),
    true
  );
});

test('REAL32 echo confirms at float32 precision, not absolute 1e-6', () => {
  // The vehicle stores a REAL32 param as float32, so the echo is the float32
  // quantization of what was sent: 47.9 returns as 47.900001525878906, 1.5e-6
  // away. An absolute 1e-6 tolerance called that a mismatch and timed out a set
  // that had succeeded.
  const request = {
    target: { sysid: 1, compid: 1 },
    paramId: 'WPNAV_SPEED',
    value: 47.9,
    paramType: 'MAV_PARAM_TYPE_REAL32',
    firmware: 'ardupilot',
  };
  const quantized = Math.fround(47.9);
  assert.notEqual(quantized, 47.9, 'guard: 47.9 must not be exact in float32');
  assert.ok(Math.abs(quantized - 47.9) > 1e-6, 'guard: the gap must exceed the old tolerance');

  assert.equal(
    matchesParamEcho(request, {
      name: 'PARAM_VALUE',
      sysid: 1,
      compid: 1,
      fields: { param_id: 'WPNAV_SPEED', param_type: 9, param_value: quantized },
    }),
    true
  );

  // A genuinely different value is still rejected.
  assert.equal(
    matchesParamEcho(request, {
      name: 'PARAM_VALUE',
      sysid: 1,
      compid: 1,
      fields: { param_id: 'WPNAV_SPEED', param_type: 9, param_value: Math.fround(48.1) },
    }),
    false
  );
});

test('bytewise integer echo compares exactly — float32 tolerance must not confirm a different value', () => {
  // Above 2^24 consecutive integers collide under Math.fround, so a float32
  // comparison would confirm a stored value the operator did not ask for. A
  // bytewise integer echo carries the vehicle's exact bits, so nothing was
  // quantized in transit and there is no tolerance to grant.
  const request = {
    target: { sysid: 1, compid: 1 },
    paramId: 'BIG_MASK',
    value: 16777217,
    paramType: 'MAV_PARAM_TYPE_UINT32',
    capabilities: CAP_PARAM_ENCODE_BYTEWISE,
  };
  const echoOf = (stored) => ({
    name: 'PARAM_VALUE',
    sysid: 1,
    compid: 1,
    fields: {
      param_id: 'BIG_MASK',
      param_type: 5, // MAV_PARAM_TYPE_UINT32
      param_value: paramValueToWire(stored, 'MAV_PARAM_TYPE_UINT32'),
    },
  });

  assert.equal(Math.fround(16777217), Math.fround(16777216), 'guard: these collide in float32');

  // The vehicle stored a different value — must NOT confirm.
  assert.equal(matchesParamEcho(request, echoOf(16777216)), false);
  // The vehicle stored what was asked — must confirm.
  assert.equal(matchesParamEcho(request, echoOf(16777217)), true);
});

test('REAL32 echo keeps float32 tolerance even on a bytewise vehicle', () => {
  // The exact-wire rule is scoped to integer types: a REAL32 parameter is a
  // float32 on the vehicle whatever the encoding, so its echo is still
  // quantized and still needs the tolerance.
  const request = {
    target: { sysid: 1, compid: 1 },
    paramId: 'MPC_XY_P',
    value: 47.9,
    paramType: 'MAV_PARAM_TYPE_REAL32',
    capabilities: CAP_PARAM_ENCODE_BYTEWISE,
  };
  assert.equal(
    matchesParamEcho(request, {
      name: 'PARAM_VALUE',
      sysid: 1,
      compid: 1,
      fields: {
        param_id: 'MPC_XY_P',
        param_type: 9,
        param_value: paramValueToWire(Math.fround(47.9), 'MAV_PARAM_TYPE_REAL32'),
      },
    }),
    true
  );
});

test('exact-wire comparison is strict — a near-integer request does not confirm an integer echo', () => {
  // CodeRabbit's case: with the tolerance ordered ahead of the exact-wire guard,
  // an echo of 1 confirmed a request of 1.0000005. Unreachable through the send
  // path (the codec rejects a non-integer for an integer type at encode time,
  // below) but the matcher must not depend on that to be correct.
  assert.throws(
    () =>
      buildParamMessage({
        action: 'set',
        paramId: 'X',
        value: 1.0000005,
        paramType: 'MAV_PARAM_TYPE_UINT32',
        capabilities: CAP_PARAM_ENCODE_BYTEWISE,
        target: { sysid: 1, compid: 1 },
      }),
    /non-integer value/
  );

  assert.equal(
    matchesParamEcho(
      {
        target: { sysid: 1, compid: 1 },
        paramId: 'X',
        value: 1.0000005,
        paramType: 'MAV_PARAM_TYPE_UINT32',
        capabilities: CAP_PARAM_ENCODE_BYTEWISE,
      },
      {
        name: 'PARAM_VALUE',
        sysid: 1,
        compid: 1,
        fields: {
          param_id: 'X',
          param_type: 5,
          param_value: paramValueToWire(1, 'MAV_PARAM_TYPE_UINT32'),
        },
      }
    ),
    false
  );
});

test('an echo with no usable type declines the match instead of guessing REAL32', () => {
  // The distinguishing case: the frame's param_type is unusable, but its bytes
  // *would* decode as a matching REAL32. Guessing the type confirms a set from a
  // frame whose type cannot be trusted; declining reports an honest echo
  // timeout. Both sides silent on the type means there is nothing to compare.
  const echo = {
    name: 'PARAM_VALUE',
    sysid: 1,
    compid: 1,
    fields: {
      param_id: 'X',
      param_type: 999, // not a known MAV_PARAM_TYPE
      param_value: paramValueToWire(1, 'MAV_PARAM_TYPE_REAL32'),
    },
  };
  const request = {
    target: { sysid: 1, compid: 1 },
    paramId: 'X',
    value: 1,
    capabilities: CAP_PARAM_ENCODE_BYTEWISE,
  };

  // Guard: under a guessed REAL32 these bytes decode to exactly the expected 1,
  // so a match here could only come from the guess.
  assert.equal(paramValueFromWire(echo.fields.param_value, 'MAV_PARAM_TYPE_REAL32'), 1);

  assert.equal(matchesParamEcho(request, echo), false);

  // A request that does name its type still decodes and confirms.
  assert.equal(matchesParamEcho({ ...request, paramType: 'MAV_PARAM_TYPE_REAL32' }, echo), true);
});
