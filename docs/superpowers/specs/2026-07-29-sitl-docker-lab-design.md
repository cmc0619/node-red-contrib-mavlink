# SITL Docker lab (five+five + companions)

**Date:** 2026-07-29  
**Status:** Implemented (Docker daemon bring-up is operator-side; CI does not run the lab)  
**Related:** DESIGN.md §6 (mixed fleet / two Connections), §13 (SITL rig), `examples/sitl/`

## Goal

Ship a **one-command Docker lab** that runs the DESIGN §13 rig plus companion-mode vehicles, with ports that match (retargeted) example flows, so an end user can exercise GCS and companion Node-RED flows without hand-building firmware trees.

## Non-goals

- Gazebo / 3D visuals
- Real radios or hardware
- Cross-connection swarm (still out of scope per DESIGN)
- Signing keys baked into Compose
- Auto-flying all vehicles on boot
- Running the full 12× SITL matrix in CI in the first implementation PR (optional later)

## Architecture

**One container per vehicle** under `sitl/` (Compose + thin Dockerfiles + helpers).

Compose profiles:

| Profile | Default | Contents |
|---------|---------|----------|
| `sitl` | no — pass `--profile sitl` | 12 vehicle services |
| `nodered` | no — pass `--profile nodered` | Node-RED with this package installed + lab flows preloaded |

Start vehicles with `docker compose --profile sitl up`. Operators may run Node-RED on the
host against the published ports (normal path for existing examples), or also pass
`--profile nodered` for an all-in-one lab.

```text
                    ┌─────────────────────────────────────┐
                    │  Node-RED (host or nodered profile) │
                    │  GCS identity + companion identity  │
                    └──────────────┬──────────────────────┘
           bind 14550│ 14560│ 14540│ 14542
                     │      │      │      │
        ┌────────────┘      │      │      └────────────┐
        ▼                   ▼      ▼                   ▼
   AP GCS fleet        PX4 GCS   AP companion     PX4 companion
   sysid 1–5           11–15     sysid 20         sysid 21
   (5 containers)      (5)       (1)              (1)
```

## Port and sysid map

| Role | Count | Sysids | SITL → Node-RED (`--out` / GCS UDP) | Node-RED → vehicle | Notes |
|------|------:|--------|-------------------------------------|--------------------|--------|
| ArduPilot GCS fleet | 5 | 1–5 | host **14550** | remote **14551** (MAVProxy / instance 0) | Matches existing AP examples; `-I 0..4` avoids process port clashes |
| PX4 GCS fleet | 5 | 11–15 | host **14560** | remote **14561** | Clears AP `-I` band (`14550+10×N`); examples retargeted from `14555` |
| AP companion vehicle | 1 | **20** | host **14540** | remote **14541** | Ecosystem companion/onboard convention |
| PX4 companion vehicle | 1 | **21** | host **14542** | remote **14543** | Separate stream from AP companion |

### Why MAVProxy appears (ArduPilot only)

`sim_vehicle.py` typically starts **MAVProxy** in front of ArduPilot SITL: telemetry is forwarded to the GCS (`--out` → Node-RED bind **14550**), and commands return to MAVProxy’s listen port (**14551** for instance 0). PX4 SITL has no MAVProxy; it uses its own MAVLink UDP pair (**14560/14561** in this lab).

### Docker ↔ Node-RED networking

- Vehicle containers send UDP to the **host** where Node-RED binds (`host.docker.internal` via Compose `extra_hosts: host.docker.internal:host-gateway` on Linux).
- Published ports are for documentation/symmetry; the important direction for GCS demos is **container → host bind**.
- Outbound commands from this package resolve `peerTable.endpointFor(sysid, compid)` (the peer’s UDP source address/port) when a target is set; configured `remoteHost`/`remotePort` is the fallback before peers exist. Lab entrypoints must therefore give each vehicle a **stable, unique UDP source identity** (normal for `-I` / per-container MAVProxy) so sysids 2–5 are reachable, not only instance 0’s `14551`.
- The optional `nodered` service joins the Compose network; prefer publishing the same host ports so flows keep `127.0.0.1` binds, or document a one-line bindHost override if host networking is used instead.

### Node-RED identities

- **GCS flows:** Local Identity `role: gcs` on the AP Connection (`14550/14551`) and PX4 Connection (`14560/14561`). Two Connections, two Vehicle profiles (ArduPilot / PX4) — DESIGN mixed-fleet rule.
- **Companion flows:** Local Identity `role: companion`, **sharing the vehicle sysid** (20 or 21) with component **191** (`MAV_TYPE_ONBOARD_CONTROLLER`), on the companion Connections (`14540/14541`, `14542/14543`). Same pattern as `examples/20-companion-origination.json`, but dedicated vehicles/ports so GCS demos stay undisturbed.

