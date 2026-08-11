# SITL lab — agent playbook

How to bring up the Docker lab and run `examples/sitl/` efficiently.
Human-oriented detail lives in [`README.md`](README.md); design intent in
[`DESIGN.md` §13–§14](../DESIGN.md).

**Live results:** each suite run closes the previous open GitHub Issue labeled
`sitl-results`, publishes the new curated table in a new `sitl-results` issue,
and does not open a results-only PR. See [`../testing.md`](../testing.md).

## Do this, not that

| Do | Don’t |
|----|--------|
| Use the official prebuilt AP binary (Dockerfile already does) | `waf copter` / clone ArduPilot in the image (~40 min in nested Docker) |
| `docker compose --profile sitl --profile nodered up -d --build` | Hunt for a standalone Node-RED if Compose can host it |
| Recreate `nodered` after pulling package changes on `main` (`docker compose --profile nodered up -d --force-recreate nodered`) | Leave a long-lived `nrc-nodered` up across `git pull` — `/data` keeps the install from container start (`install-and-start.sh`), so runtime can still be on the old `sysids` CSV while flows already use `members` |
| Wait for HEARTBEATs, then `node sitl/run-example-suite.js` | Deploy all example flows at once (UDP bind exclusivity) |
| Post curated verdicts to a **GitHub Issue** (`sitl-results`) | Open a docs PR that only updates `testing.md` / results JSON |
| Close the previous `sitl-results` issue after posting | Leave a trail of open result issues |
| Load `copter.parm` + `ap-logging.parm` (entrypoint default) | Run bare `arducopter` without autotest defaults → ARM DENIED |
| Write harness JSON under `/tmp/` (default) | Commit `sitl/example-suite-results.json` |

## Cold start (cloud / nested Docker VM)

```bash
# If docker missing: install Engine + compose plugin, then:
sudo mkdir -p /etc/docker
echo '{"storage-driver":"vfs"}' | sudo tee /etc/docker/daemon.json
# no systemd → sudo dockerd & ; chmod 666 /var/run/docker.sock

cd sitl
docker compose --profile sitl --profile nodered up -d --build
```

- AP image (`nrc-mavlink-ap-sitl:local`): curls
  `firmware.ardupilot.org/Copter/stable-4.7.0/SITL_x86_64_linux_gnu/arducopter`
  (~7 MB) + `Tools/autotest/default_params/copter.parm`. **Pinned
  `linux/amd64`** (binary is x86_64-only).
- PX4: official `px4io/px4-sitl` digest in `docker-compose.yml` (no local compile).
- Node-RED: host network, editor `http://127.0.0.1:1880`, package bind-mounted
  from repo root via `nodered/install-and-start.sh`.

Ready when:

```bash
docker compose --profile sitl --profile nodered ps
docker logs nrc-ap-1 2>&1 | grep -E 'udpclient|Loaded defaults'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1880   # 200
```

Expect AP log: `out=udpclient:172.…:14550` and
`Loaded defaults from /params/copter.parm,/params/ap-logging.parm`.

## Optional PX4 arming helpers

On a fresh SIH image, set once per container (at least `nrc-px4-11`):

```bash
docker exec nrc-px4-11 sh -lc \
  'cd /opt/px4 && ./bin/px4-param set MAV_0_BROADCAST 1 \
   && ./bin/px4-param set COM_RCL_EXCEPT 7 \
   && ./bin/px4-param set COM_ARM_MAG_STR 0'
```

Multi-instance containers use `/tmp/px4-sock-<i>`; `px4-param` may say
“server not running” if the wrong socket is selected — prefer instance 0
(`nrc-px4-11`) for single-vehicle examples.

## Run the example suite

From **repo root** (not `sitl/`):

```bash
node sitl/run-example-suite.js --out /tmp/sitl-example-suite-results.json
# subset:
node sitl/run-example-suite.js --only 01,10,17
```

