# SITL Docker lab

Operator guide for the five+five (+ companion) software-in-the-loop harness.
Design intent lives in [DESIGN.md §13](../DESIGN.md); this file is how to run it.

## Quick start

```bash
cd sitl
docker compose --profile sitl up -d --build
```

`prepare-logs` creates writable `./logs/<service>/` dirs before vehicles start
(avoids root-owned bind mounts that block DataFlash / ulogs).

Point a host Node-RED (with this package installed) at the ports below — Connections
must bind **`0.0.0.0`** (not `127.0.0.1`) so UDP from the Compose bridge reaches them.
Or also start Node-RED in Compose:

```bash
docker compose --profile sitl --profile nodered up -d --build
# Editor: http://localhost:1880
```

ArduPilot uses the official prebuilt static SITL binary from
`firmware.ardupilot.org/Copter/stable-4.7.0/SITL_x86_64_linux_gnu/arducopter`
(~7 MB; image build is a download, not a waf compile). PX4 uses the official
`px4io/px4-sitl` image directly (no local rebuild).

**Nested Docker note:** if `docker run` fails with overlay/whiteout errors, set
`"storage-driver": "vfs"` in `/etc/docker/daemon.json` and restart the daemon (slower,
but works in restricted VMs).

## Port and sysid map

| Role | Sysids | Node-RED bind → remote | SITL sends telemetry to |
|------|--------|------------------------|-------------------------|
| ArduPilot GCS fleet | 1–5 | **`0.0.0.0:14550` → `14551`** | host `14550` |
| PX4 GCS fleet | 11–15 | **`0.0.0.0:14560` → `14561`** | host `14560` |
| AP companion vehicle | 20 | **`0.0.0.0:14540` → `14541`** | host `14540` |
| PX4 companion vehicle | 21 | **`0.0.0.0:14542` → `14543`** | host `14542` |
| AP payload (gimbal/camera) | 31 | **`0.0.0.0:14570` → `14571`** | host `14570` |
| PX4 payload | 32 | reserved | SIH has no useful gimbal/camera |

Existing GCS examples expect AP on `14550/14551` and PX4 on `14560/14561`. Companion
lab flows are `examples/sitl/05-companion-ap.json` and `06-companion-px4.json`.
Payload flows are `examples/sitl/16–18` against `ap-payload-31` (`--gimbal` +
`params/ap-payload-gimbal.parm`).

### Why examples still list two ports

Each Connection binds the receive port (`14550` AP / `14560` PX4) and keeps a
configured `remotePort` (`14551` / `14561`) as the pre-peer send fallback. Lab
vehicles use **udpclient** (AP prebuilt `--serial0 udpclient:host:14550`, PX4
mavlink `-t host -o 14560`): they send telemetry to the bind port, and after the
first HEARTBEAT the Connection peer table replies to each vehicle’s source
endpoint. Directed commands do not need a published listen on `14551`.

PX4 uses **14560/14561** so its GCS pair does not collide with ArduPilot’s
historical `-I` port band (`14550 + 10×instance`). Companion traffic uses the
ecosystem convention around **14540** (onboard / MAVSDK).

## What gets started

Thirteen containers (Compose profile `sitl`):

- `ap-1` … `ap-5` — ArduCopter, sysid 1–5  
- `px4-11` … `px4-15` — PX4 SIH quad, sysid 11–15  
- `ap-companion-20`, `px4-companion-21` — dedicated companion-test vehicles  
- `ap-payload-31` — ArduCopter with `--gimbal` + mount/camera defaults, sysid 31  

Each vehicle has `extra_hosts: host.docker.internal:host-gateway`. Entrypoints resolve that
name to an IPv4 address and, when Compose maps it to idle `docker0` while the container sits
on a user-defined bridge, fall back to the container default gateway so UDP still reaches
Node-RED on the host. Flight logs mount under `sitl/logs/<service>/`.

## Example flows

