# Custom Path Is Normal (YAGNI mop) Implementation Plan

> **SUPERSEDED 2026-08-02 — do not execute.** This plan's premise was wrong. Calling
> `customDialectPath` a "normal" source did not change the fact that no editor control can
> create it, so it was a leftover-key reader wearing a different label. The keys, the
> `legacy-path` Version option, and the `oneditsave` that preserved them were deleted; see
> DESIGN.md §4 and the §14 entry "A leftover key is not made legitimate by calling it a
> normal source." Kept as a record of the displaced belief.

> **For agentic workers:** REQUIRED SUB-SKILL: executing-plans / TDD for the test step.

**Goal:** Stop treating `customDialectPath` profiles as exotic edge cases, and stop
justifying catalog/`getDialect` behavior with install-catastrophe stories
(snapshot vanished, deps missing, path “gone”). Prove the normal path.

**Architecture:** Docs + one focused test. No new soft bodies, no new helpers.

**Tech Stack:** Node.js `node:test`, existing `resolveDialect` / `resolveCatalogSource`.

## Global Constraints

- Stay on `cursor/lib-internal-dedupe-5bd3` / PR #123 (≤50 files).
- Pre-1.0: no flow “migrate” language.
- Do **not** invent branches for: catalog snapshot deleted, BrokenVehicleNode,
  “legacy path gone.” Those are gravity-fails — if they happen, the install is
  already broken; do not design admin-catalog around them.
- Session lesson → DESIGN.md §4 + §14.

## File map

| Path | Role |
|---|---|
| `test/metadata/admin-catalog.test.js` | Prove customDialectPath → getDialect → catalog bundle |
| `lib/metadata/admin-catalog.js` | Scrub catastrophe-justification comments |
| `DESIGN.md` | §4: custom path is a normal runtime source; §14: YAGNI lesson |

---

### Task 1: Failing test for the normal custom path

**Files:** `test/metadata/admin-catalog.test.js`

- [x] **Step 1:** Write a test that compiles a temp XML via
  `resolveDialect({ dialectSource: 'custom', customDialectPath })`, stubs a
  Vehicle Profile `getDialect()` returning that bundle, and asserts
  `resolveCatalogSource` returns `{ kind: 'bundle', bundle }` with the compiled
  dialect name (not a invented bundled fallback).
- [x] **Step 2:** Run `node --test test/metadata/admin-catalog.test.js` (expect pass
  with current code — this is proof, not a regression hunt).

### Task 2: DESIGN + comment scrub

**Files:** `DESIGN.md`, `lib/metadata/admin-catalog.js`

- [x] **Step 1:** Rewrite §4 “Legacy custom path”: deployed
  `dialectSource: custom` + `customDialectPath` is a **normal** `getDialect()`
  source. Editor no longer offers a free-text path for *new* dialects; existing
  path profiles stay first-class until the user picks Seed/a date.
- [x] **Step 2:** Rewrite the §14 admin-catalog bullet: fail-loud =
  surface `err.message`; do not invent soft `"dialect unavailable"` bodies;
  do **not** cite snapshot-deleted / broken-deps / path-gone as design drivers.
  Check must include the new custom-path catalog test.
- [x] **Step 3:** Shorten admin-catalog header: call `getDialect()`, propagate;
  no lecture about gravity.

### Task 3: Verify + ship

- [x] **Step 1:** `npx eslint lib/metadata/admin-catalog.js test/metadata/admin-catalog.test.js`
- [x] **Step 2:** `node --test test/metadata/admin-catalog.test.js test/vehicle/vehicle.test.js`
- [x] **Step 3:** Commit, push, update PR #123 body if needed.
