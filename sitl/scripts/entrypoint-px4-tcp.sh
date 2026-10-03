#!/usr/bin/env bash
# PX4 SITL for the TCP lab. Official px4io GCS mavlink is UDP-only; this
# entrypoint keeps the GCS instance on localhost UDP and relies on a Compose
# socat sidecar (see docker-compose.yml profile tcp) to present TCP to the host.
#
# Required: SYSID. Optional: INSTANCE (local UDP = 18570+INSTANCE).
set -euo pipefail

: "${SYSID:?SYSID is required}"
INSTANCE="${INSTANCE:-0}"

if [[ -f /params/px4-logging.env ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source /params/px4-logging.env
  set +a
fi

mkdir -p /logs
find /logs -mindepth 1 -delete

if [[ -d /opt/px4-gazebo ]]; then
  PX4_PREFIX=/opt/px4-gazebo
else
  PX4_PREFIX=/opt/px4
fi

ROOTFS_DIR="${HOME:-/root}/.local/share/px4/rootfs/${INSTANCE}"
mkdir -p "${ROOTFS_DIR}"
rm -rf "${ROOTFS_DIR}/log"
ln -sfn /logs "${ROOTFS_DIR}/log"

MAVLINK_RC="${PX4_PREFIX}/etc/init.d-posix/px4-rc.mavlink"
RCS="${PX4_PREFIX}/etc/init.d-posix/rcS"

if [[ ! -f "${MAVLINK_RC}" ]]; then
  echo "entrypoint-px4-tcp: FATAL - ${MAVLINK_RC} not found" >&2
  exit 1
fi
if [[ ! -f "${RCS}" ]]; then
  echo "entrypoint-px4-tcp: FATAL - ${RCS} not found" >&2
  exit 1
fi

# GCS mavlink stays inside the container. Point heartbeats at the socat
# sidecar's fixed UDP source port (18580+instance) so unsolicited HB reaches
# TCP clients; inbound from the bridge still lands on 18570+instance.
UDP_GCS=$((18570 + INSTANCE))
UDP_BRIDGE=$((18580 + INSTANCE))
sed -i -E \
  "s|mavlink start -x -u \\\$udp_gcs_port_local -r 4000000 -f.*|mavlink start -x -u \$udp_gcs_port_local -r 4000000 -f -t 127.0.0.1 -o ${UDP_BRIDGE}|" \
  "${MAVLINK_RC}"
if ! grep -qE "mavlink start -x -u \\\$udp_gcs_port_local -r 4000000 -f -t 127.0.0.1 -o ${UDP_BRIDGE}" "${MAVLINK_RC}"; then
  echo "entrypoint-px4-tcp: FATAL - GCS mavlink rewrite failed" >&2
  exit 1
fi

# Same MAV_SYS_ID rewrites as entrypoint-px4.sh (commander caches system_id).
sed -i -E \
  "s|^param set MAV_SYS_ID \\\$\\(\\(\\s*px4_instance\\s*\\+\\s*1\\s*\\)\\)|param set MAV_SYS_ID ${SYSID}|" \
  "${RCS}"
if ! grep -qE "^param set MAV_SYS_ID ${SYSID}$" "${RCS}"; then
  echo "entrypoint-px4-tcp: FATAL - early MAV_SYS_ID rewrite failed" >&2
  exit 1
fi

if ! grep -q 'nrc_lab_params_pre_commander' "${RCS}"; then
  tmp="$(mktemp)"
  awk -v sysid="${SYSID}" '
    /commander start/ && !done {
      print "# nrc_lab_params_pre_commander — commander caches system_id at start"
      print "param set MAV_SYS_ID " sysid
      done=1
    }
    { print }
  ' "${RCS}" > "${tmp}"
  mv "${tmp}" "${RCS}"
fi

if ! grep -q 'nrc_lab_params_pre_mavlink' "${RCS}"; then
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

if ! grep -q 'nrc_lab_params_tail' "${RCS}"; then
  cat >> "${RCS}" <<EOF

# nrc_lab_params_tail
param set MAV_SYS_ID ${SYSID}
param set SDLOG_MODE ${SDLOG_MODE:-1}
EOF
fi

export PX4_SIM_MODEL="${PX4_SIM_MODEL:-sihsim_quadx}"
export HEADLESS="${HEADLESS:-1}"

echo "entrypoint-px4-tcp: sysid=${SYSID} instance=${INSTANCE} gcs_udp=127.0.0.1:${UDP_GCS} bridge_udp=127.0.0.1:${UDP_BRIDGE} model=${PX4_SIM_MODEL}"

cd "${PX4_PREFIX}"
exec "${PX4_PREFIX}/bin/px4" -i "${INSTANCE}" -d
