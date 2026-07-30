# Build-tier Dialect Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Build tier, every builder picks an explicit Dialect (or `from Vehicle Profile…`) with no silent `ardupilotmega`, Param/Mission XOR Firmware when not using a profile, and `*_FALSE`/`*_TRUE` enums render as true/false.

**Architecture:** Shared helpers land in `lib/metadata/naming.js` (false/true detection) and `RED.mavlink` in `nodes/mavlink-local-identity.html` (dialect select populate + catalog query). Each builder HTML adopts the Build-column visibility matrix; Param/Mission runtime reads `config.firmware` on the dialect path. Wire tiers stay Connection-profile driven.

**Tech Stack:** Node-RED editor HTML/JS, Node.js test runner, existing admin catalog routes (`/mavlink/dialects`, `/mavlink/command/commands`, …).

## Global Constraints

- Binding spec: `DESIGN.md` §6 Build column + §14 “Build catalogs come from an explicit Dialect”; session record `docs/superpowers/specs/2026-07-29-build-tier-dialect-picker-design.md`.
- No silent `ardupilotmega` when dialect/vehicle unresolved; empty = editor-invalid (Deploy/save blocked).
- No auto-pick of first Vehicle Profile or first dialect.
- Wire tiers unchanged (Connection profile for catalogs / target inherit / firmware).
- Firmware dropdown only on Param and Mission Build when not using Vehicle Profile.
- `*_FALSE` + `*_TRUE` → true/false control; other bitmasks stay multi-select.
- Hidden is not honored at runtime.
- PR size cap: `git diff --name-only origin/main...HEAD | wc -l` ≤ 50.
- Custom-node config trust rules (AGENTS.md): editor validates; runtime trusts editor-validated fields.
- Lint: `npm run lint`; tests: `npm test` (fixture suites). Do not claim lint as verification.

## File map

| Path | Role |
|---|---|
| `lib/metadata/naming.js` | `isFalseTrueEnum(entries)` |
| `lib/metadata/index.js` | re-export |
| `test/metadata/naming-false-true.test.js` | unit tests for detector |
| `nodes/mavlink-local-identity.html` | `RED.mavlink.isFalseTrueEnum`, `populateDialectSelect`, fix `currentCatalogQuery` for `__vehicle` / no silent dialect |
| `test/nodes/local-identity-html.test.js` | assert helpers present + query rules |
| `nodes/mavlink-build.html` (+ `.js` if needed) | empty dialect invalid; boolean fields; query uses dialect/`__vehicle` only |
| `nodes/mavlink-command.html` (+ `.js` Build path) | dialect row; vehicle only for `__vehicle`; boolean params |
| `nodes/mavlink-move.html` (+ `.js`) | same Build dialect pattern |
| `nodes/mavlink-payload.html` (+ `.js`) | same |
| `nodes/mavlink-param.html` + `.js` | dialect XOR firmware; runtime firmware from config |
| `nodes/mavlink-mission.html` + `.js` | same |
| `nodes/mavlink-swarm.html` | no silent dialect when catalog without connection |
| Matching `test/nodes/*-html.test.js` and runtime tests | visibility, invalid empty, firmware resolve, boolean render |

---

### Task 1: `isFalseTrueEnum` in metadata naming

**Files:**
- Modify: `lib/metadata/naming.js`
- Modify: `lib/metadata/index.js`
- Create: `test/metadata/naming-false-true.test.js`

**Interfaces:**
- Consumes: enum entry arrays shaped `{ name: string, value: number|string }[]` (valued objects only — bare name strings are rejected)
- Produces: `isFalseTrueEnum(entries) → boolean` — true iff exactly two valued entries: one `FALSE`/`*_FALSE` with value `0` and one `TRUE`/`*_TRUE` with value `1`

- [ ] **Step 1: Write failing tests**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isFalseTrueEnum } = require('../../lib/metadata/naming');

test('MAV_BOOL entries are false/true', () => {
  assert.equal(isFalseTrueEnum([
    { name: 'MAV_BOOL_FALSE', value: 0 },
    { name: 'MAV_BOOL_TRUE', value: 1 },
  ]), true);
});

