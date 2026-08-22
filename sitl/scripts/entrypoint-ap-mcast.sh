#!/usr/bin/env bash
# ArduCopter SITL on a MULTICAST serial link — the swarm-delivery test vehicle.
#
# ============================ TEST BRIEF (pick me up) ==========================
# Purpose: measure the Connection's Swarm address (multicast) end to end. The
# feature has NEVER spoken to a vehicle (landed #137, mock-dgram tests only) and
# ships with two documented defects. The owner's decision — fix or cut before
# 1.0 — hangs on what this rig measures. TODO.md "Swarm delivery" has the full
# background; results go to a `sitl-results` GitHub issue (new issue per run,
# close the previous "Superseded by #<new>"), and each finding becomes a
# DESIGN.md §14 entry in house style (belief / fact / how to re-check).
#
# How this vehicle differs from the ap-N fleet: --serial0 is
# `mcast:${MCAST_GROUP}:${MCAST_PORT}` instead of `udpclient:<host>:14550`.
# ArduPilot's SITL parser accepts `mcast:[ADDRESS][:PORT]` and it is the ONLY
# one-write mode AP SITL can be a member of (there is no udpin:). The vehicle
# both transmits telemetry to the group and receives commands from it — a
# party line, two-way.
#
# Run:   cd sitl && docker compose --profile mcast up -d --build
# Vehicle: sysid 41, group 239.255.145.50:14550 (defaults below).
# ap-mcast-41 uses network_mode: host — the compose bridge does not deliver
# inter-container IPv4 multicast (measured 2026-08-22). Run measure-swarm-mcast.js
# from the host, not from a bridge-attached container.
#
# What the driver does today (main, unfixed) — you are expected to hit these:
#   1. lib/connection/transport/udp.js `_enableBroadcast` calls
#      setMulticastLoopback(false). Planned fix: delete the line. Until it
#      lands, same-host senders on the group may not hear each other.
#   2. Nothing filters self-echoed frames: with loopback on, the GCS's own
#      transmissions come back from the group, register as a peer (sysid 255),
#      and In nodes see our own commands. Planned fix (pending owner blessing):
#      drop inbound frames whose (sysid,compid) matches a bound identity.
#   Measure and report both behaviors as found — the fixes land only after the
#   measurements say what they must.
#
# Node-RED-side Connection settings for the test:
#   mode udp · bind 0.0.0.0:14550 · remote (leave for the group) ·
#   Swarm address 239.255.145.50 · swarm port 14550
#
# THE TRAP (known, deliberately unsolved — the multicast-interface option was
# deferred by owner ruling 2026-08-22): addMembership() with no interface lets
# the OS pick by routing table. The lab's nodered profile runs host-network
# while this vehicle sits on the compose bridge, so the host's default route —
# not the bridge — likely wins, and the group never crosses. Run the test
# Node-RED INSIDE the compose network instead, e.g.:
#   docker run --rm -it --network sitl_default -p 1880:1880 nodered/node-red:4.0
# (then npm install the package into /data as sitl/nodered/install-and-start.sh
# does), or document the routing behavior you actually observe — that
# observation is itself one of the measurements the deferred option waits on.
#
# What to measure (each one -> a §14-entry-shaped fact):
#   a. Group membership: does the vehicle's HEARTBEAT reach a group-joined
#      Connection at all? (peer 41 appears in the peer table)
#   b. Outbound swarm write: a broadcast send (target_system 0, e.g. fan-out
#      broadcast arm) written ONCE to the group — does sysid 41 act on it?
#   c. Loopback: with the unfixed driver, do two group members on one host
#      hear each other? (expected: no — defect 1)
#   d. Self-echo: after fixing/forcing loopback on, does the GCS appear in its
#      own peer table? (expected: yes — defect 2)
#   e. PX4 subnet broadcast (px4-bcast-42 below): PX4 joins no group; its
#      mavlink binds a UDP port. Does a subnet-broadcast datagram
#      (e.g. to the bridge's .255) reach it and does it act on target_system 0?
# ==============================================================================
#
# Required: SYSID. Optional: INSTANCE, MCAST_GROUP, MCAST_PORT, HOME_*,
# EXTRA_DEFAULTS (comma-separated paths appended after the lab defaults).
set -euo pipefail

: "${SYSID:?SYSID is required}"
INSTANCE="${INSTANCE:-0}"
MCAST_GROUP="${MCAST_GROUP:-239.255.145.50}"
MCAST_PORT="${MCAST_PORT:-14550}"
HOME_LAT="${HOME_LAT:--35.363262}"
HOME_LON="${HOME_LON:-149.165237}"
HOME_ALT="${HOME_ALT:-584}"
EXTRA_DEFAULTS="${EXTRA_DEFAULTS:-}"

LAT="$(awk -v b="$HOME_LAT" -v i="$INSTANCE" 'BEGIN { printf "%.8f", b + (i * 0.0001) }')"
LON="$(awk -v b="$HOME_LON" -v i="$INSTANCE" 'BEGIN { printf "%.8f", b + (i * 0.0001) }')"

mkdir -p /logs
AIRCRAFT="lab-ap-${SYSID}"
RUN_DIR="/home/sitl/aircraft/${AIRCRAFT}"
mkdir -p "${RUN_DIR}"
rm -rf "${RUN_DIR}/logs"
ln -sfn /logs "${RUN_DIR}/logs"
cd "${RUN_DIR}"
export HOME="/home/sitl"

DEFAULTS="/params/copter.parm,/params/ap-logging.parm"
if [[ -n "${EXTRA_DEFAULTS}" ]]; then
  DEFAULTS="${DEFAULTS},${EXTRA_DEFAULTS}"
fi

echo "entrypoint-ap-mcast: sysid=${SYSID} instance=${INSTANCE} serial0=mcast:${MCAST_GROUP}:${MCAST_PORT} home=${LAT},${LON},${HOME_ALT} aircraft=${AIRCRAFT} defaults=${DEFAULTS}"

exec /usr/local/bin/arducopter \
  -w \
  -S \
  -I "${INSTANCE}" \
  --model quad \
  --speedup 1 \
  --sysid "${SYSID}" \
  --home "${LAT},${LON},${HOME_ALT},270" \
  --defaults "${DEFAULTS}" \
  --serial0 "mcast:${MCAST_GROUP}:${MCAST_PORT}"
