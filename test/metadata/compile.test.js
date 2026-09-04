'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compileXml } = require('../../lib/metadata/compile');

/**
 * Custom-dialect XML compiler pain points (DESIGN.md §4, §13): include order,
 * missing include, cyclic include, msgid collision between files, and same-name
 * override precedence — plus the parse details the bundle shape pins down. All
 * fixtures are inline synthetic XML; the compiler is pure and touches no fs.
 */

const XML = (body) => `<?xml version="1.0"?>\n<mavlink>${body}</mavlink>`;

test('includes resolve in dependency order, entry last (diamond visited once)', () => {
  const base = XML('<messages><message id="0" name="HEARTBEAT"><field type="uint8_t" name="type">t</field></message></messages>');
  const a = XML('<include>base.xml</include><messages><message id="10" name="A"><field type="uint8_t" name="a">a</field></message></messages>');
  const b = XML('<include>base.xml</include><messages><message id="11" name="B"><field type="uint8_t" name="b">b</field></message></messages>');
  const entry = XML('<include>a.xml</include><include>b.xml</include><messages><message id="12" name="ENTRY"><field type="uint8_t" name="e">e</field></message></messages>');

  const bundle = compileXml({ 'base.xml': base, 'a.xml': a, 'b.xml': b, 'entry.xml': entry }, 'entry.xml');

  assert.deepEqual(bundle.files, ['base.xml', 'a.xml', 'b.xml', 'entry.xml']);
  assert.equal(bundle.files[bundle.files.length - 1], 'entry.xml');
  assert.deepEqual(Object.keys(bundle.messages).sort(), ['A', 'B', 'ENTRY', 'HEARTBEAT']);
});

test('a missing include fails loud, naming the include and the referrer', () => {
  const entry = XML('<include>common.xml</include>');
  assert.throws(() => compileXml({ 'entry.xml': entry }, 'entry.xml'), /common\.xml.*included by 'entry\.xml'/);
});

test('a missing entry file fails loud, naming it', () => {
  assert.throws(() => compileXml({ 'other.xml': XML('') }, 'entry.xml'), /Dialect include 'entry\.xml'/);
});

test('a cyclic include fails loud, naming the cycle', () => {
  const a = XML('<include>b.xml</include>');
  const b = XML('<include>a.xml</include>');
  assert.throws(() => compileXml({ 'a.xml': a, 'b.xml': b }, 'a.xml'), /Cyclic include/);
});

test('a file that is not XML fails loud, naming the file', () => {
  assert.throws(() => compileXml({ 'entry.xml': 'this is not xml <<<' }, 'entry.xml'), /entry\.xml/);
});

test('msgid collision between files defining different messages fails loud', () => {
  const base = XML('<messages><message id="7" name="FOO"><field type="uint8_t" name="x">x</field></message></messages>');
  const entry = XML('<include>base.xml</include><messages><message id="7" name="BAR"><field type="uint8_t" name="y">y</field></message></messages>');
  assert.throws(() => compileXml({ 'base.xml': base, 'entry.xml': entry }, 'entry.xml'), /id 7 is claimed by both 'FOO' and 'BAR'/);
});

test('same-name message redefinition is an override resolved by include order', () => {
  const base = XML('<messages><message id="7" name="FOO"><field type="uint8_t" name="old">o</field></message></messages>');
  const entry = XML('<include>base.xml</include><messages><message id="7" name="FOO"><field type="uint16_t" name="new">n</field></message></messages>');
  const bundle = compileXml({ 'base.xml': base, 'entry.xml': entry }, 'entry.xml');

  assert.equal(bundle.messages.FOO.fields[0].name, 'new');
  assert.equal(bundle.messages.FOO.fields[0].type, 'uint16_t');
});

test('an override frees its old msgid for reuse by another message', () => {
  const base = XML('<messages><message id="7" name="FOO"><field type="uint8_t" name="a">a</field></message></messages>');
  // entry redefines FOO onto id 9, freeing 7, then defines BAR on the freed 7.
  const entry = XML('<include>base.xml</include><messages><message id="9" name="FOO"><field type="uint8_t" name="a">a</field></message><message id="7" name="BAR"><field type="uint8_t" name="b">b</field></message></messages>');
  const bundle = compileXml({ 'base.xml': base, 'entry.xml': entry }, 'entry.xml');

  assert.equal(bundle.messages.FOO.id, 9);
  assert.equal(bundle.messages.BAR.id, 7);
});

test('enums merge across files; same-name same-value entries dedupe silently', () => {
  const base = XML('<enums><enum name="MAV_TYPE"><entry value="0" name="MAV_TYPE_GENERIC"><description>gen</description></entry></enum></enums>');
  const entry = XML('<include>base.xml</include><enums><enum name="MAV_TYPE"><entry value="0" name="MAV_TYPE_GENERIC"/><entry value="2" name="MAV_TYPE_QUADROTOR"/></enum></enums>');
  const bundle = compileXml({ 'base.xml': base, 'entry.xml': entry }, 'entry.xml');

  const names = bundle.enums.MAV_TYPE.entries.map((e) => e.name);
  assert.deepEqual(names, ['MAV_TYPE_GENERIC', 'MAV_TYPE_QUADROTOR']);
  assert.equal(bundle.enums.MAV_TYPE.entries[0].description, 'gen');
  assert.deepEqual(bundle.enums.MAV_TYPE.byName, { MAV_TYPE_GENERIC: 0, MAV_TYPE_QUADROTOR: 2 });
  assert.deepEqual(bundle.enums.MAV_TYPE.byValue, { 0: 'MAV_TYPE_GENERIC', 2: 'MAV_TYPE_QUADROTOR' });
});

