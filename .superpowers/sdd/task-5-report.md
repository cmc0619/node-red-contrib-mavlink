# Task 5 report: mavlink-move Build dialect picker

## Status

Implemented.

## Summary

- Added `mavlink-move` Build-tier `dialect` editor config with an empty default and Build-only required validation.
- Added the shared `RED.mavlink.populateDialectSelect` picker with the `__vehicle` / `from Vehicle Profile...` escape.
- Changed Move visibility so Build shows Dialect, shows Vehicle only for `__vehicle`, hides Connection/Send-as, and adds no Firmware row.
- Changed Move runtime profile inheritance so Build reads `config.vehicle` only when `config.dialect === '__vehicle'`.
- Updated Move runtime tests so Build fixtures use valid dialect config and concrete dialects do not inherit stale Vehicle Profile targets.

## Tests

- Red checks observed:
  - `node --test test/nodes/move-html.test.js` failed on missing Move dialect row/helper/default.
  - `node --test test/move/node.test.js` failed because concrete Build dialect still inherited `config.vehicle`.
- Green checks:
  - `node --test test/nodes/move-html.test.js`
  - `node --test test/move/node.test.js`
  - `npm test` (832/832 passing, serialized)
  - `npm run lint`

## Commit

- `feat(move): Build dialect picker with Vehicle Profile escape`

## Concerns

- The working tree contains unowned command/payload edits from outside Task 5; they were left unstaged and untouched.
- A first full-suite run was executed concurrently with lint and reported transient failures; a serialized rerun of `npm test` passed 832/832.
