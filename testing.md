# SITL example live testing

Live runs of every flow under `examples/sitl/` against the Docker lab
(`sitl/docker-compose.yml` `--profile sitl` + `--profile nodered`).

| | |
|---|---|
| **Latest run** | 2026-07-31 04:34–04:45 UTC (retest) |
| **Prior run** | 2026-07-31 ~03:28–03:40 UTC |
| **Host** | Cloud agent VM, Node-RED `http://127.0.0.1:1880` |
| **Repo** | `main` @ `2eca0a6` (+ harness tweaks on this branch) |
| **Fleet** | AP 1–5 (`14550`), PX4 11–15 (`14560`), companions 20 / 21 |
| **Harness** | `node sitl/run-example-suite.js` → `sitl/example-suite-results.json` |

**Verdict key:** **PASS** = story observed · **PARTIAL** = useful progress but story incomplete · **FAIL** = blocked or wrong outcome · **SKIP** = needs setup the API deploy cannot provide

## Summary (retest 04:34 UTC)

| # | File | Verdict | Δ vs first run | Notes |
|---|------|---------|----------------|-------|
| 01 | `01-completion-takeoff.json` | **PARTIAL** | was PASS | Arm accepted; takeoff **DENIED** (`resultCode: 4`) — vehicle not in GUIDED this pass |
| 02 | `02-completion-timeout.json` | **FAIL** | was mis-labelled PASS | Immediate DENIED (3 ms), not accept→completion-timeout |
| 03 | `03-temporarily-rejected.json` | **PARTIAL** | same | Arm accepted (no TEMPORARILY_REJECTED — not a fresh boot). Takeoff DENIED |
| 04 | `04-mode-tables.json` | **PARTIAL** | same | AP GUIDED ok; PX4 POSCTL **temporarily_rejected** |
| 05 | `05-px4-param-union.json` | **PASS** | same | Set→read echo succeeded |
| 06 | `06-mission-fence-rally.json` | **PASS** | same | AP mission/fence/rally ok; PX4 fence fail-loud as designed |
| 07 | `07-mission-failloud.json` | **PARTIAL** | was mis-labelled PASS | Good up/down ok; “bad” upload still **succeeded** (`unexpected ok`) |
| 08 | `08-swarm-sequential-five.json` | **PASS** | same | Dry-run + live sequential arm ×5 succeeded |
| 09 | `09-swarm-member-expires.json` | **PASS** | was PARTIAL | Kill `nrc-ap-3` mid-fan-out: members **1,2,4,5 accepted**, **3 timeout**; aggregate `failed` |
| 10 | `10-dual-stack-ten.json` | **PASS** | was FAIL | After `selectionMode: all` fix: AP + PX4 **broadcast succeeded** (5+5) |
| 11 | `11-broadcast-vs-sequential.json` | **PARTIAL** | same tier | Sequential ×5 succeeded; broadcast+**confirm** timed out waiting for ACKs (not refused) |
| 12 | `12-signing.json` | **SKIP** | was FAIL | No signing passphrase via Admin API deploy — editor credentials required |
| 13 | `13-param-defs-live.json` | **PARTIAL** | same | Read + list succeeded; set echo-confirm timed out |
| 14 | `14-command-mission-basics.json` | **PASS** | same | Arm, message-interval, mission up/down ok |
| 15 | `15-companion-ap.json` | **PASS** | was UNKNOWN | NVF `sent` on `14540` |
| 16 | `16-companion-px4.json` | **PASS** | was UNKNOWN | NVF `sent` on `14542` |
| 17 | `17-int-carrier-goto.json` | **PASS** | same | Arm + takeoff + COMMAND_INT goto all **accepted** |

**Totals (human-curated, retest):** PASS **9** · PARTIAL **6** · FAIL **1** · SKIP **1**

First-run totals for comparison: PASS 8 · PARTIAL 6 · FAIL 2 · SKIP 1  
(Biggest wins: **09** member-timeout story, **10** broadcast after example fix.)

