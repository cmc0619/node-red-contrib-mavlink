# SITL example flows

These flows need live firmware behaviour (completion timing, mode tables, PX4 param
union, mission/fence/rally, fan-out pacing, signing). Prefer the **Docker lab** in
[`sitl/README.md`](../../sitl/README.md) over hand-built trees.

## The rig

| Stack | Sysids | Node-RED bind → remote |
|-------|--------|------------------------|
| ArduPilot GCS | 1–5 | `14550` → `14551` |
| PX4 GCS | 11–15 | `14560` → `14561` |
| AP companion | 20 | `14540` → `14541` |
| PX4 companion | 21 | `14542` → `14543` |
| AP payload (gimbal/camera) | 31 | `14570` → `14571` |
| PX4 payload | 32 | reserved — SIH has no gimbal/camera |

```bash
cd sitl && docker compose --profile sitl up -d --build
```

## Safety

SITL only — several flows arm, fly, or force-disarm. Never point them at a real vehicle
without understanding each step.

## Suite order and selective restart

Examples are **numbered in harness run order**, batched by how much vehicle state they
need reset (`PROFILE.restart` in `sitl/run-example-suite.js`):

| Phase | `restart` | What happens between examples |
|-------|-----------|-------------------------------|
| 01–19 | `none` | no docker restart (after one cold prime) |
| 20–27 | `ap-1` / `ap-12` / `ap-2` | only those AP containers |
| 28–30 | `px4-1` | `nrc-px4-11` only |
| 31–35 | `ap-fleet` | AP 1–5 |
| 36–38 | `fleet` | all 13 vehicles |
| 39 | `none` | no docker restart |
| 40 | `ap-1` | only `nrc-ap-1` |
| 41 | `fleet` | all 13 vehicles |

Force a full fleet every time with `SITL_RESTART=fleet`.

## Flow index

| File | Tab | restart |
|------|-----|---------|
| `01-px4-param-union.json` | SITL 01 PX4 param union | none |
| `02-mission-fence-rally.json` | SITL 02 Mission/fence/rally | none |
| `03-mission-failloud.json` | SITL 03 Mission fail-loud | none |
| `04-param-defs-live.json` | SITL 04 Param defs (live) | none |
| `05-companion-ap.json` | SITL 05 Companion AP | none |
| `06-companion-px4.json` | SITL 06 Companion PX4 | none |
| `07-int-local-vs-global.json` | SITL 07 INT local vs global | none |
| `08-param-echo-float32.json` | SITL 08 Param float32 echo | none |
| `09-in-build-out.json` | SITL 09 In → Build → Out | none |
| `10-companion-receive.json` | SITL 10 Companion receive | none |
| `11-param-read-by-index.json` | SITL 11 Param read by index | none |
| `12-param-fanout-set.json` | SITL 12 Param fan-out set | none |
| `13-px4-param-list.json` | SITL 13 PX4 param list | none |
| `14-param-encoding-override.json` | SITL 14 Param encoding override | none |
| `15-param-echo-timeout.json` | SITL 15 Param echo timeout | none |
| `16-payload-gimbal-legacy.json` | SITL 16 Payload gimbal legacy | none |
| `17-payload-camera.json` | SITL 17 Payload camera | none |
| `18-payload-gimbal-manager.json` | SITL 18 Payload gimbal manager | none |
| `19-tcp-connection.json` | SITL 19 TCP connection (template) | none (SKIP) |
| `20-completion-takeoff.json` | SITL 20 Completion takeoff | ap-1 |
| `21-completion-timeout.json` | SITL 21 Completion timeout | ap-1 |
| `22-command-mission-basics.json` | SITL 22 Command & mission basics | ap-12 |
| `23-ap-int-carrier-goto.json` | SITL 23 AP INT carrier goto | ap-1 |
| `24-move-stream-stop.json` | SITL 24 Move stream + stop | ap-1 |
| `25-profile-target-inherit.json` | SITL 25 Profile target inherit | ap-2 |
| `26-peer-table-inflight.json` | SITL 26 Peer table in flight | ap-1 |
| `27-move-reposition-carrier.json` | SITL 27 Move reposition carrier | ap-1 |
| `28-temporarily-rejected.json` | SITL 28 Temporarily rejected | px4-1 |
| `29-int-carrier-goto.json` | SITL 29 INT carrier goto | px4-1 |
| `30-px4-move-reposition.json` | SITL 30 PX4 Move reposition | px4-1 |
| `31-fanout-sequential-five.json` | SITL 31 Fan-out ×5 pacing | ap-fleet |
| `32-fanout-member-expires.json` | SITL 32 Fan-out member expires | ap-fleet |
| `33-broadcast-vs-sequential.json` | SITL 33 Broadcast vs sequential | ap-fleet |
| `34-formation-basics.json` | SITL 34 Formation basics | ap-fleet |
| `35-lucy-in-the-sky.json` | SITL 35 Lucy in the Sky | ap-fleet |
| `36-mode-tables.json` | SITL 36 Mode tables | fleet |
| `37-dual-stack-ten.json` | SITL 37 Dual-stack ×10 | fleet |
| `38-signing.json` | SITL 38 Signing | fleet |
| `39-companion-health-lease.json` | SITL 39 Health Lease | none |
| `40-transition-events.json` | SITL 40 Transition events | ap-1 |
| `41-mode-names.json` | SITL 41 Mode names | fleet |

## Running the suite

Use the Docker lab + harness (`sitl/AGENTS.md`). Default lab skips **19** (UDP-only).

**Results:** GitHub Issues labeled `sitl-results` — not PRs that rewrite `testing.md`.
Close the prior open results issue when posting a new run.
