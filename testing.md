# SITL example live testing

Live run of every flow under `examples/sitl/` against the Docker lab
(`sitl/docker-compose.yml` `--profile sitl` + `--profile nodered`).

| | |
|---|---|
| **When** | 2026-07-31 ~03:28–03:40 UTC |
| **Host** | Cloud agent VM, Node-RED `http://127.0.0.1:1880` (compose `nodered` profile, host network) |
| **Repo** | `main` @ `1738196` (+ this note / runner) |
| **Fleet** | AP sysids 1–5 (`14550`), PX4 11–15 (`14560`), companions 20 / 21 |
| **Harness** | `node sitl/run-example-suite.js` → `sitl/example-suite-results.json` |
| **Method** | Deploy one flow at a time (UDP bind exclusivity), enable debug→console, fire injects, scrape Node-RED logs |

**Verdict key:** **PASS** = story observed · **PARTIAL** = useful progress but story incomplete · **FAIL** = blocked or wrong outcome · **SKIP** = needs setup the API deploy cannot provide

## Summary

| # | File | Verdict | Notes |
|---|------|---------|-------|
| 01 | `01-completion-takeoff.json` | **PASS** | Arm ack → takeoff `complete` at **alt 9.5 m** (`confirmedBy: state`, ~9 s) |
| 02 | `02-completion-timeout.json` | **FAIL** | Expected accept-then-completion-timeout; got immediate **DENIED** (`resultCode: 4`) — not the timeout branch |
| 03 | `03-temporarily-rejected.json` | **PARTIAL** | Arm accepted (no `TEMPORARILY_REJECTED` — GPS already locked). Takeoff DENIED (need GUIDED / not a fresh-boot race) |
| 04 | `04-mode-tables.json` | **PARTIAL** | ArduPilot GUIDED path ok; PX4 POSCTL **temporarily_rejected** |
| 05 | `05-px4-param-union.json` | **PASS** | Set→read echo **succeeded** on PX4 sysid 11 |
| 06 | `06-mission-fence-rally.json` | **PASS** | AP mission/fence/rally succeeded; PX4 fence **fail-loud** (`px4 does not support fence over the mission protocol`) |
| 07 | `07-mission-failloud.json` | **PARTIAL** | Good upload/download succeeded, but “bad” upload also reported **succeeded** with `count: 0` — fail-loud story not proven |
| 08 | `08-swarm-sequential-five.json` | **PASS** | Dry-run then live sequential arm ×5 **succeeded** |
| 09 | `09-swarm-member-expires.json` | **PARTIAL** | Sequential arm ×5 all **accepted** (incl. sysid 3). Killing `nrc-ap-3` mid-run was too late / still acked — no failed member in aggregate |
| 10 | `10-dual-stack-ten.json` | **FIXED, RE-RUN PENDING** | Was FAIL: both broadcast arms **refused** — `selectionMode: list` + `executionMode: broadcast` is illegal. Example bug, not a library bug; broadcast nodes now use selection `all`. Not yet re-run on the lab |
| 11 | `11-broadcast-vs-sequential.json` | **PARTIAL → FIXED, RE-RUN PENDING** | Sequential arm ×5 **succeeded**; broadcast arm **refused** (same list+broadcast rule). Broadcast node now uses selection `all`; sequential keeps its list. Not yet re-run on the lab |
| 12 | `12-signing.json` | **SKIP** | `sign-outbound` enabled but Admin API deploy has **no signing passphrase** credential → connection errors. Editor credential setup required |
| 13 | `13-param-defs-live.json` | **PARTIAL** | Read + full list **succeeded**; set `ARMING_CHECK` **echo timeout** |
| 14 | `14-command-mission-basics.json` | **PASS** | Arm sysid 1 accepted; mission upload/download sysid 2 succeeded; message-interval sent |
| 15 | `15-companion-ap.json` | **PASS** | `NAMED_VALUE_FLOAT` **sent** on companion bind `14540` (sysid 20) |
| 16 | `16-companion-px4.json` | **PASS** | `NAMED_VALUE_FLOAT` **sent** on companion bind `14542` (sysid 21) |
| 17 | `17-int-carrier-goto.json` | **PASS** | Arm + takeoff + **COMMAND_INT** `DO_REPOSITION` accepted. Prior run with z=`"NaN"` reached configured lat/lon (~135 m north of that flight's home); this suite pass confirms ACKs again |

**Totals (human-curated, as run):** PASS 8 · PARTIAL 6 · FAIL 2 · SKIP 1

Since the run, the 10/11 broadcast-selection defect has been fixed in the example flows (see below). Those two rows are **not** re-verified — re-run the suite to confirm.

## Environment notes

- PX4 lab fix on `main` (`a8c5256`): `MAV_SYS_ID` must be set **before** `commander start`, otherwise COMMAND_* to sysid 11–15 are ignored.
- For PX4 arm without RC / mag fuss on this SIH image: `COM_RCL_EXCEPT=7`, `COM_ARM_MAG_STR=0`, `MAV_0_BROADCAST=1` (set live on the containers for this run).
- Example 17 goto altitude must be NaN (or real AMSL); relative “20” is read as AMSL by PX4 and drives into the ground (fixed in `23af993`).
- Flows that arm should be followed by disarm/land before the next example; the harness best-efforts PX4 `disarm -f`.

## Per-example detail

### 01 — Completion takeoff — PASS

- Inject: `Start chain`
- Arm `accepted` (ack, 7 ms)
- Takeoff `accepted`, `confirmedBy: 'state'`, detail `alt 9.5 m`, elapsed ~9006 ms

### 02 — Completion timeout — FAIL (vs story)

- Inject: `Takeoff (no prep)`
- Takeoff `failed` / `resultCode: 4` in 3 ms (DENIED), not an in-progress→timeout completion wait
- Story wants: command accepted but climb never finishes → completion timeout

### 03 — Temporarily rejected — PARTIAL

- `once` inject at deploy (fleet already GPS-locked)
- Arm `accepted` with `retries: 0` (no TEMPORARILY_REJECTED)
- Takeoff `failed` resultCode 4

### 04 — Mode tables — PARTIAL

- AP GUIDED inject exercised; PX4 POSCTL returned **temporarily_rejected**
- Dual connections `14550` + `14560` deployed cleanly

### 05 — PX4 param union — PASS

- Set then read path **succeeded** (int/float union echo)

### 06 — Mission / fence / rally — PASS

- AP uploads succeeded
- PX4 fence upload error (expected): `px4 does not support fence over the mission protocol`

### 07 — Mission fail-loud — PARTIAL

- Good upload + download succeeded (empty mission `count: 0` in this run’s payloads)
- Bad upload unexpectedly **succeeded** (`debug:bad upload (unexpected ok)`) — validator/fail-loud not demonstrated

### 08 — Swarm sequential ×5 — PASS

- Dry-run `dry_run`, live `succeeded` for five members

### 09 — Swarm member expires — PARTIAL

- Aggregate `succeeded`, members 1–5 all `accepted`
- `docker stop nrc-ap-3` ~2.5 s after inject did not produce a failed/expired member in the aggregate (arms completed too fast / kill timing)
- Expired-state debug lines did fire from the State node while ap-3 was down

### 10 — Dual-stack ×10 — FAIL (as run) → fixed, re-run pending

- AP + PX4 broadcast arms both **refused** with: broadcast cannot honour a `list` selection
- State feed still useful for seeing ten peers; arm story blocked by example config (`selectionMode: "list"` + `executionMode: "broadcast"`)
- **Diagnosis:** example bug, not a library bug. `lib/swarm/index.js` refuses the combination on
  purpose and says why — broadcast is one `target_system=0` frame that every vehicle on the link
  acts on, so it cannot address a subset. The flow's own comment already said "target_system=0 is
  single-stack only"; the `list` selection contradicted it.
- **Fix applied:** both broadcast nodes now use `selectionMode: "all"` (sysid list cleared — with
  mode `all` it is ignored outright, so leaving it populated implied an addressing that never
  happened). Each connection carries exactly one stack, so `all` resolves to that stack's five.
- **Not re-run** — needs the compose lab.

### 11 — Broadcast vs sequential — PARTIAL (as run) → fixed, re-run pending

- Sequential confirm **succeeded** (5/5)
- Broadcast confirm **refused** (same list+broadcast rule as 10)
- **Fix applied:** the broadcast node uses `selectionMode: "all"`; the sequential node keeps its
  sysid list, which is the honest contrast — fan-out addresses each vehicle so a subset is
  meaningful, broadcast cannot. Both resolve to the same five vehicles, so the aggregates stay
  comparable.
- **Not re-run** — needs the compose lab.

### 12 — Signing — SKIP

- Connection error: `sign-outbound is enabled but no signing passphrase is set`
- Credentials are not in the JSON; must be set in the editor (`flows_cred`)
- Follow-on null `subscribe` errors are secondary to the failed connection construct

### 13 — Param defs live — PARTIAL

- Read ARMING_CHECK succeeded; full list collect succeeded
- Set ARMING_CHECK echo-confirm **timed out**

### 14 — Command & mission basics — PASS

- Arm sysid 1 accepted; GLOBAL_POSITION_INT rate request sent; mission up/down on sysid 2 succeeded

### 15 / 16 — Companions — PASS

- NVF send tier `sent` on the companion UDP ports

### 17 — INT carrier goto — PASS

- Arm + takeoff + INT goto (`MAV_CMD_DO_REPOSITION`) **accepted**
- Position proof (separate run same day after z=`NaN` fix): vehicle at **47.399100, 8.545603** (~0.2 m from target; ~135 m north of that flight’s home)

## Re-run

```bash
cd sitl && docker compose --profile sitl --profile nodered up -d
# wait until peers heartbeat on 14550 / 14560
node sitl/run-example-suite.js --out sitl/example-suite-results.json
# optional subset:
node sitl/run-example-suite.js --only 05,17
```

Update this file when re-running; keep `sitl/example-suite-results.json` as the machine-readable companion log.
