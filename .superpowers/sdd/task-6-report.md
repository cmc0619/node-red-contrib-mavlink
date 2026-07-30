Status: complete

Commits:
- `feat(payload): Build dialect picker with Vehicle Profile escape`

Tests:
- `node --test "test/nodes/payload-verb-html.test.js" "test/payload/node.test.js"`
- `node --test "test/payload/field-tips-route.test.js" "test/payload/field-tips.test.js" "test/nodes/local-identity-html.test.js"`
- `npm test`
- `npm run lint`
- `npm run validate:node-red`

Concerns:
- The worktree already contained unrelated command/move changes; this task only stages payload files and this report.
- `npm run validate:node-red` exits 0 but prints existing npm deprecation/package warnings from `node-red-dev`.
