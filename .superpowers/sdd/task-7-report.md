### Task 7 Report: mavlink-param Dialect XOR Firmware + runtime

Status: implemented.

Commits:
- `feat(param): Build dialect XOR firmware; no silent catalog default` (this task commit)

Tests:
- RED verified: `node --test "test/nodes/param-html.test.js" "test/param/node.test.js"` failed before implementation on missing Dialect/Firmware editor contract and unresolved Build concrete firmware.
- PASS: `node --test "test/param/*.test.js" "test/nodes/param-html.test.js"` — 52 pass, 0 fail.
- PASS: `npx eslint "nodes/mavlink-param.html" "nodes/mavlink-param.js" "test/nodes/param-html.test.js" "test/param/node.test.js" --max-warnings=0`.

Concerns:
- `npm test` currently fails outside this task: `test/mission/node.test.js` subtest `mission Build concrete dialect uses config firmware and no Vehicle Profile target rung`.
- `npm run lint` currently fails outside this task: `test/nodes/mission-html.test.js` `no-regex-spaces`.
- Unrelated Mission files are modified in the worktree and were not edited or staged for Task 7.