test('same enum entry name with a different value is an override, later wins', () => {
  const base = XML('<enums><enum name="MAV_TYPE"><entry value="0" name="MAV_TYPE_GENERIC"/></enum></enums>');
  const entry = XML('<include>base.xml</include><enums><enum name="MAV_TYPE"><entry value="5" name="MAV_TYPE_GENERIC"/></enum></enums>');
  const bundle = compileXml({ 'base.xml': base, 'entry.xml': entry }, 'entry.xml');

  assert.equal(bundle.enums.MAV_TYPE.entries[0].value, 5);
});

test('enum bitmask flag and value notations: decimal, hex, power, beyond-safe-integer', () => {
  const entry = XML(
    '<enums>' +
      '<enum name="MY_FLAGS" bitmask="true">' +
        '<entry value="1" name="MY_FLAGS_A"/>' +
        '<entry value="0x2" name="MY_FLAGS_B"/>' +
        '<entry value="-0x2" name="MY_FLAGS_NEG"/>' +
        '<entry value="2**2" name="MY_FLAGS_C"/>' +
        '<entry value="9223372036854775808" name="MY_FLAGS_BIG"/>' +
      '</enum>' +
    '</enums>'
  );
  const bundle = compileXml({ 'entry.xml': entry }, 'entry.xml');
  const e = bundle.enums.MY_FLAGS;
  assert.equal(e.bitmask, true);
  const byName = Object.fromEntries(e.entries.map((x) => [x.name, x.value]));
  assert.equal(byName.MY_FLAGS_A, 1);
  assert.equal(byName.MY_FLAGS_B, 2);
  assert.equal(byName.MY_FLAGS_NEG, -2);
  assert.equal(byName.MY_FLAGS_C, 4);
  assert.equal(byName.MY_FLAGS_BIG, '9223372036854775808');
});

test('field type/arrayLength split, mavlink_version normalization, extension marker, attrs', () => {
  const entry = XML(
    '<enums><enum name="MAV_TYPE" bitmask="false"><entry value="0" name="MAV_TYPE_GENERIC"/></enum></enums>' +
    '<messages><message id="0" name="HEARTBEAT">' +
      '<description>hb</description>' +
      '<field type="uint32_t" name="custom_mode">Custom mode</field>' +
      '<field type="uint8_t" name="type" enum="MAV_TYPE">t</field>' +
      '<field type="char[10]" name="label" units="m">l</field>' +
      '<field type="uint8_t_mavlink_version" name="mavlink_version">v</field>' +
      '<extensions/>' +
      '<field type="float" name="ext_field" invalid="NaN">e</field>' +
    '</message></messages>'
  );
  const bundle = compileXml({ 'entry.xml': entry }, 'entry.xml');
  const f = Object.fromEntries(bundle.messages.HEARTBEAT.fields.map((x) => [x.name, x]));

  assert.equal(f.custom_mode.type, 'uint32_t');
  assert.equal(f.custom_mode.arrayLength, null);
  assert.equal(f.type.enum, 'MAV_TYPE');
  assert.equal(f.label.type, 'char');
  assert.equal(f.label.arrayLength, 10);
  assert.equal(f.label.units, 'm');
  assert.equal(f.mavlink_version.type, 'uint8_t');
  assert.equal(f.custom_mode.extension, false);
  assert.equal(f.ext_field.extension, true);
  assert.equal(f.ext_field.invalid, 'NaN');
  assert.equal(bundle.messages.HEARTBEAT.description, 'hb');
});

test('commands derive from MAV_CMD with params, labels, ranges, and location flags', () => {
  const entry = XML(
    '<enums><enum name="MAV_CMD">' +
      '<entry value="22" name="MAV_CMD_NAV_TAKEOFF" hasLocation="true">' +
        '<description>Takeoff</description>' +
        '<param index="1" label="Pitch" units="deg" minValue="0" maxValue="90" increment="1">Minimum pitch</param>' +
        '<param index="4" label="Yaw" enum="SOME_ENUM">Yaw angle</param>' +
        '<param index="7" label="Altitude" units="m">Altitude</param>' +
      '</entry>' +
    '</enum></enums>'
  );
  const bundle = compileXml({ 'entry.xml': entry }, 'entry.xml');
  const cmd = bundle.commands.MAV_CMD_NAV_TAKEOFF;

  assert.equal(cmd.value, 22);
  assert.equal(cmd.hasLocation, true);
  assert.deepEqual(cmd.params.map((p) => p.index), [1, 4, 7]);
  assert.equal(cmd.params[0].label, 'Pitch');
  assert.equal(cmd.params[0].units, 'deg');
  assert.equal(cmd.params[0].minValue, 0);
  assert.equal(cmd.params[0].maxValue, 90);
  assert.equal(cmd.params[0].increment, 1);
  assert.equal(cmd.params[1].enum, 'SOME_ENUM');
});

test('a dialect with no MAV_CMD compiles with an empty commands view', () => {
  const entry = XML('<messages><message id="0" name="HEARTBEAT"><field type="uint8_t" name="type">t</field></message></messages>');
  const bundle = compileXml({ 'entry.xml': entry }, 'entry.xml');
  assert.deepEqual(bundle.commands, {});
});

test('the compiled bundle is plain JSON-serializable data', () => {
  const entry = XML(
    '<version>3</version>' +
    '<enums><enum name="MAV_CMD"><entry value="16" name="MAV_CMD_NAV_WAYPOINT"><param index="1" label="Hold">h</param></entry></enum></enums>' +
    '<messages><message id="0" name="HEARTBEAT"><field type="uint8_t" name="type">t</field></message></messages>'
  );
  const bundle = compileXml({ 'entry.xml': entry }, 'entry.xml');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(bundle)));
});