| Import | Needs |
|--------|--------|
| Most `examples/sitl/01–27` AP paths | AP fleet (or single) on `14550/14551` |
| `examples/sitl/37-dual-stack-ten.json` | Full GCS fleets 1–5 and 11–15 |
| `examples/sitl/41-mode-names.json` | AP 1 on `14550/14551` + PX4 11 on `14560/14561` |
| `examples/sitl/05-companion-ap.json` | Companion AP sysid 20 on `14540/14541` |
| `examples/sitl/06-companion-px4.json` | Companion PX4 sysid 21 on `14542/14543` |

GCS flows use a **GCS** Local Identity. Companion flows use **companion** role, sharing the
vehicle sysid with component **191**.

## Logging

From `sitl/` (after `cd sitl`):

**Compose console**

```bash
docker compose logs -f ap-1
```

**Flight logs (arm-only)**  
ArduPilot starts with `LOG_DISARMED 0`. PX4 sets `SDLOG_MODE=1` (arm→disarm) via
`params/px4-logging.env`. Entrypoints symlink firmware log dirs to the Compose
`./logs/<service>` mount, and **wipe that directory on every container start**
so prior sessions do not accumulate. Stop (without restart) still leaves the
last session on the host for pull; the next start clears it.

```bash
touch logs/ap-1/.arm-marker          # immediately before arming
# …arm in Node-RED…
./check-logs.sh --logs-root logs --expect-armed ap-1 --newer-than-marker
ls -la logs/ap-1
```

Open `.BIN` in Mission Planner / UAV Log Viewer; `.ulg` with `ulog_info` if installed.

## Useful commands

```bash
# from sitl/
docker compose --profile sitl ps
docker compose --profile sitl down
docker compose --profile sitl up -d --build ap-1   # one vehicle
docker compose --profile sitl --profile nodered up -d   # + Node-RED (host network)
```

The `nodered` profile uses `network_mode: host` so flows that bind `0.0.0.0:14550`
(etc.) receive UDP vehicles send to the Compose bridge gateway.

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Port already in use | `ss -ulpn \| grep -E '14550\|14560\|14540'` — stop QGC/other SITL |
| No peers in State/In | `docker compose … logs ap-1` — confirm `out=udp:<host-ip>:…` (gateway, not silent) |
| PX4 ignores COMMAND_* to sysid 11–15 (broadcast/`target_system=0` still works) | `commander` cached `system_id=1` because `MAV_SYS_ID` was rewritten after `commander start`. Restart PX4 containers on an entrypoint that sets `MAV_SYS_ID` before commander; confirm with `px4-listener vehicle_status` → `system_id` matches the lab sysid |
| Only one vehicle answers commands | Wait for HEARTBEATs so the peer table learns each UDP source port |
| PX4 silent | Confirm image tag still provides SIH (`PX4_SIM_MODEL=sihsim_quadx`); check entrypoint logs |
| `check-logs` fails after arm | List `sitl/logs/<service>`; firmware may write under a nested folder (checker searches recursively) |

## Measured bring-up

Entrypoints log `out=udp:<gateway-ip>:…` when `host-gateway` would otherwise point at idle
`docker0`. On this lab host that selects `172.18.0.1` for `sitl_default`.

**PX4:** `docker compose --profile sitl up -d` emits HEARTBEATs with sysids **11–15** on UDP
**14560** and sysid **21** on **14542** (re-checked after the gateway fallback).

**ArduPilot:** image builds locally (`nrc-mavlink-ap-sitl:local`) by downloading the
official Copter-4.7.0 static SITL binary plus `Tools/autotest/default_params/copter.parm`
(see `Dockerfile.ardupilot`). The entrypoint runs `/usr/local/bin/arducopter` with
`--defaults /params/copter.parm,/params/ap-logging.parm` and
`--serial0 udpclient:<gateway>:14550` (or `14540` for the companion). Without the
autotest defaults, ARM is DENIED. Confirm with `docker compose … logs ap-1` showing
`Loaded defaults from /params/copter.parm,…` and HEARTBEATs on host UDP **14550**.

## CI note

Ordinary package CI does **not** build or run this 12-vehicle lab. Fixture tests cover
protocol code; this harness is for local / operator firmware behaviour.