test('additive bitmask without FALSE/TRUE is not false/true', () => {
  assert.equal(isFalseTrueEnum([
    { name: 'MAV_DO_REPOSITION_FLAGS_CHANGE_MODE', value: 1 },
    { name: 'MAV_DO_REPOSITION_FLAGS_RELATIVE_YAW', value: 2 },
  ]), false);
});

test('accepts bare FALSE/TRUE names', () => {
  assert.equal(isFalseTrueEnum([{ name: 'FALSE', value: 0 }, { name: 'TRUE', value: 1 }]), true);
});

test('empty or missing is false', () => {
  assert.equal(isFalseTrueEnum([]), false);
  assert.equal(isFalseTrueEnum(null), false);
});
```

- [ ] **Step 2: Run tests — expect FAIL (export missing)**

Run: `node --test test/metadata/naming-false-true.test.js`

- [ ] **Step 3: Implement + export**

In `naming.js`:

```js
function isFalseTrueEnum(entries) {
  if (!Array.isArray(entries) || entries.length !== 2) return false;
  let falseOk = false;
  let trueOk = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') return false;
    const name = entry.name;
    const isFalse = name === 'FALSE' || name.endsWith('_FALSE');
    const isTrue = name === 'TRUE' || name.endsWith('_TRUE');
    if (!isFalse && !isTrue) return false;
    const value = Number(entry.value);
    if (!Number.isInteger(value)) return false;
    if (isFalse) {
      if (value !== 0 || falseOk) return false;
      falseOk = true;
    } else {
      if (value !== 1 || trueOk) return false;
      trueOk = true;
    }
  }
  return falseOk && trueOk;
}
```

Export from `naming.js` and `lib/metadata/index.js`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/metadata/naming.js lib/metadata/index.js test/metadata/naming-false-true.test.js
git commit -m "feat(metadata): detect *_FALSE/*_TRUE enums for boolean UI"
```

---

### Task 2: Shared editor helpers (`RED.mavlink`)

**Files:**
- Modify: `nodes/mavlink-local-identity.html`
- Modify: `test/nodes/local-identity-html.test.js`

**Interfaces:**
- Consumes: `/mavlink/dialects`, jQuery selects, `RED.nodes.node`
- Produces:
  - `RED.mavlink.isFalseTrueEnum(entries)` — same rule as Task 1 (editor copy; keep in sync)
  - `RED.mavlink.populateDialectSelect($select, { saved, includeVehicleEscape: true, onReady })` — fills bundled dialects, appends `from Vehicle Profile…` (`__vehicle`), sets saved or leaves empty, triggers `change`
  - `RED.mavlink.currentCatalogQuery` — on Build: if dialect is concrete and not `__vehicle`, query `{ dialect }` only (no vehicle); if `__vehicle`, query `{ vehicle, dialect? }` from vehicle node; if dialect empty, query `{}` (no invented ardupilotmega). On wire tiers: unchanged (connection profile)

- [ ] **Step 1: Extend HTML tests** for helper names / query comments (`isFalseTrueEnum`, `populateDialectSelect`, `__vehicle`, no default dialect string in empty path)

- [ ] **Step 2: Run — expect FAIL**

Run: `node --test test/nodes/local-identity-html.test.js`

