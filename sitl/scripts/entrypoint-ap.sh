#!/usr/bin/env bash
# Launch one ArduCopter SITL instance for the lab.
# Required: SYSID. Optional: INSTANCE, OUT_HOST, OUT_PORT, HOME_*.
set -euo pipefail

: "${SYSID:?SYSID is required}"
INSTANCE="${INSTANCE:-0}"
OUT_HOST="${OUT_HOST:-host.docker.internal}"
OUT_PORT="${OUT_PORT:-14550}"
HOME_LAT="${HOME_LAT:--35.363262}"
HOME_LON="${HOME_LON:-149.165237}"
HOME_ALT="${HOME_ALT:-584}"

LAT="$(awk -v b="$HOME_LAT" -v i="$INSTANCE" 'BEGIN { printf "%.8f", b + (i * 0.0001) }')"
LON="$(awk -v b="$HOME_LON" -v i="$INSTANCE" 'BEGIN { printf "%.8f", b + (i * 0.0001) }')"

mkdir -p /logs
cd /home/sitl/ardupilot

# DataFlash often lands under the vehicle dir; symlink a stable /logs view when possible.
export HOME="/home/sitl"

echo "entrypoint-ap: sysid=${SYSID} instance=${INSTANCE} out=udp:${OUT_HOST}:${OUT_PORT} home=${LAT},${LON},${HOME_ALT}"

exec sim_vehicle.py -v ArduCopter \
  -I "${INSTANCE}" \
  --sysid "${SYSID}" \
  --custom-location="${LAT},${LON},${HOME_ALT},270" \
  --add-param-file=/params/ap-logging.parm \
  --out="udp:${OUT_HOST}:${OUT_PORT}" \
  --no-rebuild \
  -w
