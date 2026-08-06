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

### Manual launch (without Docker)

ArduPilot five (telemetry to GCS bind `14550`):

```bash
for i in 0 1 2 3 4; do \
  sim_vehicle.py -v ArduCopter -I $i --sysid $((i+1)) \
    --out=udp:127.0.0.1:14550 & \
done
```

PX4 five: set `MAV_SYS_ID` 11–15 and point GCS MAVLink at `127.0.0.1:14560` (version-specific;
the Docker entrypoint does this for you).

## Safety

SITL only — several flows arm, fly, or force-disarm. Never point them at a real vehicle
without understanding each step.

## Flow index

| File | Tab | Needs |
|------|-----|-------|
| `01-completion-takeoff.json` | SITL 01 Completion takeoff | 1× ArduPilot |
| `02-completion-timeout.json` | SITL 02 Completion timeout | 1× ArduPilot |
| `03-temporarily-rejected.json` | SITL 03 Temporarily rejected | 1× PX4 (packed mode → retry) |
| `04-mode-tables.json` | SITL 04 Mode tables | 1× ArduPilot + 1× PX4 |
| `05-px4-param-union.json` | SITL 05 PX4 param union | 1× PX4 |
| `06-mission-fence-rally.json` | SITL 06 Mission/fence/rally | 1× ArduPilot + 1× PX4 |
| `07-mission-failloud.json` | SITL 07 Mission fail-loud | 1× ArduPilot |
| `08-fanout-sequential-five.json` | SITL 08 Fan-out ×5 pacing | 5× ArduPilot |
| `09-fanout-member-expires.json` | SITL 09 Fan-out member expires | 5× ArduPilot |
| `10-dual-stack-ten.json` | SITL 10 Dual-stack ×10 | 5× ArduPilot + 5× PX4 |
| `11-broadcast-vs-sequential.json` | SITL 11 Broadcast vs sequential | 5× ArduPilot |
| `12-signing.json` | SITL 12 Signing | companion AP sysid 20 (`hunter11` via harness) |
| `13-param-defs-live.json` | SITL 13 Param defs (live) | 1× ArduPilot |
| `14-command-mission-basics.json` | SITL 14 Command & mission basics | 2× ArduPilot |
| `15-companion-ap.json` | SITL 15 Companion AP | companion AP sysid 20 |
| `16-companion-px4.json` | SITL 16 Companion PX4 | companion PX4 sysid 21 |
| `17-int-carrier-goto.json` | SITL 17 INT carrier goto | 1× PX4 |
| `18-int-local-vs-global.json` | SITL 18 INT local vs global | 1× ArduPilot + 1× PX4 |
| `19-ap-int-carrier-goto.json` | SITL 19 AP INT carrier goto | 1× ArduPilot |
| `20-move-stream-stop.json` | SITL 20 Move stream + stop | 1× ArduPilot |
| `21-param-echo-float32.json` | SITL 21 Param float32 echo | 1× ArduPilot + 1× PX4 |
| `22-in-build-out.json` | SITL 22 In → Build → Out | 1× ArduPilot |
| `23-profile-target-inherit.json` | SITL 23 Profile target inherit | 1× ArduPilot (sysid 2) |
| `24-companion-receive.json` | SITL 24 Companion receive | companion AP sysid 20 |
| `25-tcp-connection.json` | SITL 25 TCP connection (template) | TCP SITL on `:5760` (not in default Compose) |
| `26-formation-basics.json` | SITL 26 Formation basics | 5× ArduPilot (line then circle) |
| `27-lucy-in-the-sky.json` | SITL 27 Lucy in the Sky | 5× ArduPilot (sphere tumble + peel land) |
| `28-param-read-by-index.json` | SITL 28 Param read by index | 1× ArduPilot (list → index read) |
| `29-param-fanout-set.json` | SITL 29 Param fan-out set | 5× ArduPilot (PARAM_SET confirm) |
| `30-px4-param-list.json` | SITL 30 PX4 param list | 1× PX4 (request-list collect) |
| `31-param-encoding-override.json` | SITL 31 Param encoding override | 1× ArduPilot + 1× PX4 |
| `32-param-echo-timeout.json` | SITL 32 Param echo timeout | 1× ArduPilot (unknown id) |
| `33-payload-gimbal-legacy.json` | SITL 33 Payload gimbal legacy | AP payload sysid 31 (`14570`) |
| `34-payload-camera.json` | SITL 34 Payload camera | AP payload sysid 31 (photo ok / video DENIED) |
| `35-payload-gimbal-manager.json` | SITL 35 Payload gimbal manager | AP payload sysid 31 (send unconfirmed) |

## Running the suite

Use the Docker lab + harness (`sitl/AGENTS.md`). Default lab skips **25** (UDP-only).

**Results:** GitHub Issues labeled `sitl-results` — not PRs that rewrite `testing.md`.
Close the prior open results issue when posting a new run.