Harness: **docker-restarts the vehicle fleet** (AP 1–5, PX4 11–15, companions
20/21 — not `nrc-nodered`) before each non-SKIP example, waits for GPS/EKF
settle (`SITL_FLEET_SETTLE_MS`, default 8s), re-applies PX4 lab helpers, then
deploys one `examples/sitl/*.json` → enable debug→console → fire injects →
**poll** `docker logs nrc-nodered` until a *specialized* `verdictFrom` `PASS`
(or `PROFILE.readyWhen`) capped by `waitMs` (a max wait, not a fixed sleep;
generic `results: …` PASS does not early-exit — first ack is not “done”;
`SITL_READY_POLL_MS`, default 500) → write JSON under `/tmp/` (default). Example
**12** (signing) targets companion AP sysid 20: harness sends `SETUP_SIGNING` with
`sha256(hunter11)` and injects `{ signingPassphrase: "hunter11" }` on Admin API
deploy (`hunter11` is a joke lab passphrase, not a secret). Example **19** (TCP)
is **SKIP** unless Compose exposes SITL TCP.


Before each example the harness selectively `docker restart`s containers named by
`PROFILE.restart` (`none` / `ap-1` / `ap-12` / `ap-2` / `ap-fleet` / `px4-1` /
`fleet`). Examples are numbered in that run order so `restart: none` batches
skip settle. Override with `SITL_RESTART=fleet`. See `examples/sitl/README.md`.

Force-disarm alone does **not** reset AGL; without the fleet restart, a prior
takeoff leaves sysid 1 airborne and the next `NAV_TAKEOFF` returns
`MAV_RESULT_DENIED` (resultCode 4).

### Targeted Move measurements (#175 / #179)

```bash
# AP :14550 + PX4 :14560; writes under /tmp/nrc-move-179-*/ (mode 0600).
# Restarts are your job — free those UDP binds first (stop any suite run).
node sitl/measure-move-179.js
```

Probes stream-replace halt visibility, AP yaw-only, GUID_TIMEOUT one-shot brake,
PX4 OFFBOARD rate/silence (`COM_OF_LOSS_T`), and yaw+yaw_rate on both stacks.
Findings land in `DESIGN.md` §14 — do not commit the JSON.

### Peer-table enrichment while airborne (§8)

```bash
# Same ports; writes /tmp/nrc-peer-table-*/peer-table-results.json
node sitl/measure-peer-table.js
```

Asserts every DESIGN.md §8 field (identity, armed/mode, endpoints, position,
GPS, battery, home, section freshness, snapshot projection; AUTOPILOT_VERSION /
STATUSTEXT best-effort) on AP GUIDED + PX4 OFFBOARD after takeoff and a short
velocity tour. Suite example **26** is the thinner flow-level State snapshot
regression (`run-example-suite.js --only 36`).

### Post results (no PR)

```bash
# 1) Curate PASS/PARTIAL/FAIL/SKIP from the JSON (do not trust auto-status blindly).
# 2) Open a new issue:
gh issue create --label sitl-results \
  --title "SITL suite results — run N" \
  --body-file /tmp/sitl-run-N.md
# 3) Close the previous open sitl-results issue:
gh issue list --label sitl-results --state open
gh issue close <prior> --comment "Superseded by #<new>"
```

Attach or paste a short summary table in the issue body. Keep the full JSON
local or paste a collapsed `<details>` block — do not land it in git.

### Harness auto-verdict traps

- Example **02** historically false-PASS’d on the word “timeout” in node names;
  verdict now requires a real `timed-out` / timeout detail.
- Example **09**: kill must land mid-run; late kill → all-accepted aggregate.
- Examples **15/16**: many `sent` lines → look for `NAMED_VALUE_FLOAT` specifically.
- Example **07**: bad upload must fail validation; empty success is not fail-loud.
- Example **03**: PX4 packed `DO_SET_MODE` (196608) — expect `temporarily_rejected`
  with `retries >= 1` (AP arm never returns result `(1)` on this firmware).
- Example **12**: needs `SETUP_SIGNING` + Admin credentials before deploy; verdict
  wants arm `accepted` and debug `trusted flag` → `true` (not merely “sign” in the log).
- Example **18**: needs `ap-home-ready` (HOME_POSITION) or AP GLOBAL_INT home FAILs.
- Example **21**: AP param is `LOIT_SPEED_MS` (no `WPNAV_SPEED` on Copter 4.7.0).
- Example **23**: inherit PASS is resolved `target.sysid === 2` (prep `ap-arm-ready-2`).
- Examples **34/35**: formation + takeoff need `ap-arm-ready-fleet`; **27** wait is long
  (sphere pitch steps + peel land). Verdict keys on named debug tags (`line status`,
  `s0 status`…`land status`), not a generic succeeded count.