## Components

### Compose services

- `ap-1` … `ap-5` — ArduCopter SITL, sysid 1–5, `--out` → host gateway:14550, `-I` 0–4, spaced homes  
- `px4-11` … `px4-15` — PX4 SITL, `MAV_SYS_ID` 11–15, GCS MAVLink to host:14560  
- `ap-companion-20` — ArduCopter SITL sysid 20 → host:14540  
- `px4-companion-21` — PX4 SITL sysid 21 → host:14542  
- Optional `nodered` — install package from bind mount / built context; import lab flows

Each vehicle service:

- Unique sysid and home offset  
- Log volume `./sitl/logs/<service>:/logs` (or equivalent path documented in `sitl/README.md`)  
- Restart policy suitable for lab use (restart on crash)  
- Firmware params: **flight logging starts on arm only**  
  - ArduPilot: `LOG_DISARMED=0` (and related defaults as needed)  
  - PX4: SDLOG / equivalent “log from arm” mode

### Logging (proof = both)

1. **Compose stdout:** `docker compose logs -f ap-1` (etc.) for boot/arm console.  
2. **Flight logs:** after arm, `.bin` / `.ulg` (as applicable) under `sitl/logs/…`.  
3. **`sitl/check-logs.sh`:** best-effort gate — no new flight log while continuously disarmed; log appears/grows after arm. Document firmware quirks; exit non-zero on clear failure.

### Example / flow updates

- Retarget all PX4 example binds from **14555** → **14560/14561** (JSON comments, `examples/CATALOG.md`, `examples/sitl/README.md`).  
- Refresh `examples/sitl/10-dual-stack-ten.json` for this port map.  
- Add companion SITL flow(s) for sysid 20/21 on `14540`/`14542` (sibling or extension of `20-companion-origination.json`).  
- Optional `nodered` profile preloads a small lab set (state/heartbeat, dual-stack, companion).

## Documentation (end-user first)

| Doc | Role |
|-----|------|
| **`sitl/README.md`** | Primary operator guide: port table, `compose up`, running examples, log check, troubleshooting (port busy, first heartbeat). Sized for end users — **not** a DESIGN dump. |
| Root `README.md` | Short pointer to `sitl/README.md`. |
| `examples/sitl/README.md` | Point at Docker lab; keep launch snippets consistent with the port map. |
| `DESIGN.md` §13 | One short paragraph: Docker lab exists under `sitl/`, link to `sitl/README.md`; keep §13 as the authoritative rig *definition*, not the operator manual. |

## Failure modes

| Symptom | Operator action |
|---------|-----------------|
| Port already in use | README hint (`ss`/`lsof`); stop conflicting GCS/SITL |
| No peers in State/In | Check compose ps/logs; confirm `--out` targets host gateway |
| AP peer on PX4 Connection (or reverse) | Connection profile mismatch warn (existing behaviour); repoint vehicle |
| Log check fails after arm | Inspect `sitl/logs/<service>`; confirm LOG_DISARMED / SDLOG params |

## Testing

- **Manual success criteria:**  
  - `docker compose --profile sitl up -d` → State/In shows sysids **1–5** and **11–15**  
  - Companion flows see **20** / **21**  
  - Arm one vehicle → flight log appears + compose logs show arm  
  - Existing GCS examples work against AP `14550/14551` and PX4 `14560/14561`  
  - `sitl/README.md` is enough without reading DESIGN.md  
- **CI:** fixture suite unchanged; full 12× SITL not required in the first PR.

## Implementation sketch (for the plan)

1. Scaffold `sitl/docker-compose.yml`, Dockerfiles, entrypoint scripts, `.gitignore` for `sitl/logs/`.  
2. Wire AP×5, PX4×5, companions×2 with the port/sysid map.  
3. Arm-only log params + `check-logs.sh`.  
4. Retarget examples + CATALOG + sitl example README.  
5. Companion SITL example flow(s).  
6. Optional `nodered` profile.  
7. Write `sitl/README.md`; pointer commits in root README + DESIGN §13.  

PR size: stay under the 50-file cap; split example retargets vs Compose scaffold if needed.

## Decisions log

| Decision | Choice |
|----------|--------|
| Mixed-fleet ports vs DESIGN “14550+14551 listeners” | AP keep example pair `14550/14551`; PX4 GCS at `14560/14561` so examples and AP MAVProxy do not collide |
| Multi-vehicle shape | One container per vehicle |
| Companion ports | `14540` (+ `14541` remote) AP; `14542`/`14543` PX4 |
| Node-RED placement | Compose profiles: `sitl` default, optional `nodered` |
| Logging | Flight logs on arm + compose logs; `check-logs.sh` |
| Docs | Short `sitl/README.md` primary; DESIGN §13 pointer only |
