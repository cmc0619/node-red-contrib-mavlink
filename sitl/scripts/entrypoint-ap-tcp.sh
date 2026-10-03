#!/usr/bin/env bash
# ArduCopter SITL with SERIAL0 as a TCP server (Mission Planner / example 19 shape).
# Required: SYSID. Optional: INSTANCE (TCP port = 5760 + 10*INSTANCE), HOME_*.
#
# Unlike entrypoint-ap.sh (udpclient to the Node-RED bind), this leaves SITL's
# default SERIAL0 TCP listener so a host Connection mode=tcp can dial in.
# Publish the port from Compose (5760 for INSTANCE=0).
set -euo pipefail

: "${SYSID:?SYSID is required}"
INSTANCE="${INSTANCE:-0}"
HOME_LAT="${HOME_LAT:--35.363262}"
HOME_LON="${HOME_LON:-149.165237}"
HOME_ALT="${HOME_ALT:-584}"
EXTRA_DEFAULTS="${EXTRA_DEFAULTS:-}"

LAT="$(awk -v b="$HOME_LAT" -v i="$INSTANCE" 'BEGIN { printf "%.8f", b + (i * 0.0001) }')"
LON="$(awk -v b="$HOME_LON" -v i="$INSTANCE" 'BEGIN { printf "%.8f", b + (i * 0.0001) }')"
TCP_PORT=$((5760 + 10 * INSTANCE))

mkdir -p /logs
find /logs -mindepth 1 -delete
AIRCRAFT="lab-ap-tcp-${SYSID}"
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

echo "entrypoint-ap-tcp: sysid=${SYSID} instance=${INSTANCE} serial0=tcp:${TCP_PORT} home=${LAT},${LON},${HOME_ALT} aircraft=${AIRCRAFT} defaults=${DEFAULTS}"

# No --serial0 override: SITL binds SERIAL0 as TCP server on 5760+10*INSTANCE
# ("Waiting for connection ...." then mavlink on accept). See sitl/AGENTS.md.
exec /usr/local/bin/arducopter \
  -w \
  -I "${INSTANCE}" \
  --model quad \
  --speedup 1 \
  --sysid "${SYSID}" \
  --home "${LAT},${LON},${HOME_ALT},270" \
  --defaults "${DEFAULTS}"
