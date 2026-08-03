# Lib Internal Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse real `lib/` holdouts (and strip the pre-1.0 Command “migrate” leftover) without merging intentional lookalikes.

**Architecture:** One PR. Each take is a small shared import or file-local helper; no new abstraction layers for non-dupes. DESIGN.md §6/§14 updated for pre-1.0 rename-only (no flow compat) and for each shared helper.

**Tech Stack:** Node.js, Node-RED custom nodes, `node --test`, ESLint gate per DESIGN.md §13.

## Global Constraints

- PR size cap: ≤50 files (`git diff --name-only main...HEAD | wc -l`).
- Branch: `cursor/<descriptive-name>-5bd3`.
- PRs opened as **draft** unless the user says otherwise.
- Pre-1.0: **no** flow “migrate” / legacy key readers. Strip leftover readers; do not invent compat.
- **`examples/**` is out of scope** for this PR. Parked in
  `docs/superpowers/plans/2026-08-02-examples-afterthought-STASH.md`.
- Do **not** merge: `numberOr`/`valueOr`/`keepParam` family (three contracts); GLOBAL_FRAMES/DEG_E7/MAV_FRAME; transport write/drain; blank-predicate mega-helper; documented intentional lookalikes.
- Session lessons → DESIGN.md affected section + §14, not chat-only.
- Also fold in prior plan-review fixes: no fetch `extractIncludes` re-export shim;
  Task 6 test path is `lib/codec/test/param-union.test.js`; catalog safe-integer
  unify is a deliberate coercion change for commands/messages; draft PR per user
  preference (not AGENTS ready-by-default).

## File map

| Path | Role |
|---|---|
| `nodes/mavlink-command.html` | Remove oneditprepare/oneditsave legacy target copy/delete |
| `lib/addressing/delivery-context.js` | Drop `config.targetSysid` / `targetCompid` fallbacks |
| `test/addressing/delivery-context.test.js` | Drop legacy-key test |
| `test/nodes/command-html.test.js` | Drop migration test |
| `DESIGN.md` | Rewrite migrate §14; note shared helpers |
| `lib/connection/peer-table.js` | Import `endpointKey` from `./endpoint-key` |
| `lib/state/index.js` | Import `deepCopy` from `../connection/clone` |
| `lib/metadata/fetch.js` | Import `extractIncludes` from `./xml-catalog` |
| `lib/connection/queue.js` | `_bestItem(now)` used by dequeue/peek |
| `lib/command/lookup.js` (new) | `commandByValue(bundle, commandId)` |
| `lib/command/index.js` | Re-export lookup |
| `lib/command/carrier.js` | Use `commandByValue`; file-local `num` once |
| `lib/payload/index.js` | Import `commandByValue` from command |
| `lib/metadata/commands-list.js` | `nameValueLabel`, `mapEnumEntries` (+ export) |
| `lib/metadata/messages-list.js` | Use shared label + enum map |
| `lib/metadata/enums-list.js` | Use shared `mapEnumEntries` (keep `enumEntryValue` there or move) |
| `lib/param/index.js` | Derive `PARAM_TYPE` from codec `PARAM_TYPES` |
| `lib/codec/param-union.js` / `lib/codec/index.js` | Export only if needed for derivation (already exports `PARAM_TYPES`) |
| Tests under `test/` matching each area | Adjust imports / add focused assertions |

---

### Task 1: Strip Command pre-1.0 “migrate” leftovers

**Files:**
- Modify: `nodes/mavlink-command.html` (oneditprepare block ~180–193, oneditsave deletes ~690–692)
- Modify: `lib/addressing/delivery-context.js` (header + `firstDefined(..., config.targetSysid)`)
- Modify: `test/addressing/delivery-context.test.js`
- Modify: `test/nodes/command-html.test.js` (remove migration test)
- Modify: `DESIGN.md` §6 Command field note + §14 migrate entries → pre-1.0 rename-only

**Interfaces:**
- Produces: runtime/editor read only canonical `targetSystem` / `targetComponent`
- Does **not** touch `examples/**` (see STASH note)

- [ ] **Step 1:** Delete editor leftover-key copy/delete blocks (`oneditprepare` / `oneditsave`).
- [ ] **Step 2:** In `resolveDeliveryContext`, pass only `config.targetSystem` /
  `config.targetComponent` (no `targetSysid` / `targetCompid` fallbacks; drop
  unnecessary `firstDefined` around those two config fields).
- [ ] **Step 3:** Remove tests that assert leftover-key acceptance / editor copy.
- [ ] **Step 4:** Rewrite DESIGN §6/§14: pre-1.0 means rename shipped assets later
  if needed — **no** flow compat, **do not say migrate**.
- [ ] **Step 5:** `node --test test/addressing/delivery-context.test.js test/nodes/command-html.test.js test/command/node.test.js`
- [ ] **Step 6:** Commit `fix(command): drop leftover targetSysid readers`

---

### Task 2: endpointKey + deepCopy holdouts

**Files:**
- Modify: `lib/connection/peer-table.js` — remove private `endpointKey` at ~479; `require('./endpoint-key')`. Note: shared helper tolerates null endpoint; peer-table’s private copy assumed a defined `{address,port}` — call sites must still be valid.
- Modify: `lib/state/index.js` — remove JSON deepCopy; `const { deepCopy } = require('../connection/clone')`
- Test: existing peer-table / state / subscription tests; add a tiny state test that `NaN` survives snapshot copy if none exists

