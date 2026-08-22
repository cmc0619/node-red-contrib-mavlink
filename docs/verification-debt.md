# Verification debt — 1.0.0 release inventory

Audit date: **2026-08-22**. Method: parse `DESIGN.md` §14 status tags and grep
for `unmeasured` / `not yet measured` / `source-read` on shipped paths.

This is the inventory behind the **1.0.0 release posture** recorded in
`DESIGN.md` §14.132. It is work tracking, not a ruling — rulings stay in §14.

## Summary

| bucket | count | meaning |
|---|---:|---|
| Rig-only (🧪, no ✔) | **29** | SITL/lab measurements kept as recorded; code and cited tests exist in-tree but were not re-probed on 2026-08-19 |
| Source-read (📖, no ✔) | **14** | Upstream/spec hypotheses recorded on the cited date; no matching rig row in §14 |
| Open subclaims | **7** | Named gaps inside otherwise-settled §14 entries or on shipped editor/runtime paths |
| **Source-read debt (reported)** | **21** | 14 header rows + 7 open subclaims (the external audit's headline number) |

**Release posture:** documented, **not blocking 1.0.0** (§14.132). Every shipped-path
item below either has an editor withhold, is absent from the operator surface, or is
labelled in help as source-read. None are silent false-success paths.

## Rig-only entries (29)

Fourteen §14 headers carry 🧪 without ✔. Fifteen more (14.116–14.130) inherit 🧪
from the section header *"All 🧪 — lab facts, kept as recorded"*.

| §14 | title |
|---|---|
| 14.36 | Payload form repaint timing (~3 ms) |
| 14.78 | Local-frame COMMAND_INT x/y scale (metres × 1e4) |
| 14.80 | PARAM_VALUE echo decoded by frame `param_type` |
| 14.82 | Parameter encoding not discoverable on ArduPilot |
| 14.83 | Wide bitmask c-cast loss reports success |
| 14.94 | Local-frame position triplet absolute vs offset per firmware |
| 14.95 | Same run refuted advisories / killed Force mode |
| 14.98 | Move SITL queue findings (#175/#179) |
| 14.108 | PX4 one-shot DO_REPOSITION + CHANGE_MODE gate |
| 14.109 | PX4 stick-driven mode airborne without RC |
| 14.110 | PX4 DO_SET_MODE wants main_mode in param2 |
| 14.114 | Fan-out arm examples need probe-arm |
| 14.116–14.130 | SITL lab operations (15 entries) |

**Exposure:** lab harness, examples under `examples/sitl/`, and operator docs that
cite measured behaviour. Not a driver-validation gap — the runtime sends what it is
handed (§0).

## Source-read headers (14)

| §14 | title |
|---|---|
| 14.3 | Bind-mounted source is not an installed package |
| 14.12 | Enum defined in another dialect file |
| 14.13 | `ardupilotmega.xml` byte-identical upstream |
| 14.57 | Packet seq cannot deduplicate across links |
| 14.58 | Signing is v2-only |
| 14.59 | Invalid signature not unconditionally rejected |
| 14.85 | No library coming for param bit/int hazards |
| 14.88 | `MAV_PROTOCOL_CAPABILITY` bitmask can lie |
| 14.100 | `LOCAL_OFFSET_NED` (7) on ArduPlane |
| 14.101 | Motion message honour is per vehicle family |
| 14.102 | ArduSub MANUAL_CONTROL vertical axis 0..1000 |
| 14.111 | Capability field presence ≠ capability |
| 14.77 | COMMAND_INT x/y has no cross-fleet sentinel |
| 14.99 | ArduPilot copter yaw is command-only |

## Open subclaims (7)

These are the gaps the external audit flagged on **shipped paths**. Each is named in
§14 or the editor; none rely on silent runtime refusal.

| id | §14 / path | claim | shipped mitigation |
|---|---|---|---|
| 14.100-stream | 14.100, `mavlink-move` help + `refreshDeliveryOptions` | Repeating offset stream walks the vehicle | **Stream withheld** when `reference === 'offset'`; help states why |
| 14.98.6 | 14.98.6 | `GUID_TIMEOUT` parks yaw after ~3 s | Turn is command-tier; documented in §14.98 |
| 14.98.5 | 14.98.5 | Commanded yaw rate is not a speed limit near target | Documented; no editor promise of rate limiting |
| 14.108-loiter | 14.108 | PX4 flag-clear from AUTO_LOITER | `changeMode` opt-in on Go to; measured gate on both stacks |
| 14.108-heading | 14.108 | Goto resulting heading not captured | Does not affect send/refuse; completion uses ack not heading |
| 14.79-SITL | 14.79 | Takeoff completion not SITL-measured | **Unit-tested** (`test/command/completion.test.js`); frame datum rule explicit |
| 14.95-terrain | 14.95 | Terrain frame datum honour not instrumented | **Terrain alt ref absent** from Move surface (`lib/move/action.js`) |

## What would move the needle after 1.0.0

Priority if measurement budget appears — ordered by operator-visible uncertainty, not
by count:

1. **Offset stream walk** (14.100-stream) — confirm the withhold reason on AP Copter
   at rate; cheap SITL probe, validates editor policy.
2. **14.98 yaw subclaims** — GUID_TIMEOUT + rate-vs-limit near target; informs Turn
   help text only.
3. **14.79 takeoff completion** — one SITL climb at non-zero home elevation; closes the
   last command-completion rig gap.
4. **14.108 PX4 AUTO_LOITER flag-clear** — one-field twin on the lab SIH.
5. **Lab ops 14.116–14.130** — re-run when the SITL image or AP binary bumps; not
   user-runtime debt.

## Regenerating this inventory

```bash
node scripts/inventory-verification-debt.js
```

Compares parsed §14 tags against the tables above and fails on drift.
