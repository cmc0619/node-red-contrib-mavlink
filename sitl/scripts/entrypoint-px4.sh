#!/usr/bin/env bash
# Wrapper around px4io/px4-sitl's entrypoint for the nrc lab port/sysid map.
# Required: SYSID. Optional: INSTANCE, OUT_HOST, OUT_PORT.
set -euo pipefail

: "${SYSID:?SYSID is required}"
INSTANCE="${INSTANCE:-0}"
OUT_HOST="${OUT_HOST:-host.docker.internal}"
OUT_PORT="${OUT_PORT:-14560}"

if [[ -f /params/px4-logging.env ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source /params/px4-logging.env
  set +a
fi

mkdir -p /logs

if [[ -d /opt/px4-gazebo ]]; then
  PX4_PREFIX=/opt/px4-gazebo
else
  PX4_PREFIX=/opt/px4
fi

# Persist ulogs into the Compose bind mount (PX4 writes ./log under the prefix).
rm -rf "${PX4_PREFIX}/log"
ln -sfn /logs "${PX4_PREFIX}/log"

MAVLINK_RC="${PX4_PREFIX}/etc/init.d-posix/px4-rc.mavlink"
RCS="${PX4_PREFIX}/etc/init.d-posix/rcS"

# Resolve Docker host for MAVLink (IPv4 only — same approach as upstream entrypoint).
DOCKER_HOST_IP="$(getent ahostsv4 "${OUT_HOST}" 2>/dev/null | awk '/STREAM/ { print $1; exit }' || true)"
if [[ -z "${DOCKER_HOST_IP}" ]]; then
  DOCKER_HOST_IP="$(getent ahostsv4 host.docker.internal 2>/dev/null | awk '/STREAM/ { print $1; exit }' || true)"
fi

if [[ -n "${DOCKER_HOST_IP}" && -f "${MAVLINK_RC}" ]]; then
  # Point GCS MAVLink at host:OUT_PORT (lab uses 14560, not the image default 14550).
  sed -i -E \
    "s|mavlink start -x -u \\\$udp_gcs_port_local -r 4000000 -f.*|mavlink start -x -u \$udp_gcs_port_local -r 4000000 -f -t ${DOCKER_HOST_IP} -o ${OUT_PORT}|" \
    "${MAVLINK_RC}"
  # Companion / offboard remote stays on 14540+instance by default; for companion
  # containers OUT_PORT is already 14542 and we also retarget the onboard link.
  if [[ "${OUT_PORT}" == "14542" || "${OUT_PORT}" == "14540" ]]; then
    sed -i -E \
      "s|mavlink start -x -u \\\$udp_offboard_port_local -r 4000000 -f -m onboard -o \\\$udp_offboard_port_remote.*|mavlink start -x -u \$udp_offboard_port_local -r 4000000 -f -m onboard -o ${OUT_PORT} -t ${DOCKER_HOST_IP}|" \
      "${MAVLINK_RC}"
  fi
fi

# MAVLink reads MAV_SYS_ID when `. px4-rc.mavlink` runs — set it immediately before.
# Airframes also reset it earlier, so an early-only set is not enough.
if [[ -f "${RCS}" ]] && ! grep -q 'nrc_lab_params_pre_mavlink' "${RCS}"; then
  tmp="$(mktemp)"
  awk -v sysid="${SYSID}" -v sdlog="${SDLOG_MODE:-1}" '
    /\. px4-rc\.mavlink/ && !done {
      print "# nrc_lab_params_pre_mavlink — must precede mavlink start"
      print "param set MAV_SYS_ID " sysid
      print "param set SDLOG_MODE " sdlog
      done=1
    }
    { print }
  ' "${RCS}" > "${tmp}"
  mv "${tmp}" "${RCS}"
fi

export PX4_SIM_MODEL="${PX4_SIM_MODEL:-sihsim_quadx}"
export HEADLESS="${HEADLESS:-1}"

# Stop boot-time file logging if the logger still opened one (SDLOG_MODE=1 intent).
if [[ -f "${RCS}" ]] && ! grep -q 'nrc_lab_params_tail' "${RCS}"; then
  cat >> "${RCS}" <<EOF

# nrc_lab_params_tail
param set MAV_SYS_ID ${SYSID}
param set SDLOG_MODE ${SDLOG_MODE:-1}
logger stop || true
EOF
fi

echo "entrypoint-px4: sysid=${SYSID} instance=${INSTANCE} gcs=${DOCKER_HOST_IP:-${OUT_HOST}}:${OUT_PORT} model=${PX4_SIM_MODEL}"

# Prefer upstream binary with instance; working dir = install prefix (has etc/).
cd "${PX4_PREFIX}"
exec "${PX4_PREFIX}/bin/px4" -i "${INSTANCE}" -d
