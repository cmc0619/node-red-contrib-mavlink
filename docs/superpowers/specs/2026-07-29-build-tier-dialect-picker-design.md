# Build-tier dialect picker + boolean enum controls

Approved design (2026-07-29). Binding text lands in `DESIGN.md` §6 / §14; this file is the
session record for the implementation plan.

## Problem

1. Sender Build tiers show a Vehicle Profile picker and, when it is empty, silently load the
   `ardupilotmega` catalog. That invents a dialect the user never chose.
2. `MAV_BOOL` (and similar `*_FALSE` / `*_TRUE` enums) are marked bitmask in upstream metadata,
   so editors render a ctrl-click multi-select instead of true/false.
3. The Build node already has the better pattern (dialect list + `from Vehicle Profile…`);
   other builders should match it.

## Decision (approach 1)

Align every Build-tier builder with the Build node's dialect picker. Wire tiers stay on the
Connection's Vehicle Profile. Param/Mission additionally require an explicit Firmware field
when Build is not using a Vehicle Profile.

## §6 matrix — Build column (senders + Build node)

| Field | Build | Wire tiers |
|---|---|---|
| Dialect | shown — bundled list + `from Vehicle Profile…` | hidden — Connection profile dialect |
| Vehicle Profile | shown **only** when dialect is `from Vehicle Profile…` | hidden — via Connection |
| Firmware | **Param / Mission only:** shown when not using Vehicle Profile; required with dialect | hidden — via Connection |
| Connection / identity / timing | unchanged (hidden on Build) | unchanged |

### Catalog source rules

- **No silent `ardupilotmega`.** Unresolved dialect/vehicle → empty catalog + editor invalid
  (Deploy/save blocked). Cancel is fine.
- Fresh nodes start with empty dialect (invalid) until the user picks a real bundled dialect or
  `from Vehicle Profile…` with a real profile. Empty dialect never invents `__vehicle` from a
  leftover vehicle id (pre-1.0: no flow migration).
- **`from Vehicle Profile…`:** Vehicle may be left empty; that state stays errored until a
  profile is selected. No auto-default to the “first” profile.
- Concrete dialect selected → Vehicle Profile is hidden and ignored at runtime (hidden is not
  honored).
- Wire tiers unchanged: catalogs, blank target inherit, and firmware come from the Connection's
  bound Vehicle Profile.

### Runtime on Build

Target resolution (sysid/compid independently):

1. `msg.payload.target`
2. companion derivation (wire tiers only; Build has no send-as)
3. node config target
4. profile default **only** when Build used `from Vehicle Profile…` (or wire tier Connection
   profile); otherwise nothing — blank stays unresolved (no invented `{1,1}`)

Firmware (Param / Mission Build):

- Vehicle Profile path → `profile.firmware`
- else → node Firmware field (editor-required)
- `msg.payload.firmware` overrides either

### Nodes in scope

- `mavlink-build` (tighten: no silent default; empty invalid)
- `mavlink-command`, `mavlink-move`, `mavlink-param`, `mavlink-payload`, `mavlink-mission`
- `mavlink-swarm` where Build loads a MAV_CMD/enum catalog without a governing Connection
  profile (same no-silent-default + dialect / `__vehicle` pattern)

## Boolean vs bitmask controls

When an enum is an **exact binary** false/true pair — exactly two members, `*_FALSE`/`FALSE`
value `0` and `*_TRUE`/`TRUE` value `1` (e.g. `MAV_BOOL`) — every builder uses a **true/false**
control, not the bitmask multi-select.

- Wire values come from the enum entries (`0` / `1`).
- Tables with extra members or non-0/1 FALSE/TRUE (e.g. `GIMBAL_AXIS_CALIBRATION_REQUIRED`)
  stay ordinary selects / bitmask multi-select as otherwise marked.
- Other bitmask-marked enums stay multi-select. Upstream `bitmask` / value-shape heuristics do
  not reliably distinguish additive masks from exclusive or mixed enums — caveat emptor.

## Non-goals

- Changing wire-tier Connection / identity / target reshape
- Auto-selecting the first Vehicle Profile or first dialect
- Inventing a new “is additive bitmask?” detector beyond the false/true exception
- Showing Firmware on Command / Move / Payload / Build (unused there)

## Testing (implementation plan will detail)

- Editor HTML tests: Build-tier visibility (dialect / vehicle / firmware XOR), invalid empty,
  no `ardupilotmega` fallback in `resolveCatalogTarget`
- Enum renderer: `*_FALSE`/`*_TRUE` → boolean control; other bitmasks unchanged
- Runtime: Build + concrete dialect does not inherit profile targets; Param/Mission firmware
  from field vs profile
- Admin catalog routes: dialect-only still serves named bundled dialects; editors must not
  request a default dialect when unset
- `DESIGN.md` §6 / §14 already updated in the same change as this spec