- [ ] **Step 1:** Wire imports; delete private copies.
- [ ] **Step 2:** Run `node --test test/connection/ test/state/` (or matching paths that exist).
- [ ] **Step 3:** Commit `refactor: share endpointKey and NaN-safe deepCopy`

---

### Task 3: extractIncludes + queue best-item

**Files:**
- Modify: `lib/metadata/fetch.js` — `const { extractIncludes } = require('./xml-catalog')`;
  delete the private copy **and** drop it from `module.exports` (nothing imports it
  from fetch; do not leave a re-export “compat” shim).
- Modify: `lib/connection/queue.js` — private `_bestItem(now)` with the shared 10-line scan; `dequeue` removes, `peek` returns.
- Test: `test/metadata/xml-catalog.test.js`, `test/connection/` queue tests

- [ ] **Step 1:** Point fetch at xml-catalog’s stricter extractor (strips comments).
- [ ] **Step 2:** Deduplicate queue scan.
- [ ] **Step 3:** Run matching tests; commit `refactor: share extractIncludes and queue best-item`

---

### Task 4: commandByValue + carrier `num`

**Files:**
- Create: `lib/command/lookup.js` with `commandByValue(bundle, commandId)` (same body as payload today).
- Modify: `lib/command/index.js` — export it.
- Modify: `lib/command/carrier.js` — `intCoordKinds` uses `commandByValue`; replace three identical `const num = ...` arrows with one file-local `function num(value)`.
- Modify: `lib/payload/index.js` — import from `../command` (or `../command/lookup`); remove local definition; keep re-export if tests import from payload.

**Why not payload→carrier:** payload already requires `../command`; reverse import would cycle.

- [ ] **Step 1:** Add lookup module; switch carrier + payload.
- [ ] **Step 2:** File-local `num` in carrier.
- [ ] **Step 3:** `node --test test/command/ test/payload/`
- [ ] **Step 4:** Commit `refactor(command): share commandByValue and carrier num`

---

### Task 5: Catalog label + enum-entry mapping

**Files:**
- Modify: `lib/metadata/commands-list.js` — add/export:
  - `nameValueLabel(name, value)` → `` `${name} (${value})` ``
  - `mapEnumEntries(table)` using **enums-list’s safe-integer coercion** (move
    `enumEntryValue` here). This **changes** commands/messages catalogs, which
    today use bare `Number(entry.value)` — deliberate; stock `common.xml` has no
    unsafe integers, but private dialects might.
- Modify: `lib/metadata/messages-list.js` — use `nameValueLabel` + `mapEnumEntries`; drop private `messageLabel` and duplicate enum map.
- Modify: `lib/metadata/enums-list.js` — use shared `mapEnumEntries` / `enumEntryValue`.
- `commandLabel` / `enumOptionLabel` become thin wrappers or call `nameValueLabel`.
- Test: mirror the enums-list safe-integer case for a commands or messages catalog path.

- [ ] **Step 1:** Centralize helpers in commands-list (already the shared hub for `enumOptionLabel`).
- [ ] **Step 2:** Switch messages-list + enums-list.
- [ ] **Step 3:** Run metadata/editor catalog tests; commit `refactor(metadata): share catalog labels and enum entry map`

---

### Task 6: Derive param PARAM_TYPE from codec PARAM_TYPES

**Files:**
- Modify: `lib/param/index.js` — build `PARAM_TYPE` from `require('../codec').PARAM_TYPES` (name→Number(key)); keep local `resolveParamType` returning **number** and `isKnownParamType`.
- Do **not** replace with codec’s `resolveParamType` (returns info object + `fail()`).

```js
const { PARAM_TYPES, paramValueFromWire, paramValueToWire } = require('../codec');
const PARAM_TYPE = Object.fromEntries(
  Object.entries(PARAM_TYPES).map(([code, info]) => [info.name, Number(code)])
);
```

- [ ] **Step 1:** Derive table; keep numeric resolver API.
- [ ] **Step 2:** `node --test test/param/ lib/codec/test/param-union.test.js`
- [ ] **Step 3:** Commit `refactor(param): derive PARAM_TYPE from codec PARAM_TYPES`

---

### Task 7: DESIGN.md + verify + draft PR

**Files:**
- Modify: `DESIGN.md` §6 platform/helpers note + §14 for: endpointKey, deepCopy, extractIncludes, queue best-item, commandByValue, catalog map, PARAM_TYPE derivation, pre-1.0 no-migrate.
- Run full lint + `npm test` (or project’s documented test script).
- File count check ≤50.
- Push branch; open **draft** PR.

- [ ] **Step 1:** §14 entries (wrong belief → fact → check) for each take.
- [ ] **Step 2:** Full test/lint.
- [ ] **Step 3:** Push + draft PR body listing take/decline table.

---

## Out of scope (approved declines/skips)

- **`examples/**`** — see `2026-08-02-examples-afterthought-STASH.md`
- `numberOr` / `valueOr` / `keepParam` / mission `num` unification
- GLOBAL_FRAMES / DEG_E7 / isGlobalFrame / MAV_FRAME tables
- TCP vs serial write/drain skeleton
- Shared blank predicate helper
- AckWaiter vs swarm fan-in; mask helpers; NUL trim variants; ABSOLUTE_ALT vs GLOBAL; parseSysid lenient vs strict