- [ ] **Step 3: Implement helpers** in the shared IIFE at top of `mavlink-local-identity.html` (listed first in `package.json`). Update `currentEnumQuery` / `currentCatalogQuery` per Interfaces.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add nodes/mavlink-local-identity.html test/nodes/local-identity-html.test.js
git commit -m "feat(editor): shared dialect select and false/true enum helpers"
```

---

### Task 3: `mavlink-build` — empty dialect invalid + boolean fields

**Files:**
- Modify: `nodes/mavlink-build.html`
- Modify: `test/nodes/build-html.test.js`
- Modify: `nodes/mavlink-build.js` only if runtime still defaults dialect to `ardupilotmega` when unset

**Interfaces:**
- Consumes: `RED.mavlink.populateDialectSelect`, `RED.mavlink.isFalseTrueEnum`
- Produces: Build tier requires non-empty dialect; `__vehicle` requires vehicle; message-field enum renderer uses boolean select when `isFalseTrueEnum(entries)` even if `display === 'bitmask'`

- [ ] **Step 1: Update/failing HTML tests** — default dialect value `''` (not `ardupilotmega`); validate requires dialect on Build; boolean branch for FALSE/TRUE; `resolveCatalogTarget` must not hardcode `ardupilotmega` when empty

- [ ] **Step 2: Run — expect FAIL**

Run: `node --test test/nodes/build-html.test.js`

- [ ] **Step 3: Implement** — switch to `populateDialectSelect`; change `defaults.dialect.value` to `''`; keep `__vehicle` escape + vehicle row visibility; in field renderer, if `isFalseTrueEnum(entries)` render single-select true/false (`data-kind: 'enum'`) saving `0`/`1`; remove silent dialect fallbacks in `resolveCatalogTarget` (empty → empty catalog key, no fetch with invented dialect)

- [ ] **Step 4: Run build HTML tests + any build runtime tests — expect PASS

- [ ] **Step 5: Commit**

```bash
git add nodes/mavlink-build.html nodes/mavlink-build.js test/nodes/build-html.test.js test/nodes/in-out-build.test.js
git commit -m "feat(build): require explicit dialect; boolean FALSE/TRUE fields"
```

---

### Task 4: `mavlink-command` — Build dialect picker + boolean params

**Files:**
- Modify: `nodes/mavlink-command.html`
- Modify: `nodes/mavlink-command.js` (Build path: profile only when `config.dialect === '__vehicle'`)
- Modify: `test/nodes/command-html.test.js`
- Modify: `test/command/node.test.js` as needed for Build + dialect

**Interfaces:**
- Consumes: Task 2 helpers; existing presets/advanced param renderers
- Produces: `defaults.dialect` (string, `''`); Build shows dialect row; vehicle row only for `__vehicle`; `resolveCatalogTarget` uses dialect/`__vehicle` with no `ardupilotmega` default; advanced/preset enum inputs use boolean when `isFalseTrueEnum`

- [ ] **Step 1: Failing HTML tests** for dialect row id, visibility vs delivery, `__vehicle`, no `let dialect = 'ardupilotmega'`, boolean branch in `advancedParamInput` / `presetParamInput`

- [ ] **Step 2: Run — expect FAIL**

Run: `node --test test/nodes/command-html.test.js`

- [ ] **Step 3: Implement editor + runtime Build profile gating**

Runtime Build (`mavlink-command.js`):

```js
const useVehicle = config.dialect === '__vehicle';
const vehicleNode = useVehicle && config.vehicle ? RED.nodes.getNode(config.vehicle) : null;
target = resolveActionTarget({
  payloadTarget,
  configSysid: config.targetSysid,
  configCompid: config.targetCompid,
  profile: profileFromVehicleNode(vehicleNode),
});
```

- [ ] **Step 4: Run command HTML + node tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add nodes/mavlink-command.html nodes/mavlink-command.js test/nodes/command-html.test.js test/command/node.test.js
git commit -m "feat(command): Build dialect picker; boolean FALSE/TRUE params"
```

---

### Task 5: `mavlink-move` — Build dialect picker

**Files:**
- Modify: `nodes/mavlink-move.html`
- Modify: `nodes/mavlink-move.js` (Build profile only for `__vehicle`)
- Modify: `test/nodes/move-html.test.js`
- Modify: `test/move/node.test.js` if Build profile tests exist

**Interfaces:** Same catalog/visibility pattern as Task 4 (no Firmware row).

- [ ] **Step 1–5:** Failing HTML tests → implement dialect/`__vehicle` visibility + runtime gating → pass → commit

```bash
git commit -m "feat(move): Build dialect picker with Vehicle Profile escape"
```

---

### Task 6: `mavlink-payload` — Build dialect picker

**Files:**
- Modify: `nodes/mavlink-payload.html`
- Modify: `nodes/mavlink-payload.js`
- Modify: `test/nodes/payload-verb-html.test.js` (or payload HTML suite)
- Modify: `test/payload/` runtime tests if Build profile inherit covered

