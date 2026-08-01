# SITL example live testing

Live runs of every flow under `examples/sitl/` against the Docker lab
(`sitl/docker-compose.yml` `--profile sitl` + `--profile nodered`).

| | |
|---|---|
| **Latest run** | 2026-08-01 **03:50–04:00 UTC** (run 4) |
| **Prior runs** | 2026-07-31 05:01–05:12 (run 3); 04:34–04:45 (run 2); ~03:28–03:40 (run 1) |
| **Host** | Cloud agent VM, Node-RED `http://127.0.0.1:1880` |
| **Repo** | `cursor/sitl-examples-rerun-9d7b` @ `41cee85` (prebuilt AP SITL + `copter.parm`) |
| **Fleet** | AP 1–5 (`14550`), PX4 11–15 (`14560`), companions 20 / 21 |
| **Harness** | `node sitl/run-example-suite.js` → `sitl/example-suite-results.json` |
| **Prep (run 4)** | AP image = official `firmware.ardupilot.org` Copter-4.7.0 static binary + autotest `copter.parm`; PX4-11 `COM_RCL_EXCEPT=7`, `COM_ARM_MAG_STR=0`, `MAV_0_BROADCAST=1` |

**Verdict key:** **PASS** = story observed · **PARTIAL** = useful progress but story incomplete · **FAIL** = blocked or wrong outcome · **SKIP** = needs setup the API deploy cannot provide

Harness auto-verdicts in the JSON are a first pass only — several false positives are called out below (node names matching `/timeout/`, log lines matching `/failed/`). **Totals are human-curated.**

## Summary (run 4)

| # | File | Verdict | Notes |
|---|------|---------|-------|
| 01 | `01-completion-takeoff.json` | **PARTIAL** | Arm `accepted`; takeoff **DENIED** (`resultCode: 4`) — completion/alt story not reached (GUIDED prep not sticky enough on prebuilt) |
| 02 | `02-completion-timeout.json` | **FAIL** | Immediate DENIED (`resultCode: 4`, ~5 ms) — not accept→completion-timeout. Harness auto-PASS is wrong (node name contains “timeout”) |
| 03 | `03-temporarily-rejected.json` | **PARTIAL** | Arm `accepted` (no TEMPORARILY_REJECTED — not fresh boot). Takeoff DENIED |
| 04 | `04-mode-tables.json` | **PARTIAL** | AP path exercised; PX4 POSCTL **temporarily_rejected** |
| 05 | `05-px4-param-union.json` | **PASS** | Set→read echo **succeeded** |
| 06 | `06-mission-fence-rally.json` | **PASS** | AP mission/fence/rally ok; PX4 fence fail-loud |
| 07 | `07-mission-failloud.json` | **PARTIAL** | Good up/down **succeeded**; bad upload also **succeeded** (`count: 0`) — fail-loud not proven. Harness auto-PASS |
| 08 | `08-swarm-sequential-five.json` | **PASS** | Dry-run + live sequential arm ×5 **succeeded** |
| 09 | `09-swarm-member-expires.json` | **PARTIAL** | Kill `nrc-ap-3` mid-run still too late — aggregate **succeeded** (all accepted). Harness auto-PASS from `/failed\|expired/` elsewhere in the log |
| 10 | `10-dual-stack-ten.json` | **PASS** | AP + PX4 broadcast **succeeded** (`selectionMode: all` fix confirmed) |
| 11 | `11-broadcast-vs-sequential.json` | **PARTIAL** | Sequential confirm **succeeded**; broadcast+confirm **unconfirmed**/failed (ACK timeout). Example 10’s send-tier broadcast works |
| 12 | `12-signing.json` | **SKIP** | `sign-outbound` enabled but Admin API deploy has no signing passphrase |
| 13 | `13-param-defs-live.json` | **PARTIAL** | Read + list ok; set `ARMING_CHECK` echo-confirm **timed out** |
| 14 | `14-command-mission-basics.json` | **PASS** | Arm sysid 1 accepted; message-interval sent; mission up/down sysid 2 succeeded |
| 15 | `15-companion-ap.json` | **PASS** | `NAMED_VALUE_FLOAT` **sent** on `14540` |
| 16 | `16-companion-px4.json` | **PASS** | `NAMED_VALUE_FLOAT` **sent** on `14542` |
| 17 | `17-int-carrier-goto.json` | **PASS** | PX4 arm + takeoff + COMMAND_INT `DO_REPOSITION` all **accepted** |

