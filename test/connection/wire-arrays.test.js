'use strict';

/**
 * Array fields on the fields bag: shorter pads, exact fits, longer refuses.
 *
 * Measured on this codec (470#9): node-mavlink's array serializers loop
 * `i < value.length && i < maxLen`, so a short array leaves the pre-zeroed
 * tail as zeros and a long one drops everything past `maxLen` — and the frame
 * reports sent either way. Padding is the protocol's own shape (`data[]` with
 * a companion `len`); dropping is a silent false success, and the serialize
 * choke refuses it the way it already refuses an unspoken core int.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWire } = require('../../lib/connection/wire');
const { loadBundled } = require('../../lib/metadata/bundled');

const CTX = { sysid: 255, compid: 1, seq: 0 };

function roundTrip(wire, message) {
  const [decoded] = wire.decode(wire.serialize(message, CTX));
  return decoded.fields;
}

function controls(values) {
  return {
    name: 'SET_ACTUATOR_CONTROL_TARGET',
    fields: { time_usec: 1n, group_mlx: 0, target_system: 1, target_component: 1, controls: values },
  };
}

test('a numeric array shorter than its declared length pads with zeros — the companion-len shape', () => {
  const wire = createWire({ bundle: loadBundled('common') });
  assert.deepEqual(Array.from(roundTrip(wire, controls([1, 2, 3, 4, 5])).controls), [1, 2, 3, 4, 5, 0, 0, 0]);
  const inject = roundTrip(wire, {
    name: 'GPS_INJECT_DATA',
    fields: { target_system: 1, target_component: 1, len: 3, data: [9, 8, 7] },
  });
  assert.equal(inject.len, 3);
  assert.deepEqual(Array.from(inject.data).slice(0, 4), [9, 8, 7, 0]);
  assert.equal(inject.data.length, 110);
});

test('a numeric array at its declared length rides exactly', () => {
  const wire = createWire({ bundle: loadBundled('common') });
  assert.deepEqual(Array.from(roundTrip(wire, controls([1, 2, 3, 4, 5, 6, 7, 8])).controls), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a numeric array longer than its declared length is refused, not silently cut to fit (470#9)', () => {
  const wire = createWire({ bundle: loadBundled('common') });
  assert.throws(
    () => wire.serialize(controls([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), CTX),
    /invalid packet: controls carries 11 entries, 8 fit/
  );
});

test('a char array longer than its declared length is refused the same way', () => {
  const wire = createWire({ bundle: loadBundled('common') });
  assert.throws(
    () => wire.serialize({
      name: 'PARAM_REQUEST_READ',
      fields: { target_system: 1, target_component: 1, param_id: 'SEVENTEEN_CHARS_X', param_index: -1 },
    }, CTX),
    /invalid packet: param_id carries 17 entries, 16 fit/
  );
});
