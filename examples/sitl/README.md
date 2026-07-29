# SITL example flows

These flows need live firmware behaviour (completion timing, mode tables, PX4 param
union, mission/fence/rally, swarm pacing, signing). Prefer the **Docker lab** in
[`sitl/README.md`](../../sitl/README.md) over hand-built trees.

## The rig

| Stack | Sysids | Node-RED bind → remote |
|-------|--------|------------------------|
| ArduPilot GCS | 1–5 | `14550` → `14551` |
| PX4 GCS | 11–15 | `14560` → `14561` |
| AP companion | 20 | `14540` → `14541` |
| PX4 companion | 21 | `14542` → `14543` |

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
| `03-temporarily-rejected.json` | SITL 03 Temporarily rejected | 1× ArduPilot (fresh boot) |
| `04-mode-tables.json` | SITL 04 Mode tables | 1× ArduPilot + 1× PX4 |
| `05-px4-param-union.json` | SITL 05 PX4 param union | 1× PX4 |
| `06-mission-fence-rally.json` | SITL 06 Mission/fence/rally | 1× ArduPilot + 1× PX4 |
| `07-mission-failloud.json` | SITL 07 Mission fail-loud | 1× ArduPilot |
| `08-swarm-sequential-five.json` | SITL 08 Swarm ×5 pacing | 5× ArduPilot |
| `09-swarm-member-expires.json` | SITL 09 Swarm member expires | 5× ArduPilot |
| `10-dual-stack-ten.json` | SITL 10 Dual-stack ×10 | 5× ArduPilot + 5× PX4 |
| `11-broadcast-vs-sequential.json` | SITL 11 Broadcast vs sequential | 5× ArduPilot |
| `12-signing.json` | SITL 12 Signing | 1× ArduPilot (+ signing setup) |
| `13-param-defs-live.json` | SITL 13 Param defs (live) | 1× ArduPilot |
| `14-command-mission-basics.json` | SITL 14 Command & mission basics | 2× ArduPilot |
| `15-companion-ap.json` | SITL 15 Companion AP | companion AP sysid 20 |
| `16-companion-px4.json` | SITL 16 Companion PX4 | companion PX4 sysid 21 |
