#!/usr/bin/env bash
# Launch one ArduCopter SITL instance for the lab from the official prebuilt binary.
# Required: SYSID. Optional: INSTANCE, OUT_HOST, OUT_PORT, HOME_*, ENABLE_GIMBAL,
# EXTRA_DEFAULTS (comma-separated paths appended after the lab defaults).
set -euo pipefail

# shellcheck source=resolve-out-host.sh
. "$(dirname "$0")/resolve-out-host.sh"

: "${SYSID:?SYSID is required}"
INSTANCE="${INSTANCE:-0}"
OUT_HOST="${OUT_HOST:-host.docker.internal}"
OUT_PORT="${OUT_PORT:-14550}"
HOME_LAT="${HOME_LAT:--35.363262}"
HOME_LON="${HOME_LON:-149.165237}"
HOME_ALT="${HOME_ALT:-584}"
ENABLE_GIMBAL="${ENABLE_GIMBAL:-0}"
EXTRA_DEFAULTS="${EXTRA_DEFAULTS:-}"

LAT="$(awk -v b="$HOME_LAT" -v i="$INSTANCE" 'BEGIN { printf "%.8f", b + (i * 0.0001) }')"
LON="$(awk -v b="$HOME_LON" -v i="$INSTANCE" 'BEGIN { printf "%.8f", b + (i * 0.0001) }')"

OUT_IP="$(resolve_out_host_ip "${OUT_HOST}")"
if [[ -z "${OUT_IP}" ]]; then
  echo "entrypoint-ap: FATAL - could not resolve ${OUT_HOST} to an IPv4 address" >&2
  exit 1
fi

mkdir -p /logs
# New process = new session: clear the bind mount so prior DataFlash does not
# accumulate across restarts. A stopped container still keeps logs on the host
# until the next start.
find /logs -mindepth 1 -delete
AIRCRAFT="lab-ap-${SYSID}"
RUN_DIR="/home/sitl/aircraft/${AIRCRAFT}"
mkdir -p "${RUN_DIR}"
# DataFlash lands under cwd/logs; point that at the Compose bind mount.
rm -rf "${RUN_DIR}/logs"
ln -sfn /logs "${RUN_DIR}/logs"
cd "${RUN_DIR}"
export HOME="/home/sitl"

DEFAULTS="/params/copter.parm,/params/ap-logging.parm"
if [[ -n "${EXTRA_DEFAULTS}" ]]; then
  DEFAULTS="${DEFAULTS},${EXTRA_DEFAULTS}"
fi

GIMBAL_ARGS=()
if [[ "${ENABLE_GIMBAL}" == "1" || "${ENABLE_GIMBAL}" == "true" ]]; then
  GIMBAL_ARGS+=(--gimbal)
fi

echo "entrypoint-ap: sysid=${SYSID} instance=${INSTANCE} out=udpclient:${OUT_IP}:${OUT_PORT} (from ${OUT_HOST}) home=${LAT},${LON},${HOME_ALT} aircraft=${AIRCRAFT} gimbal=${ENABLE_GIMBAL} defaults=${DEFAULTS}"

# Official static binary (firmware.ardupilot.org). udpclient sends telemetry to
# the Node-RED bind port; Connection learns each vehicle's source endpoint from
# HEARTBEATs and replies there (same pattern as the PX4 lab link).
# -I kept so SIM/RC ports do not collide if several instances share a netns.
exec /usr/local/bin/arducopter \
  -w \
  -I "${INSTANCE}" \
  --model quad \
  --speedup 1 \
  --sysid "${SYSID}" \
  --home "${LAT},${LON},${HOME_ALT},270" \
  "${GIMBAL_ARGS[@]}" \
  --defaults "${DEFAULTS}" \
  --serial0 "udpclient:${OUT_IP}:${OUT_PORT}"
