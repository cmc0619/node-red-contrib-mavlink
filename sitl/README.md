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

First build of the ArduPilot image is large and slow (compiles SITL). PX4 uses the
official `px4io/px4-sitl` image directly (no local rebuild).

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

Existing GCS examples expect AP on `14550/14551` and PX4 on `14560/14561`. Companion
lab flows are `examples/sitl/15-companion-ap.json` and `16-companion-px4.json`.

### Why ArduPilot uses two ports (MAVProxy)

`sim_vehicle.py` starts a small helper (**MAVProxy**) in front of ArduPilot: it forwards
telemetry to your GCS (`--out` → bind **14550**) and listens for commands on **14551**
(instance 0). You do not run MAVProxy yourself. PX4 has no MAVProxy; this lab uses
**14560/14561** for its GCS pair so it does not collide with ArduPilot’s `-I` port band
(`14550 + 10×instance`).

Companion traffic uses the ecosystem convention around **14540** (onboard / MAVSDK).

## What gets started

Twelve containers (Compose profile `sitl`):

- `ap-1` … `ap-5` — ArduCopter, sysid 1–5  
- `px4-11` … `px4-15` — PX4 SIH quad, sysid 11–15  
- `ap-companion-20`, `px4-companion-21` — dedicated companion-test vehicles  

Each vehicle has `extra_hosts: host.docker.internal:host-gateway`. Entrypoints resolve that
name to an IPv4 address and, when Compose maps it to idle `docker0` while the container sits
on a user-defined bridge, fall back to the container default gateway so UDP still reaches
Node-RED on the host. Flight logs mount under `sitl/logs/<service>/`.

## Example flows

| Import | Needs |
|--------|--------|
| Any AP example / most `examples/sitl/01–14` | AP fleet (or single) on `14550/14551` |
| `examples/sitl/10-dual-stack-ten.json` | Full GCS fleets 1–5 and 11–15 |
| `examples/sitl/15-companion-ap.json` | Companion AP sysid 20 on `14540/14541` |
| `examples/sitl/16-companion-px4.json` | Companion PX4 sysid 21 on `14542/14543` |

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
`./logs/<service>` mount.

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
| Only sysid 1 answers commands | Wait for HEARTBEATs so the peer table learns each UDP source port |
| PX4 silent | Confirm image tag still provides SIH (`PX4_SIM_MODEL=sihsim_quadx`); check entrypoint logs |
| `check-logs` fails after arm | List `sitl/logs/<service>`; firmware may write under a nested folder (checker searches recursively) |

## Measured bring-up

Entrypoints log `out=udp:<gateway-ip>:…` when `host-gateway` would otherwise point at idle
`docker0`. On this lab host that selects `172.18.0.1` for `sitl_default`.

**PX4:** `docker compose --profile sitl up -d` emits HEARTBEATs with sysids **11–15** on UDP
**14560** and sysid **21** on **14542** (re-checked after the gateway fallback).

**ArduPilot:** image builds locally (`nrc-mavlink-ap-sitl:local`). The entrypoint passes
`--mavproxy-args=--daemon` so MAVProxy runs headless under Compose (interactive MAVProxy
with no TTY stops reading TCP 5760 and the container restart-loops). A log line
“Waiting for internal clock bits” is the LP5562 LED sim, not a boot gate — ignore it.
Check `/tmp/ArduCopter.log` inside the container if telemetry still never reaches the host.

## CI note

Ordinary package CI does **not** build or run this 12-vehicle lab. Fixture tests cover
protocol code; this harness is for local / operator firmware behaviour.
