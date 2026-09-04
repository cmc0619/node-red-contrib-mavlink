'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { paramValueToWire } = require('../../lib/codec');
const {
  buildParamMessage,
  matchesParamEcho,
  matchesParamReadReply,
  createParamListCollector,
  resolveParamEncoding,
} = require('../../lib/param');

// MAV_PROTOCOL_CAPABILITY bits as AUTOPILOT_VERSION reports them, and the two
// encoding names resolveParamEncoding answers with — literal on purpose, so
// the tests measure the runtime's output instead of echoing its constants.
const CAP_PARAM_ENCODE_BYTEWISE = 16;
const CAP_PARAM_ENCODE_C_CAST = 131072;
const PARAM_ENCODING = { BYTEWISE: 'bytewise', C_CAST: 'c-cast' };

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

test('a set coerces the value it is handed — the editor is what requires one', () => {
  // The driver encodes and sends (§0). A blank value is `Number('')`, and a
  // non-numeric one rides as the wire NaN a float field is allowed to carry;
  // neither is repaired, and neither confirms (the echo match compares the
  // decoded value, and NaN matches no expected number).
  const set = (value) => buildParamMessage({
    action: 'set',
    target: { sysid: 1, compid: 1 },
    paramId: 'RC1_MIN',
    value,
    paramType: 'MAV_PARAM_TYPE_REAL32',
    firmware: 'ardupilot',
  });

  assert.ok(Number.isNaN(set('abc').fields.param_value));
  assert.ok(Number.isNaN(set(NaN).fields.param_value));
  // A string numeric is a value — the editor's number box serializes one.
  assert.equal(set('1100').fields.param_value, 1100);
  // An explicit 0 is a value, not a blank.
  assert.equal(set(0).fields.param_value, 0);
});

