## Task 9 report: mavlink-swarm — no silent dialect on Build catalogs

Status: complete.

Changes:
- Added `dialect` and `vehicle` editor properties to `mavlink-swarm`.
- Added Build+list-only Dialect and Vehicle Profile rows.
- Swarm catalog resolution now:
  - uses selected Dialect for Build+list without a connection;
  - uses `__vehicle` to query by Vehicle Profile id;
  - uses the selected Connection's profile for Build+all/filter and wire tiers;
  - returns an empty catalog target when unresolved instead of inventing `ardupilotmega`.
- Added swarm HTML tests for the explicit dialect path, `__vehicle`, and connection-profile catalog path.

Tests:
- `node --test "test/nodes/swarm-html.test.js"` — pass.
- `node --test "test/swarm/node.test.js"` — pass.
- `npm run lint` — pass.
- `node --test "test/nodes/"*"html.test.js"` — fails in unrelated `mavlink-param` HTML tests outside Task 9 ownership.
- `npm test` — fails in unrelated Mission/Param runtime/HTML tests outside Task 9 ownership.

Concerns:
- The worktree already contains modified Mission/Param files outside this task's ownership; I left them untouched.
- Full-suite failures are in those Mission/Param areas, not in the swarm tests.

Commits:
- `feat(swarm): Build list catalogs use explicit dialect`
