# Task 10 fix report

## Status

Completed on branch `cursor/build-tier-dialect-picker-f3a0`.

## Fixes

- `mavlink-build` now treats an empty Build-tier `config.dialect` as invalid config. Only `config.dialect === '__vehicle'` resolves the configured Vehicle Profile bundle.
- `/mavlink/enums` and `/mavlink/command/commands` now reject empty catalog queries with `400` and `dialect is required`. Explicit `?dialect=ardupilotmega` continues to load the bundled catalog.
- Shared `currentCatalogQuery` no longer reads stale hidden `#node-input-vehicle` or local dialect fields on wire tiers. Wire catalog queries come only from the selected Connection's bound profile.
- `mavlink-swarm` reloads both MAV_TYPE and MAV_CMD catalogs when `delivery` or `selectionMode` changes, then refreshes visibility.
- `mavlink-command.html` now describes Build catalog source as the Dialect picker, with Vehicle Profile only through the explicit escape.

## Tests

- Red check before implementation: focused route/editor/runtime tests failed on the expected fallback and stale-catalog assertions.
- Focused after fix: `node --test test/vehicle/enums-route.test.js test/command/commands-route.test.js test/nodes/in-out-build.test.js test/nodes/local-identity-html.test.js test/nodes/swarm-html.test.js` — 86 passed.
- Full suite: `npm test` — 845 passed.

## Scope

- Changed files in this task: 12 including this report.
- Branch file count versus `main`: 40 after force-adding this ignored report, under the 50-file cap.
