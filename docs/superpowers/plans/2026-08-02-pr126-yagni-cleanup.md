# PR126 YAGNI Cleanup Implementation Plan

> **For implementation agents:** Execute this plan task by task. Read `AGENTS.md` and the task brief before editing. Use `apply_patch` for edits, add the failing test first, and commit only the files owned by the task.

**Goal:** Produce draft PR126 as a conservative post-PR123 cleanup: local-first parameter-definition updates, lean human-facing catalog loading, deploy-time Connection binding, a retry-safe loud dialect failure, and statically proven dead-code/package cleanup.

**Architecture:** Parameter definitions use a profile-keyed local holding file with a separate authenticated update route. Ordinary editor reads never fetch. MAVLink XML-backed editor catalogs make fresh local admin requests and retain only stale-response sequencing. Direct Connection references are bound at deploy, while the existing two-output terminal-failure contract remains unchanged.

**Tech stack:** Node.js 20+, CommonJS, Node-RED 4 admin/runtime APIs, `node:test`, ESLint, npm packaging.

## Global Constraints

- Start from merged PR123 (`origin/main` at `a6469b6`); do not copy PR125 commits.
- PR126 must remain draft from creation through handoff and stay below 50 changed files.
- Do not intentionally change supported MAVLink logic, output routing, timeout behavior, queue bounds, transport teardown, signing, replay protection, or dynamic message validation.
- Terminal node failures must still emit the documented status record on output 1 and call `done(err)`.
- Trust editor-produced static configuration. Resolve direct Connection config nodes once at deploy; do not recover them per message.
- Fail loudly for broken local state and dialect resolution. Keep runtime handling only at genuine network, filesystem, socket, protocol, and asynchronous boundaries.
- `paramDefsUrl` is optional and never receives an invented default. Ordinary definition GETs are local-only. Only an explicit authenticated Update performs network I/O.
- A failed or invalid definition update must preserve the last good local file. Corrupt local JSON must report an error without falling back to the network.
- The parameter holding-file identity is the Vehicle Profile node ID, not its URL. Parameter metadata remains optional, so no seed is added.
- Do not reuse XML include traversal, Git pinning, compilation, or seed comparison for the single JSON document. Reuse only the admin/auth/local-storage/update conventions.
- Tests under `lib/**/test/**` must remain runnable from the repository but must not appear in the npm tarball.
- Every behavior change begins with a failing regression test. Run the narrow test before and after implementation.

### Task 1: Simplify human-facing editor catalog loading

**Owner files:**

- Modify: `resources/mavlink-editor.js`
- Modify: `nodes/mavlink-build.html`
- Modify: `nodes/mavlink-command.html`
- Modify: `nodes/mavlink-in.html`
- Modify: `nodes/mavlink-swarm.html`
- Modify: `test/nodes/mavlink-editor-resource.test.js`
- Modify: editor HTML tests only when required by removed fields

- [ ] Replace the shared catalog cache bag with a minimal state object holding the currently rendered value and a monotonically increasing request sequence.
- [ ] Remove per-key result storage, in-flight waiter queues, duplicate-request coalescing, and cache-hit callbacks.
- [ ] Keep the empty-target fast path and ensure an older response cannot repaint a newer selection.
- [ ] Remove Command preset result caching; each dialog load may perform its small local admin request.
- [ ] Remove caller code that clears `.byKey` or initializes `.inflight`.
- [ ] Rewrite tests to prove: empty target does not fetch, each nonempty call fetches, and stale responses are ignored. Delete tests whose only contract was caching/coalescing.
- [ ] Run `node --test test/nodes/mavlink-editor-resource.test.js` and the affected editor HTML tests; expect all passing.
- [ ] Commit as `refactor(editor): remove catalog request caching`.

### Task 2: Make parameter definitions a local holding-file workflow

**Owner files:**

- Modify: `lib/param/defs.js`
- Modify: `nodes/mavlink-param.js`
- Modify: `nodes/mavlink-vehicle.html`
- Modify: existing parameter-definition tests
- Add: focused route/UI tests if current suites do not exercise the new update boundary

- [ ] Replace URL-keyed memory/disk caching with a deterministic holding-file path keyed by Vehicle Profile ID under `<userDir>/mavlink/param-defs`.
- [ ] Remove `FAMILY`, automatic ArduPilot URL derivation, the process memory cache, and the cache-reset test API.
- [ ] Implement a local read that returns no definitions only for `ENOENT`; parse/validation errors propagate.
- [ ] Implement an explicit update that requires a nonempty URL, downloads JSON, validates the document into a nonempty definition map, writes a sibling temporary file, and atomically renames it over the holding file. Clean up the temporary file on failure without altering the last good file.
- [ ] Make `GET /mavlink/param/defs` read only the profile-keyed local file. It must never invoke fetch. A missing file returns an empty definition object with a useful notice; a corrupt file returns an error response.
- [ ] Add authenticated `POST /mavlink/param/defs/update`, accepting the Vehicle Profile ID plus the explicit URL currently in the editor. Reject empty URL input, update the profile-keyed holding file, and return the validated definition count.
- [ ] Add a Vehicle Profile Update button/status beside `paramDefsUrl`. Explain that the URL is optional, is used only by Update, and a profile without downloaded definitions still works.
- [ ] Test local-only reads, explicit updates, stable profile-keyed paths across URL changes, empty URL rejection, failed-update preservation, corrupt-local failure, and no-seed behavior.
- [ ] Run the focused parameter and Vehicle Profile tests; expect all passing.
- [ ] Commit as `refactor(param): use explicit local definition updates`.