test('read and request-list still build without any value (#258 touches set only)', () => {
  const read = buildParamMessage({
    action: 'read',
    target: { sysid: 1, compid: 1 },
    paramId: 'RC1_MIN',
  });
  const list = buildParamMessage({
    action: 'request-list',
    target: { sysid: 1, compid: 1 },
  });
  assert.equal(read.name, 'PARAM_REQUEST_READ');
  assert.equal(list.name, 'PARAM_REQUEST_LIST');
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

test('PARAM_REQUEST_READ and PARAM_REQUEST_LIST build their distinct messages', () => {
  const read = buildParamMessage({
    action: 'read',
    target: { sysid: 9, compid: 1 },
    paramId: 'SYSID_THISMAV',
    paramIndex: -1,
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

test('a read addressed by index neither needs a param id nor sends one', () => {
  // PARAM_REQUEST_READ's param_index documents itself as "Send -1 to use the
  // param ID field as identifier (else the param ID will be ignored)". So an
  // index of 0 or more is the whole address, and the editor's Index mode —
  // where the name field is hidden and empty — has no id to supply.
  assert.deepEqual(
    buildParamMessage({ action: 'read', target: { sysid: 9, compid: 1 }, paramIndex: 0 }),
    {
      name: 'PARAM_REQUEST_READ',
      fields: {
        target_system: 9,
        target_component: 1,
        param_id: '',
        param_index: 0,
      },
    }
  );

  // An id alongside a real index is the ignored field, and is not sent as if
  // it meant something.
  assert.equal(
    buildParamMessage({
      action: 'read',
      target: { sysid: 9, compid: 1 },
      paramId: 'SYSID_THISMAV',
      paramIndex: 4,
    }).fields.param_id,
    ''
  );

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

test('resolveParamEncoding: known firmware when capabilities absent; anything else resolves nothing', () => {
  assert.equal(resolveParamEncoding({ firmware: 'px4' }), PARAM_ENCODING.BYTEWISE);
  assert.equal(resolveParamEncoding({ firmware: 'ardupilot' }), PARAM_ENCODING.C_CAST);
  // No firmware, a wrong-case token, and `custom` (a real Vehicle Profile
  // value that explicitly disables firmware-specific behaviour) all resolve to
  // no encoding at all. Bytewise and C-cast disagree on how an integer rides
  // the PARAM_VALUE float, so there is no direction to fall to — and none is
  // invented: encodeParamValue matches no case and writes the float's NaN,
  // which no echo confirms.
  for (const firmware of [undefined, 'PX4', 'apm', 'custom']) {
    assert.equal(resolveParamEncoding({ firmware }), undefined);
  }
});

test('resolveParamEncoding: explicit override still wins over a garbage firmware token', () => {
  // The ladder short-circuits on the explicit override before the firmware arm
  // is ever reached, so a bogus firmware string must not block it.
  assert.equal(
    resolveParamEncoding({ encoding: 'bytewise', firmware: 'PX4' }),
    PARAM_ENCODING.BYTEWISE
  );
  assert.equal(
    resolveParamEncoding({ encoding: 'c-cast', firmware: 'custom' }),
    PARAM_ENCODING.C_CAST
  );
});

test('resolveParamEncoding: an override is passed through, never second-guessed', () => {
  // The ladder short-circuits on a present override, so capabilities and
  // firmware are not consulted. A token that is not one of the two encodings
  // matches no case downstream and selects no encoding — it never silently
  // becomes the opposite one.
  assert.equal(
    resolveParamEncoding({
      encoding: 'bitwise',
      capabilities: CAP_PARAM_ENCODE_BYTEWISE,
      firmware: 'px4',
    }),
    'bitwise'
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
  // A stored member that does not complete the collect reports `true`; only an
  // ignored frame reports null (nodes/mavlink-param.js reads that distinction
  // to decide whether the refill timer may be postponed).
  assert.equal(
    collector.accept({
      name: 'PARAM_VALUE',
      fields: { param_id: 'B', param_index: 1, param_count: 2, param_value: 2, param_type: 9 },
    }),
    true
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

/** One list-member PARAM_VALUE, fields only where the test cares. */
function listFrame(index, count, paramId) {
  return {
    name: 'PARAM_VALUE',
    fields: { param_id: paramId || `P${index}`, param_index: index, param_count: count, param_value: index, param_type: 9 },
  };
}

test('collector pins the first advertised count; later differing counts do not move the target', () => {
  const warns = [];
  const collector = createParamListCollector({ warn: (t) => warns.push(t) });
  assert.equal(collector.accept(listFrame(0, 2)), true);
  // A frame claiming count 3 arrives mid-stream: its index 2 is outside the
  // pinned count and must not extend the collect.
  assert.equal(collector.accept(listFrame(2, 3)), null);
  const complete = collector.accept(listFrame(1, 3));
  assert.deepEqual(complete.map((p) => p.index), [0, 1], 'completes at the pinned count');
  assert.equal(warns.length, 1, 'the out-of-range frame was warned about');
});

test('collector completes count 0 as an empty list', () => {
  const collector = createParamListCollector();
  assert.deepEqual(collector.accept(listFrame(65535, 0)), [], 'the count-0 frame is the whole answer');
});

test('collector skips index 65535 as a member but pins its count', () => {
  // A concurrent set's echo (index 65535) interleaving with the collect
  // carries the true count; it is not itself a list member.
  const collector = createParamListCollector();
  assert.equal(collector.accept(listFrame(65535, 1, 'SET_ECHO')), null, 'the echo is ignored, not stored');
  const complete = collector.accept(listFrame(0, 1, 'A'));
  assert.deepEqual(complete.map((p) => p.paramId), ['A']);
});

test('an out-of-range index never satisfies the completion check, and warns once', () => {
  // The old collector stored any non-negative index, so a bogus index inflated
  // byIndex.size and a "complete" snapshot could ship short one real parameter
  // and long one bogus one (#242).
  const warns = [];
  const collector = createParamListCollector({ warn: (t) => warns.push(t) });
  assert.equal(collector.accept(listFrame(0, 2)), true);
  assert.equal(collector.accept(listFrame(5, 2)), null, 'out-of-range frame is ignored');
  assert.equal(collector.accept(listFrame(5, 2)), null, 'and stays ignored');
  assert.equal(warns.length, 1, 'the warn is deduped per index');
  const complete = collector.accept(listFrame(1, 2));
  assert.deepEqual(complete.map((p) => p.index), [0, 1], 'only real members ship');
});

test('matchesParamReadReply matches by name and by index', () => {
  const reply = {
    name: 'PARAM_VALUE',
    sysid: 1,
    compid: 1,
    fields: { param_id: 'RC1_MIN', param_index: 7, param_count: 100, param_value: 1100, param_type: 9 },
  };

  const byName = { target: { sysid: 1, compid: 1 }, paramId: 'RC1_MIN' };
  assert.equal(matchesParamReadReply(byName, reply), true);
  assert.equal(
    matchesParamReadReply({ ...byName, paramId: 'RC2_MIN' }, reply),
    false,
    'a different parameter does not answer the read'
  );

  // An index read sends no param_id, so the index is the only identity.
  const byIndex = { target: { sysid: 1, compid: 1 }, paramIndex: 7 };
  assert.equal(matchesParamReadReply(byIndex, reply), true);
  assert.equal(matchesParamReadReply({ ...byIndex, paramIndex: 8 }, reply), false);
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
  // an echo of 1 confirmed a request of 1.0000005. The send path writes that
  // request through `Buffer.writeUInt32LE`, which stores 1, and the vehicle
  // echoes 1 — the matcher reports no confirmation for the value asked.
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

test('the echo decodes by the vehicle-declared type alone; one the codec cannot decode fails loud', () => {
  // The vehicle is the authority on its own parameter's type, so the request's
  // declared type is never a fallback: a bytewise frame whose param_type the
  // codec has no table entry for craters on that missing entry, not on a guess
  // that happens to match.
  const echo = {
    name: 'PARAM_VALUE',
    sysid: 1,
    compid: 1,
    fields: {
      param_id: 'X',
      param_type: 999, // not a MAV_PARAM_TYPE
      param_value: paramValueToWire(1, 'MAV_PARAM_TYPE_REAL32'),
    },
  };
  const request = {
    target: { sysid: 1, compid: 1 },
    paramId: 'X',
    value: 1,
    paramType: 'MAV_PARAM_TYPE_REAL32',
    capabilities: CAP_PARAM_ENCODE_BYTEWISE,
  };

  assert.throws(() => matchesParamEcho(request, echo), TypeError);
  assert.throws(
    () => matchesParamEcho(request, { ...echo, fields: { ...echo.fields, param_type: 0 } }),
    TypeError
  );
});
