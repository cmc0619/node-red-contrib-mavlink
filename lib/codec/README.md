# Wire-value helpers

Two small modules the send path reads. Neither imports `node-mavlink`,
`lib/metadata`, or anything Node-RED.

## `types.js`

The MAVLink scalar type table — size, `kind`, and byte width per type string —
plus `normalizeType` (collapses `uint8_t_mavlink_version` to `uint8_t`) and
`is64BitKind`. `lib/connection/wire.js` and `wire-classes.js` read it to lay
out payloads and synthesize message classes.

## `param-union.js`

The PX4 parameter int/float union (DESIGN.md §11). `PARAM_VALUE` / `PARAM_SET`
carry the value in a `float` slot; PX4 places an integer parameter's bit
pattern into that slot rather than casting the number. `paramValueToWire`
writes the integer into a 4-byte `Buffer` and reads it back as float32;
`paramValueFromWire` is the inverse. REAL32 passes through untouched.
`PARAM_TYPES` is the MAV_PARAM_TYPE subset that fits the slot, by code.

`Buffer.write*` is the only range check: an integer that overflows its declared
width throws `ERR_OUT_OF_RANGE` there.

## Lint

`no-bitwise` is enforced over this directory.