### Task 3: Bind Connections at deploy and make dialect failures retry-safe

**Owner files:**

- Modify: `lib/addressing/delivery-context.js`
- Modify: `nodes/mavlink-move.js`
- Modify: `nodes/mavlink-param.js` only if Task 2 has not changed its runtime call site; otherwise coordinate through the Task 2 interface and do not edit it concurrently
- Modify: `nodes/mavlink-payload.js`
- Modify: `nodes/mavlink-command.js`
- Modify: `nodes/mavlink-build.js`
- Modify: focused addressing/action-node tests

- [ ] Remove the wire-tier fallback `RED.nodes.getNode(config.connection)` from `resolveDeliveryContext`; direct callers supply the deploy-bound Connection.
- [ ] Pass the deploy-bound Connection from Move, Param, and Payload into delivery-context resolution. Preserve their existing missing-Connection status output and `done(err)` behavior.
- [ ] In Command coordinate metadata, perform the dialect lookup in loud mode and set `_coordKindsResolved` only after a successful lookup. A lookup failure on two consecutive inputs must fail both times rather than falling through to historical coordinate scaling.
- [ ] Remove only duplicated runtime defaults guaranteed by editor definitions: Command timeout/retries, Payload timeout/retries, and Build repeat interval. Do not alter their calculations after numeric conversion.
- [ ] Add the two-input failed-dialect regression test and retain tests proving output-1 terminal failure behavior.
- [ ] Run focused delivery-context, Command, Move, Param, Payload, and Build tests; expect all passing.
- [ ] Commit as `refactor(nodes): trust deploy-time configuration`.

### Task 4: Delete proven dead surfaces and exclude tests from the package

**Owner files:**

- Delete: `lib/metadata/dts.js`
- Modify: `lib/metadata/naming.js`
- Modify: `lib/payload/index.js`
- Modify: `nodes/mavlink-swarm.js`
- Modify: `lib/metadata/bundled.js`
- Modify: `lib/metadata/index.js`
- Modify: `test/metadata/bundled.test.js`
- Modify: `lib/command/test/stubs/connection.js`
- Modify: `package.json`
- Modify: package-content tests if present

- [ ] Delete the unreachable `.d.ts` recovery module.
- [ ] Delete unused naming helpers and exports while retaining the three reachable enum classifiers.
- [ ] Delete unused payload helper implementations and narrow exports to the actual public consumers without changing internal behavior.
- [ ] Inline Swarm's one-call `vehicleBundleFrom` wrapper.
- [ ] Replace the `seedRoot` identity wrapper with direct `resolveSeedFile` use and adjust its test/export surface.
- [ ] Delete the unused `StubConnection` class while retaining `StubPeerTable`.
- [ ] Exclude `lib/**/test/**` from the npm tarball without preventing repository tests from running. Verify the exact package manifest rather than assuming an npm glob works.
- [ ] Run focused metadata, payload, swarm, and command tests plus `npm pack --dry-run --json`; expect tests to pass and no `/test/` path under `lib/` in the tarball.
- [ ] Commit as `refactor(lib): remove unreachable helpers`.

### Task 5: Reconcile documentation and verify the complete draft

**Owner files:**

- Modify: `DESIGN.md`
- Modify: `docs/superpowers/specs/2026-08-02-pr126-yagni-cleanup-design.md` only if implementation exposed a factual mismatch
- Modify: tests only for cross-task integration defects discovered here

- [ ] Update DESIGN to describe local-only parameter-definition reads, explicit updates, profile-keyed holding files, deploy-bound Connection references, and the removed `.d.ts` recovery. Add the required section 14 session lesson.
- [ ] Confirm `git diff --check` succeeds and fewer than 50 files differ from `origin/main`.
- [ ] Run `npm.cmd run lint`; expect exit 0.
- [ ] Run all non-SITL Node tests with a PowerShell-generated file list excluding `test/sitl`; expect exit 0.
- [ ] Run `npm.cmd run test:runtime-smoke`; expect exit 0.
- [ ] Run `npm.cmd run validate:node-red`; expect exit 0.
- [ ] Run `npm.cmd pack --dry-run --json`; inspect the manifest and confirm no `lib/**/test/**` file is published.
- [ ] If the full `npm.cmd test` is run on Windows, record the already-known Bash-dependent SITL failures separately; do not modify product code to accommodate missing `/bin/bash`.
- [ ] Run a fresh defect-first whole-branch review using the requested review-agent and code-review workflows. Fix all material findings and re-run affected verification.
- [ ] Commit documentation/integration corrections as `docs: record lean runtime boundaries` or amend the appropriate task commit when ownership is unambiguous.
- [ ] Push `agent/pr126-yagni-cleanup`, verify PR126 is still `isDraft: true`, and do not mark it ready for review.
