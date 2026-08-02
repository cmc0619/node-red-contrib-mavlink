# YAGNI in the Node-RED Context — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: executing-plans / TDD for behavioral steps.

**Goal:** Apply ChatGPT’s Node-RED-context YAGNI review: keep real operational
protections; cut false lifecycle recovery and soft wrapping of uncoded internals;
reframe the param definition store as authoring data.

**Architecture:** Separate PR from lib-dedupe (#123). Bind Connection once at
deploy (Connection runtime already does this). Surface dialect/getDialect failures
loud. Rename/reframed param-defs persistence — no TTL layer to delete.

**Tech Stack:** Node.js, Node-RED custom nodes, `node --test`, DESIGN.md §2/§4/§9/§14.

## ChatGPT review — verified take / decline

| Claim | Verdict | Action |
|---|---|---|
| Keep operational error outputs, socket teardown, queue bounds, replay/signing, offline param/XML catalogs | **KEEP** | No cuts; §14 records the list |
| Remove false lifecycle recovery for direct config refs (Node-RED restarts consumers) | **TAKE** | Bind Connection once; pass into `resolveDeliveryContext`; drop silent re-`getNode` fallback |
| Stop converting uncoded internals into friendly status / soft nulls | **TAKE (narrow)** | Fail loud on `getDialect` / `loadBundled` soft-nulls; Build badge uses `err.message`. **DECLINE** ripping §9 status+`done(err)` for protocol/queue/timeout outcomes |
| Param catalog is authoring data, not a speed cache | **TAKE (framing)** | DESIGN §4 + `defs.js` wording; keep disk under `userDir` + in-process dedupe |

### Explicitly out of scope this PR

- Outer action-node catch that emits `result: 'failed'` for *every* throw — needs a
  DESIGN §9 rule for “protocol outcome vs programming bug” before a broad cut.
- Caching dialect bundle on Connection (architectural follow-on).
- Examples JSON, Command `targetSysid` leftover readers (#123).

## Global Constraints

- Branch: `cursor/yagni-nodered-context-5bd3` off `main`.
- PR size ≤50 files.
- Pre-1.0: do not say “migrate”; do not invent flow compat.
- Session lessons → DESIGN.md §4/§14.
- Config trust: editor-required refs are not revalidated per message.

## File map

| Path | Role |
|---|---|
| `lib/addressing/delivery-context.js` | Require bind-once `connectionNode` on wire tiers (no silent `getNode`) |
| `nodes/mavlink-{move,payload,param}.js` | Bind Connection at deploy; pass it; drop per-message “requires Connection” after gate |
| `nodes/mavlink-{command,mission}.js` | Already bind-once; drop redundant per-message `!connNode` gate if present |
| `lib/addressing/dialect.js` + Command/Swarm call sites | `rethrow: true` / stop empty `loadBundled` catch |
| `nodes/mavlink-build.js` | Badge truncates `err.message`, not invented `"dialect unavailable"` |
| `lib/param/defs.js` | Authoring-store comments; rename opts/comments from “cache” where user-facing |
| `DESIGN.md` | §4 param framing; §14 keep/cut table |
| Tests under `test/addressing`, `test/param`, node tests as needed | Prove bind-once; no re-getNode |

---

### Task 1: Bind-once Connection (false lifecycle recovery)

**Files:** `lib/addressing/delivery-context.js`, `nodes/mavlink-{move,payload,param,command,mission}.js`, `test/addressing/delivery-context.test.js`

- [x] **Step 1:** Wire tiers only use `opts.connectionNode` (no silent `getNode`).
- [x] **Step 2:** Move/Payload/Param bind + `missingConnectionGate` + pass `connectionNode`.
- [x] **Step 3:** Missing bind → `done(err)` only (no forged protocol status).
- [x] **Step 4:** Command/Mission: drop forged “no connection” status records.
- [x] **Step 5:** Targeted tests green.
- [ ] **Step 6:** Commit

### Task 2: Loud dialect / uncoded soft-nulls

- [x] **Step 1–3:** Command/Swarm rethrow; Build badge = `err.message`.
- [ ] **Step 4:** Commit

### Task 3: Param defs = authoring store

- [x] **Step 1–3:** Framing + `storeDir` + DESIGN §4.
- [ ] **Step 4:** Commit

### Task 4: DESIGN §14 keep/cut + ship

- [x] **Step 1:** §14 entry landed.
- [ ] **Step 2:** Push; open ready PR.
