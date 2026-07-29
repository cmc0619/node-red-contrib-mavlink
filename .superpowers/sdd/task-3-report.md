# Task 3 report: mavlink-build empty dialect + boolean fields

## Status

Implemented.

## Summary

- `mavlink-build` editor defaults `dialect` to `''` and validates it when Delivery is `Build`.
- The Build dialect picker now uses `RED.mavlink.populateDialectSelect` and preserves the `__vehicle` escape.
- Empty catalog targets now return empty catalogs without fetching an invented bundled dialect.
- FALSE/TRUE enum tables render as single-select `enum` controls that save numeric `0` / `1`, including when the field or command param metadata is marked as bitmask.
- `/mavlink/build/messages` rejects dialect-only requests with no dialect instead of defaulting to `ardupilotmega`.

## Tests

- Red check observed: `node --test test/nodes/build-html.test.js test/metadata/messages-list.test.js` failed before implementation on empty-route default, dialect default, boolean enum rendering, and empty catalog target assertions.
- Green checks:
  - `node --test test/nodes/build-html.test.js test/metadata/messages-list.test.js`
  - `node --test test/nodes/in-out-build.test.js`
  - `npm test`
  - `npm run lint`

## Commit

- `feat(build): require explicit dialect; boolean FALSE/TRUE fields`

## Concerns

None.