**Totals (run 4, curated):** PASS **8** · PARTIAL **7** · FAIL **1** · SKIP **1**

### Trend

| Run | PASS | PARTIAL | FAIL | SKIP | Notes |
|-----|------|---------|------|------|-------|
| 1 (~03:28) | 8 | 6 | 2 | 1 | 10/11 blocked by list+broadcast |
| 2 (04:34) | 9 | 6 | 1 | 1 | |
| 3 (05:01) | **10** | 5 | 1 | 1 | 01 takeoff complete; 10 broadcast ok |
| **4 (03:50)** | **8** | **7** | **1** | **1** | Prebuilt AP + `copter.parm`; arm restored; takeoff/01 & kill-timing/09 slipped |

Run 4 is the first full suite on the **official prebuilt** ArduPilot binary (no waf compile). Without `copter.parm`, ARM was universally DENIED; with it, arm/swarm/mission paths work again. Remaining gaps match prior runs: **02**, **07**, **12**, **04** PX4 mode, **11** broadcast+confirm, **13** param echo — plus **01** takeoff needing reliable GUIDED before NAV_TAKEOFF.

## Environment notes

- **ArduPilot image:** curl
  `firmware.ardupilot.org/Copter/stable-4.7.0/SITL_x86_64_linux_gnu/arducopter` (~7 MB)
  plus `Tools/autotest/default_params/copter.parm`. Entrypoint:
  `--serial0 udpclient:<gateway>:14550` and
  `--defaults /params/copter.parm,/params/ap-logging.parm`.
- PX4: `MAV_SYS_ID` before `commander start`; live `COM_RCL_EXCEPT=7`,
  `COM_ARM_MAG_STR=0`, `MAV_0_BROADCAST=1` on at least px4-11.
- Broadcast swarm nodes need `selectionMode: "all"` (not `list`) — verified again on **10**.
- Example 17 goto z = NaN (or real AMSL).
- Deploy one flow at a time (UDP bind exclusivity).

## Per-example detail (run 4)

### 01 — PARTIAL
Arm `accepted` (`resultCode: 0`, ack, 11 ms). Takeoff `failed` / `resultCode: 4` (DENIED, 6 ms). Completion altitude not observed.

### 02 — FAIL (vs story)
Takeoff `failed` / `resultCode: 4` in ~5 ms. Story wants completion-timeout after accept.

### 03 — PARTIAL
Arm `accepted` retries 0; takeoff DENIED. Needs fresh-boot race for TEMPORARILY_REJECTED.

### 04 — PARTIAL
PX4 POSCTL → `temporarily_rejected`.

### 05 — PASS
Param set→read **succeeded**.

### 06 — PASS
AP uploads ok; PX4 fence: `px4 does not support fence over the mission protocol`.

### 07 — PARTIAL
Good upload/download succeeded with empty plan (`count: 0`); bad upload also **succeeded** — fail-loud story not demonstrated.

### 08 — PASS
Dry-run + live sequential arm ×5 **succeeded**.

### 09 — PARTIAL
`docker stop nrc-ap-3` ~2.5 s after inject; aggregate still **succeeded** (arms completed before expiry). Expired-member story not proven this pass.

### 10 — PASS
AP + PX4 broadcast arm aggregates **succeeded** with `selectionMode: "all"`.

### 11 — PARTIAL
Sequential confirm **succeeded**; broadcast confirm failed (`unconfirmed` / ACK timeout). Send-tier broadcast (example 10) remains green.

### 12 — SKIP
`sign-outbound is enabled but no signing passphrase is set` on API deploy.

### 13 — PARTIAL
Read/list succeeded; set `ARMING_CHECK` echo timeout.

### 14 — PASS
Arm sysid 1; `MAV_CMD(511)` rate request sent; mission download sysid 2 `count: 1` succeeded.

### 15 / 16 — PASS
Companion NVF `sent` (harness marks UNKNOWN because many `sent` lines trip its heuristic).

### 17 — PASS
PX4 sysid 11: arm + takeoff + INT `DO_REPOSITION` all `accepted` (ack).

## Re-run

```bash
cd sitl && docker compose --profile sitl --profile nodered up -d --build
# wait for HEARTBEATs; optional PX4 arming params on each px4-* container
node sitl/run-example-suite.js --out sitl/example-suite-results.json
# optional subset:
node sitl/run-example-suite.js --only 01,10,17
```

Update this file when re-running; keep `sitl/example-suite-results.json` as the machine-readable log.