**Interfaces:** Same as Task 5. Field-tips catalog query must not invent dialect when Build dialect empty.

- [ ] **Step 1–5:** tests → implement → pass → commit

```bash
git commit -m "feat(payload): Build dialect picker with Vehicle Profile escape"
```

---

### Task 7: `mavlink-param` — Dialect XOR Firmware + runtime

**Files:**
- Modify: `nodes/mavlink-param.html`
- Modify: `nodes/mavlink-param.js`
- Modify: `test/nodes/param-html.test.js`
- Modify: `test/param/param.test.js` and/or param node tests

**Interfaces:**
- Consumes: Task 2 helpers; `profileFromVehicleNode` / `firstDefined`
- Produces: Build shows Dialect; Vehicle only for `__vehicle`; Firmware select (`ardupilot`/`px4`/`custom`) shown+required when dialect is concrete; hidden when `__vehicle`. Runtime firmware: `firstDefined(payload.firmware, profile?.firmware, config.firmware)` with profile only on `__vehicle` or wire tier

- [ ] **Step 1: Failing tests** for firmware row visibility XOR; defaults `dialect: ''`, `firmware: ''`; validate firmware required on Build when dialect !== `__vehicle` && dialect !== ''; defs load uses dialect path without invented profile

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement HTML + runtime**

```js
// Build tier sketch
const useVehicle = config.dialect === '__vehicle';
const vehicleNode = useVehicle && config.vehicle ? RED.nodes.getNode(config.vehicle) : null;
const profile = useVehicle
  ? profileFromVehicleNode(vehicleNode)
  : { firmware: config.firmware }; // editor-required on this path
```

Wire tier unchanged (`connNode.vehicle`).

- [ ] **Step 4: Run param suites — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(param): Build dialect XOR firmware; no silent catalog default"
```

---

### Task 8: `mavlink-mission` — Dialect XOR Firmware + runtime

**Files:**
- Modify: `nodes/mavlink-mission.html`
- Modify: `nodes/mavlink-mission.js`
- Modify: `test/nodes/mission-html.test.js`
- Modify: mission runtime tests under `test/mission/`

**Interfaces:** Same XOR as Task 7; mission-type gating uses resolved firmware; `effectiveFirmware()` editor helper follows dialect/`__vehicle`/connection.

- [ ] **Step 1–5:** tests → implement → pass → commit

```bash
git commit -m "feat(mission): Build dialect XOR firmware; no silent catalog default"
```

---

### Task 9: `mavlink-swarm` — no silent dialect on Build catalogs

**Files:**
- Modify: `nodes/mavlink-swarm.html`
- Modify: `test/nodes/swarm-html.test.js`

**Interfaces:** When Build + `list` (no connection) loads MAV_CMD/enums, use Dialect / `__vehicle` pattern (add dialect row if missing). When connection governs (`all`/`filter` or wire), keep connection profile. Never default `dialect = 'ardupilotmega'`.

- [ ] **Step 1–5:** tests → implement → pass → commit

```bash
git commit -m "feat(swarm): Build list catalogs use explicit dialect"
```

---

### Task 10: Full verify + PR update

**Files:** none new (verification only)

- [ ] **Step 1: File-count gate**

Run: `git diff --name-only origin/main...HEAD | wc -l`  
Expected: ≤ 50

- [ ] **Step 2: Lint + full test**

Run: `npm run lint && npm test`  
Expected: exit 0

- [ ] **Step 3: Update PR #48 body** to note implementation complete; push branch

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| No silent `ardupilotmega` | 2–9 |
| Dialect + `from Vehicle Profile…` on Build builders | 3–9 |
| Empty invalid, no auto-pick first profile | 2–3, 4–9 validators |
| Firmware only Param/Mission XOR | 7–8 |
| Wire tiers unchanged | 4–9 (visibility leaves wire path) |
| `*_FALSE`/`*_TRUE` boolean UI | 1–4 (build+command); apply in any shared renderer those nodes use |
| Target inherit only via `__vehicle` on Build | 4–8 runtime |
| DESIGN.md already updated | done in design PR commits |
