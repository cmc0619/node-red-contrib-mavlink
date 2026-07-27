# Field codec

Standalone conversion between JavaScript values and MAVLink field values, driven
by compiled dialect metadata passed as an argument (DESIGN.md §5).

Imports nothing above itself — no `node-mavlink`, no `lib/metadata`, nothing
Node-RED. Own directory, tests, and this README so publishing later is a move
and a `package.json`, not a refactor.

## API

```js
const {
  encodeField, decodeField,
  encodeMessage, decodeMessage,
  assembleBitmask, decodeBitmask,
  paramValueToWire, paramValueFromWire,
  FieldCodecError,
} = require('.');
```

| Function | Role |
|---|---|
| `encodeField(field, value, enumMeta?)` | One field → wire-ready value |
| `decodeField(field, wireValue)` | Wire value → JS |
| `encodeMessage(message, values, { enums }?)` | Message object → wire-ready object |
| `decodeMessage(message, wireValues)` | Wire object → JS object |
| `assembleBitmask(enumMeta, bits, use64?, fieldName?)` | Entry names / bit indexes → mask |
| `decodeBitmask(enumMeta, mask, use64?)` | Mask → entry names |
| `paramValueToWire(value, paramType, fieldName?)` | PX4 int/float union → float slot |
| `paramValueFromWire(wireFloat, paramType, fieldName?)` | Float slot → JS (bit reinterpret) |

Errors are `FieldCodecError` with a `.field` property naming the offender.

## Wire-value domain

What later feeds `node-mavlink` / `Buffer.write*`:

| MAVLink type | Encode returns | Decode returns |
|---|---|---|
| `int8_t` … `uint32_t` | `number` (integer) | `number` |
| `int64_t` / `uint64_t` | `bigint` | decimal `string` |
| `float` / `double` | `number` (NaN preserved) | `number` |
| `char` / `char[n]` | Latin-1 `string`, length `n`, NUL-padded | `string`, NULs stripped |
| numeric `type[n]` | `Array` of element wire values | `Array` of decoded elements |

## Rules (binding)

- Never coerce `undefined` / `null` / `''` / non-numeric strings — they would
  become `0` or NaN in `Buffer` with no error.
- Blank, explicit `0`, and absent are three states (message level uses
  own-property presence).
- No bitwise operators — masks are built arithmetically; `uint64` masks use
  BigInt. Bit 31 is `2147483648`, never `1 << 31`.
- Floats are not range-checked; integers are, including declared min/max.
- PX4 parameter union reinterprets bits via `Buffer`; never numeric cast.

## Tests

```bash
node --test lib/codec/test/*.test.js
npx eslint lib/codec
```