## Environment notes

- PX4: `MAV_SYS_ID` before `commander start` (lab entrypoint). Live params used: `COM_RCL_EXCEPT=7`, `COM_ARM_MAG_STR=0`, `MAV_0_BROADCAST=1`.
- Example 10/11 broadcast nodes now use `selectionMode: "all"` (PR #76 / `a639779`) — required; `list` + `broadcast` is refused by design.
- Example 17 goto z must be NaN (or real AMSL); relative finite z is treated as AMSL by PX4.
- One flow at a time (shared UDP binds). Harness clears to an idle tab between examples.

## Per-example detail (retest)

### 01 — Completion takeoff — PARTIAL

- Arm `accepted` (ack)
- Takeoff `failed` / `resultCode: 4` (DENIED) — completion-at-altitude path not reached
- Prior run the same day: takeoff `accepted`, `confirmedBy: state`, `alt 9.5 m`

### 02 — Completion timeout — FAIL (vs story)

- Takeoff DENIED in ~2 ms — never enters the completion-timeout wait
- Story wants: accepted command that never climbs → named timeout

### 03 — Temporarily rejected — PARTIAL

- `once` inject at deploy; fleet already GPS-locked → no TEMPORARILY_REJECTED
- Arm accepted; takeoff DENIED

### 04 — Mode tables — PARTIAL

- PX4 POSCTL → `temporarily_rejected`
- Dual binds `14550` + `14560` ok

### 05 — PX4 param union — PASS

- Set then read **succeeded**

### 06 — Mission / fence / rally — PASS

- AP uploads succeeded
- PX4 fence: `px4 does not support fence over the mission protocol`

### 07 — Mission fail-loud — PARTIAL

- Good upload/download succeeded
- Bad upload still reported **succeeded** (`debug:bad upload (unexpected ok)`)

### 08 — Swarm sequential ×5 — PASS

- Dry-run `dry_run`; live `succeeded`

### 09 — Swarm member expires — PASS

- Stopped `nrc-ap-3` ~800 ms after inject (500 ms pacing)
- Aggregate `failed`, `count: 5`, members: 1/2/4/5 `accepted`, **3 `timeout`** (`no COMMAND_ACK`)
- State node emitted expired peer events while ap-3 was down; container restarted after

### 10 — Dual-stack ×10 — PASS

- AP broadcast `succeeded` (sysids 1–5 `sent`, `target_system: 0`)
- PX4 broadcast `succeeded` (11–15)
- Warning noted: `mixed flight modes in broadcast selection` (harmless for arm)

### 11 — Broadcast vs sequential — PARTIAL

- Sequential confirm: **succeeded** (5/5)
- Broadcast confirm: **failed** — `no COMMAND_ACK received within timeout` (delivery `confirm` on broadcast is ack-noisy / unreliable here; `send` tier on 10 worked)

### 12 — Signing — SKIP

- `sign-outbound is enabled but no signing passphrase is set`
- Needs editor `flows_cred`; not exercisable via JSON-only Admin API deploy

### 13 — Param defs live — PARTIAL

- Read + full list succeeded; set `ARMING_CHECK` echo timeout

### 14 — Command & mission basics — PASS

- Arm sysid 1; GLOBAL_POSITION_INT rate request; mission up/down sysid 2

### 15 / 16 — Companions — PASS

- `NAMED_VALUE_FLOAT` send tier `sent`

### 17 — INT carrier goto — PASS

- Arm + takeoff + INT `DO_REPOSITION` all `accepted`
- Flight-validated earlier same day (z=`NaN`): arrived at configured lat/lon sub-metre

## Re-run

```bash
cd sitl && docker compose --profile sitl --profile nodered up -d
node sitl/run-example-suite.js --out sitl/example-suite-results.json
node sitl/run-example-suite.js --only 05,10,17   # subset
```

Update this file when re-running; keep `sitl/example-suite-results.json` as the machine-readable log.
