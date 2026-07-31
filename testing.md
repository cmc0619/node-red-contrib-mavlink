# SITL example live testing

Live runs of every flow under `examples/sitl/` against the Docker lab
(`sitl/docker-compose.yml` `--profile sitl` + `--profile nodered`).

| | |
|---|---|
| **Latest run** | 2026-07-31 **05:01–05:12 UTC** (run 3) |
| **Prior runs** | 04:34–04:45 UTC (run 2); ~03:28–03:40 UTC (run 1) |
| **Host** | Cloud agent VM, Node-RED `http://127.0.0.1:1880` |
| **Repo** | `main` @ `2eca0a6` + harness on this branch |
| **Fleet** | AP 1–5 (`14550`), PX4 11–15 (`14560`), companions 20 / 21 |
| **Harness** | `node sitl/run-example-suite.js` → `sitl/example-suite-results.json` |
| **Prep (run 3)** | Disarm/GUIDED on AP 1–5 via Connection; PX4 `COM_RCL_EXCEPT=7`, `COM_ARM_MAG_STR=0`, `MAV_0_BROADCAST=1` |

**Verdict key:** **PASS** = story observed · **PARTIAL** = useful progress but story incomplete · **FAIL** = blocked or wrong outcome · **SKIP** = needs setup the API deploy cannot provide

## Summary (run 3)

| # | File | Verdict | Notes |
|---|------|---------|-------|
| 01 | `01-completion-takeoff.json` | **PASS** | Arm ack → takeoff complete **alt 9.5 m** (`confirmedBy: state`, ~9.0 s) |
| 02 | `02-completion-timeout.json` | **FAIL** | Immediate DENIED (`resultCode: 4`, 4 ms) — not accept→completion-timeout |
| 03 | `03-temporarily-rejected.json` | **PARTIAL** | Arm accepted (no TEMPORARILY_REJECTED — not fresh boot). Takeoff DENIED |
| 04 | `04-mode-tables.json` | **PARTIAL** | AP GUIDED ok; PX4 POSCTL **temporarily_rejected** |
| 05 | `05-px4-param-union.json` | **PASS** | Set→read echo succeeded |
| 06 | `06-mission-fence-rally.json` | **PASS** | AP mission/fence/rally ok; PX4 fence fail-loud |
| 07 | `07-mission-failloud.json` | **PARTIAL** | Good up/down ok; bad upload still **succeeded** (`unexpected ok`) |
| 08 | `08-swarm-sequential-five.json` | **PASS** | Dry-run + live sequential arm ×5 succeeded |
| 09 | `09-swarm-member-expires.json` | **PASS** | Kill ap-3 mid-run: **1,2,4,5 accepted**, **3 timeout**; aggregate failed |
| 10 | `10-dual-stack-ten.json` | **PASS** | AP + PX4 broadcast **succeeded** (selectionMode all) |
| 11 | `11-broadcast-vs-sequential.json` | **PARTIAL** | Sequential succeeded; broadcast+confirm timed out on ACKs |
| 12 | `12-signing.json` | **SKIP** | No signing passphrase via Admin API deploy |
| 13 | `13-param-defs-live.json` | **PARTIAL** | Read + list ok; set echo-confirm timed out |
| 14 | `14-command-mission-basics.json` | **PASS** | Arm, message-interval, mission up/down ok |
| 15 | `15-companion-ap.json` | **PASS** | NVF `sent` on `14540` |
| 16 | `16-companion-px4.json` | **PASS** | NVF `sent` on `14542` |
| 17 | `17-int-carrier-goto.json` | **PASS** | Arm + takeoff + COMMAND_INT goto all accepted |

**Totals (run 3, curated):** PASS **10** · PARTIAL **5** · FAIL **1** · SKIP **1**

### Trend

| Run | PASS | PARTIAL | FAIL | SKIP |
|-----|------|---------|------|------|
| 1 (~03:28) | 8 | 6 | 2 | 1 |
| 2 (04:34) | 9 | 6 | 1 | 1 |
| **3 (05:01)** | **10** | **5** | **1** | **1** |

Run 3 regained **01** (GUIDED prep). Stable PASS: 05, 06, 08–10, 14–17. Persistent gaps: **02** (wrong failure mode), **07** (bad upload not rejected), **12** (credentials), **04** PX4 mode reject, **11** broadcast+confirm, **13** param echo.

## Environment notes

- PX4 lab: `MAV_SYS_ID` before `commander start`.
- Broadcast swarm nodes need `selectionMode: "all"` (not `list`) — fixed in examples on main.
- Example 17 goto z = NaN (or real AMSL).
- Deploy one flow at a time (UDP bind exclusivity).

## Per-example detail (run 3)

### 01 — PASS
Arm `accepted`; takeoff `accepted`, `confirmedBy: state`, detail `alt 9.5 m`, elapsed 9007 ms.

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
`debug:bad upload (unexpected ok)` still **succeeded**.

### 08 — PASS
Dry-run + live sequential arm ×5.

### 09 — PASS
Aggregate `failed`, count 5: sysids 1,2,4,5 `accepted`; **3 `timeout`** (`no COMMAND_ACK`). Detail: `one or more swarm members failed`.

### 10 — PASS
AP broadcast `succeeded` (5× `sent`); PX4 broadcast `succeeded`.

### 11 — PARTIAL
Sequential confirm succeeded; broadcast confirm failed (ACK timeout). Example 10’s `send` tier broadcast works.

### 12 — SKIP
`sign-outbound` without passphrase credential on API deploy.

### 13 — PARTIAL
Read/list succeeded; set `ARMING_CHECK` echo timeout.

### 14 — PASS
Arm sysid 1; rate request; mission up/down sysid 2.

### 15 / 16 — PASS
Companion NVF `sent`.

### 17 — PASS
Arm + takeoff + INT `DO_REPOSITION` all `accepted` (ack).

## Re-run

```bash
cd sitl && docker compose --profile sitl --profile nodered up -d
# optional: set AP 1–5 to GUIDED and PX4 COM_RCL_EXCEPT / COM_ARM_MAG_STR / MAV_0_BROADCAST
node sitl/run-example-suite.js --out sitl/example-suite-results.json
```

Update this file when re-running; keep `sitl/example-suite-results.json` as the machine-readable log.
