#!/usr/bin/env bash
# Launch one PX4 SITL instance. Sends GCS MAVLink to OUT_HOST:OUT_PORT.
# Required: SYSID. Optional: INSTANCE, OUT_HOST, OUT_PORT.
set -euo pipefail

: "${SYSID:?SYSID is required}"
INSTANCE="${INSTANCE:-0}"
OUT_HOST="${OUT_HOST:-host.docker.internal}"
OUT_PORT="${OUT_PORT:-14560}"

if [[ -f /params/px4-logging.env ]]; then
  # shellcheck disable=SC1091
  set -a
  source /params/px4-logging.env
  set +a
fi

mkdir -p /logs
export PX4_SIM_MODEL="${PX4_SIM_MODEL:-sihsim_quadx}"
export HEADLESS="${HEADLESS:-1}"

# Working dir inside the official image (layout may vary by tag).
WORK="${PX4_WORKDIR:-/root/PX4-Autopilot}"
if [[ ! -d "$WORK" ]]; then
  WORK="$(find / -maxdepth 3 -type d -name 'PX4-Autopilot' 2>/dev/null | head -n1 || true)"
fi
if [[ -z "${WORK}" || ! -d "${WORK}" ]]; then
  echo "entrypoint-px4: cannot find PX4-Autopilot tree in image" >&2
  ls -la / || true
  exit 1
fi
cd "$WORK"

# Inject sysid + arm-only logging + GCS target into POSIX extras.
EXTRAS_DIR="${WORK}/build/px4_sitl_default/etc/init.d-posix"
mkdir -p /tmp/px4-extras
cat > /tmp/px4-extras/99_nrc_lab <<EOF
#!/bin/sh
param set MAV_SYS_ID ${SYSID}
param set SDLOG_MODE ${SDLOG_MODE:-1}
# Re-point GCS MAVLink remote at the Node-RED bind (host).
# Local port follows PX4 convention 18570+instance.
mavlink stop-all || true
mavlink start -x -u \$((18570 + ${INSTANCE})) -r 4000000 -f -o ${OUT_PORT} -t ${OUT_HOST}
EOF
chmod +x /tmp/px4-extras/99_nrc_lab

# Prefer dropping into ROMFS extras if present; else rely on PX4_SIM_MODEL startup + param file.
if [[ -d "${EXTRAS_DIR}" ]]; then
  cp /tmp/px4-extras/99_nrc_lab "${EXTRAS_DIR}/99_nrc_lab" || true
fi

echo "entrypoint-px4: sysid=${SYSID} instance=${INSTANCE} gcs=${OUT_HOST}:${OUT_PORT} model=${PX4_SIM_MODEL}"

# Official image CMD is usually a helper; fall back to make px4_sitl.
if [[ -x /entrypoint.sh ]]; then
  export PX4_SYS_AUTOSTART="${PX4_SYS_AUTOSTART:-1001}"
  exec /entrypoint.sh
fi

if [[ -x ./build/px4_sitl_default/bin/px4 ]]; then
  exec ./build/px4_sitl_default/bin/px4 -i "${INSTANCE}" -d
fi

echo "entrypoint-px4: no known PX4 launch path; inspect the base image" >&2
exit 1
