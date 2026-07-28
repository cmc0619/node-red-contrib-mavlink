# SITL example flows

These flows require a live SITL rig because they test firmware behaviour that cannot be
faked with fixtures: completion timing, mode tables, the PX4 parameter int/float union,
mission/fence/rally per stack, swarm pacing across five vehicles, and signing. The
top-level [`examples/`](../) demos work against any MAVLink link; these need real firmware.

## The rig

The testing rig runs **five ArduPilot** instances at system IDs **1–5** and **five PX4**
instances at **11–15**, on **separate connections**, each with its own Vehicle Profile.
The gap between 5 and 11 is deliberate: a mistyped sysid lands nowhere, not on the wrong
stack.

## Start the ArduPilot five

```bash
for i in 0 1 2 3 4; do \
  sim_vehicle.py -v ArduCopter -I $i --sysid $((i+1)) \
    --out=udp:127.0.0.1:14550 & \
done
```

Bind the ArduPilot Connection to `127.0.0.1:14550` (receives SITL `--out`), remote
`127.0.0.1:14551` (where Node-RED sends commands — MAVProxy's default listen).

## Start the PX4 five

PX4 multi-instance networking is version-specific. A common approach:

```bash
./Tools/simulation/sitl_multiple_run.sh 5
```

—or per-instance `make px4_sitl` with `PX4_INSTANCE`—then set `MAV_SYS_ID` = **11–15** per
instance.

PX4 emits its GCS MAVLink on a different port set than ArduPilot. Point the PX4
Connection at the port your build uses (commonly `14550` broadcast or `14570`/`14580`) and
**verify against your PX4 version** — do not assume ArduPilot's ports.

## One vs five instances

Most flows use a single instance. Swarm and dual-stack flows use five per stack. Each
flow's tab comment names exactly which instances it needs.

## Signing

Signing needs extra setup: a matching key on the SITL side. [`12-signing.json`](12-signing.json)
documents the dry-run procedure. Signing is off by default in all other examples.

## What is not provisioned here

SITL itself is the operator's local rig; nothing in this package launches it for you. The
fixture test suite (`node --test`) covers everything that does not need firmware.
Cross-connection swarm is out of scope (see `DESIGN.md`).

## Safety

SITL only — but several flows arm, fly, flip, terminate, or force-disarm. Never point these
at a real vehicle without understanding each step.

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
