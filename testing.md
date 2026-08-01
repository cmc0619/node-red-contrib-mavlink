# SITL example live testing

Live runs of every flow under `examples/sitl/` against the Docker lab
(`sitl/docker-compose.yml` `--profile sitl` + `--profile nodered`).

| | |
|---|---|
| **Latest run** | 2026-08-01 **04:20–04:31 UTC** (run 5) |
| **Prior runs** | 03:50–04:00 (run 4); 2026-07-31 05:01–05:12 (run 3); 04:34–04:45 (run 2); ~03:28–03:40 (run 1) |
| **Host** | Cloud agent VM, Node-RED `http://127.0.0.1:1880` |
| **Repo** | `main` @ `403a680` (after PR #80 codec raw-surface + PR #79 prebuilt AP) |
| **Fleet** | AP 1–5 (`14550`), PX4 11–15 (`14560`), companions 20 / 21 |
| **Harness** | `node sitl/run-example-suite.js` → `sitl/example-suite-results.json` |
| **Prep (run 5)** | Restarted `nrc-nodered` to pick up PR #80; PX4-11 `MAV_0_BROADCAST=1`, `COM_RCL_EXCEPT=7`, `COM_ARM_MAG_STR=0`; AP prebuilt + `copter.parm` |

**Verdict key:** **PASS** = story observed · **PARTIAL** = useful progress but story incomplete · **FAIL** = blocked or wrong outcome · **SKIP** = needs setup the API deploy cannot provide

Harness auto-verdicts in the JSON are a first pass only — several false positives are called out below. **Totals are human-curated.** See also [`sitl/AGENTS.md`](sitl/AGENTS.md).

## Summary (run 5)

| # | File | Verdict | Notes |
|---|------|---------|-------|
| 01 | `01-completion-takeoff.json` | **PASS** | Arm ack → takeoff complete **alt 9.2 m** (`confirmedBy: state`, ~8.5 s) — regained vs run 4 |
| 02 | `02-completion-timeout.json` | **FAIL** | Immediate DENIED (`resultCode: 4`, ~4 ms). Harness auto-PASS is wrong (node name contains “timeout”) |
| 03 | `03-temporarily-rejected.json` | **PARTIAL** | Arm `accepted` (no TEMPORARILY_REJECTED). Takeoff DENIED |
| 04 | `04-mode-tables.json` | **PARTIAL** | PX4 POSCTL **temporarily_rejected** |
| 05 | `05-px4-param-union.json` | **PASS** | Set→read echo **succeeded** |
| 06 | `06-mission-fence-rally.json` | **PASS** | AP mission/fence/rally ok; PX4 fence fail-loud |
| 07 | `07-mission-failloud.json` | **PARTIAL** | Good+bad upload both **succeeded** (`count: 0`) — fail-loud not proven. Harness auto-PASS |
| 08 | `08-swarm-sequential-five.json` | **PASS** | Dry-run + live sequential arm ×5 **succeeded** |
| 09 | `09-swarm-member-expires.json` | **PARTIAL** | Kill `nrc-ap-3` mid-run too late — aggregate **succeeded**. Harness auto-PASS |
| 10 | `10-dual-stack-ten.json` | **PASS** | AP + PX4 broadcast **succeeded** (`selectionMode: all`) |
| 11 | `11-broadcast-vs-sequential.json` | **PARTIAL** | Sequential confirm **succeeded**; broadcast+confirm **unconfirmed** |
| 12 | `12-signing.json` | **SKIP** | No signing passphrase via Admin API deploy |
| 13 | `13-param-defs-live.json` | **PARTIAL** | Read + list ok; set `ARMING_CHECK` echo-confirm **timed out** |
| 14 | `14-command-mission-basics.json` | **PASS** | Arm, message-interval, mission up/down ok |
| 15 | `15-companion-ap.json` | **PASS** | NVF **sent** on `14540` |
| 16 | `16-companion-px4.json` | **PASS** | NVF **sent** on `14542` |
| 17 | `17-int-carrier-goto.json` | **PASS** | PX4 arm + takeoff + COMMAND_INT `DO_REPOSITION` all **accepted** |

**Totals (run 5, curated):** PASS **9** · PARTIAL **6** · FAIL **1** · SKIP **1**

### Trend

| Run | PASS | PARTIAL | FAIL | SKIP | Notes |
|-----|------|---------|------|------|-------|
| 1 (~03:28) | 8 | 6 | 2 | 1 | 10/11 blocked by list+broadcast |
| 2 (04:34) | 9 | 6 | 1 | 1 | |
| 3 (05:01) | **10** | 5 | 1 | 1 | 01 takeoff complete; 10 broadcast ok |
| 4 (03:50) | 8 | 7 | 1 | 1 | First prebuilt AP; takeoff/01 slipped |
| **5 (04:20)** | **9** | **6** | **1** | **1** | Post-PR #80; **01** takeoff restored (alt 9.2 m) |

PR #80 (codec raw surface / no degE7 scaling) did not regress the live suite. Stable PASS: **01, 05, 06, 08, 10, 14–17**. Persistent gaps unchanged: **02**, **07**, **12**, **04** PX4 mode, **11** broadcast+confirm, **13** param echo, **09** kill timing.

## Environment notes

- ArduPilot: official prebuilt Copter-4.7.0 + `copter.parm` (`sitl/AGENTS.md`).
- PX4: `MAV_SYS_ID` before commander; live arming helpers on px4-11.
- After library merges, **restart `nrc-nodered`** so `install-and-start.sh` reinstalls the bind-mounted package.
- Broadcast swarm: `selectionMode: "all"`.
- Example 17 goto z = NaN (or real AMSL).

## Per-example detail (run 5)

### 01 — PASS
Arm `accepted`; takeoff `accepted`, `confirmedBy: state`, detail `alt 9.2 m`, elapsed 8507 ms.

### 02 — FAIL (vs story)
Takeoff `failed` / `resultCode: 4` in 4 ms. Story wants completion-timeout after accept.

### 03 — PARTIAL
Arm `accepted` retries 0; takeoff DENIED. Needs fresh-boot race for TEMPORARILY_REJECTED.

### 04 — PARTIAL
PX4 POSCTL → `temporarily_rejected`.

### 05 — PASS
Param set→read **succeeded**.

### 06 — PASS
AP uploads ok; PX4 fence: `px4 does not support fence over the mission protocol`.

### 07 — PARTIAL
Good and bad uploads both **succeeded** with empty plan — fail-loud not demonstrated.

### 08 — PASS
Dry-run + live sequential arm ×5.

### 09 — PARTIAL
Aggregate `succeeded` (all accepted); mid-run kill of ap-3 did not produce a failed member.

### 10 — PASS
AP + PX4 broadcast arm aggregates **succeeded**.

### 11 — PARTIAL
Sequential confirm **succeeded**; broadcast confirm failed (`unconfirmed`).

### 12 — SKIP
`sign-outbound` without passphrase on API deploy.

### 13 — PARTIAL
Read/list succeeded; set `ARMING_CHECK` echo timeout.

### 14 — PASS
Arm sysid 1; rate request sent; mission download sysid 2 `count: 1`.

### 15 / 16 — PASS
Companion NVF `sent`.

### 17 — PASS
PX4 sysid 11: arm + takeoff + INT `DO_REPOSITION` all `accepted`.

## Re-run

```bash
cd sitl && docker compose --profile sitl --profile nodered up -d --build
docker compose --profile nodered restart nodered   # after package changes
node sitl/run-example-suite.js --out sitl/example-suite-results.json
```

Update this file when re-running; keep `sitl/example-suite-results.json` as the machine-readable log.