- Example **28**: list collect then index-read — verdict needs `list status` + `index assert`
  both `succeeded` (wire shape: `param_index ≥ 0`, empty `param_id`).
- Example **29**: PARAM_SET fan-out — `fanout status` succeeded with `count: 5` (subset
  fleets also report succeeded; count is required).
- Example **30**: PX4 list — `list status` + `list assert` (known ids present).
- Example **31**: matching `ap set` / `px4 set` succeeded **and** `ap wrong status`
  `timed-out` (crossed bytewise on AP); matching-only would not prove the override rung.
- Example **32**: `known set status` succeeded (LOIT_SPEED_MS) **then** `unknown set status`
  `timed-out` / `echo timeout` on missing `WPNAV_SPEED` (dead peer alone must not PASS).
- Examples **33–35**: Payload on **sysid 31 / 14570** (`nrc-ap-payload-31`). **33** needs
  `aim`/`mode`/`roi set`/`roi clear` all succeeded; **34** photo succeeded **and** video
  start/stop denied|failed; **35** `manager status` succeeded with `unconfirmed` detail.

## Port / sysid map (quick)

| Fleet | Sysids | Bind (Node-RED) | Vehicle → host |
|-------|--------|-----------------|----------------|
| AP GCS | 1–5 | `0.0.0.0:14550` | udpclient → `14550` |
| PX4 GCS | 11–15 | `0.0.0.0:14560` | mavlink `-o 14560` |
| AP companion | 20 | `0.0.0.0:14540` | udpclient → `14540` |
| PX4 companion | 21 | `0.0.0.0:14542` | mavlink → `14542` |
| AP payload | 31 | `0.0.0.0:14570` | udpclient → `14570` (`--gimbal`) |

Directed commands use the Connection peer table (reply to HEARTBEAT source).
`remotePort` 14551/14561 is pre-peer fallback only.

This is a **star, not a bus**: every AP vehicle dials in and owns its own return
path. `target_system = 0` therefore has to be written once per learned peer —
Connection does that — and a single send to `remotePort` reaches nobody.

## Takeoff / GUIDED / fan-out arm

AP `NAV_TAKEOFF` needs GUIDED **and** a vehicle on the ground. Examples **20/21**
set GUIDED **before** arm (cold SITL often DENYs armed STABILIZE→GUIDED).
Harness prep `ap-guided-1` polls until HEARTBEAT shows GUIDED **and** a
probe arm succeeds (EKF position — often ~30–40 s after docker restart), then
force-disarms for the example’s own arm step.

Examples **31/32/33** arm sysids 1–5 with `delivery=confirm`, where the first
`DENIED` fails the aggregate, so they use prep `ap-arm-ready-fleet`: probe-arm
each in turn until it succeeds, then force-disarm. Do **not** reach for a bigger
`SITL_FLEET_SETTLE_MS` instead — peers come back within seconds while arm stays
`DENIED` (“Gyros inconsistent”) for another 20–40 s, and that interval is not a
constant. Example **10** deliberately has no prep: it is `delivery=send`, so
nothing waits on an ACK and no verdict depends on anyone arming.

If takeoff or arm is still DENIED (`resultCode: 4`), check that the fleet
restart ran and the matching arm-ready prep confirmed — do not reintroduce a
source build, and do not rely on force-disarm to clear altitude.

## Param echo types

Copter-4.7 removed `ARMING_CHECK` (`PARAM_ERROR`); example 13 uses
`ARMING_OPTIONS` as `MAV_PARAM_TYPE_INT32`. A REAL32-typed set of an int param
writes float bit patterns; echo-confirm then times out.

## Fixture tests (no Docker)

```bash
node --test test/sitl/*.test.js
```

Pins prebuilt URL, amd64 platform, `udpclient`, and `--defaults
copter.parm,ap-logging.parm`. Ordinary package CI does **not** run the
12-vehicle lab.

## Tear down

```bash
cd sitl && docker compose --profile sitl --profile nodered down
```
