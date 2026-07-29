#!/usr/bin/env bash
# Resolve the IPv4 address to use for vehicle → host MAVLink UDP.
# Sourced by entrypoint-ap.sh / entrypoint-px4.sh (not executed alone).
#
# Compose `extra_hosts: host.docker.internal:host-gateway` often maps to docker0
# (172.17.0.1) even when the container sits on a user-defined bridge (172.18.x).
# Prefer the container default gateway in that case.

resolve_out_host_ip() {
  local requested="${1:-host.docker.internal}"
  local resolved="" gw="" hex b1 b2 b3 b4

  resolved="$(getent ahostsv4 "${requested}" 2>/dev/null | awk '/STREAM/ { print $1; exit }' || true)"

  hex="$(awk '$2 == "00000000" { print $3; exit }' /proc/net/route 2>/dev/null || true)"
  if [[ -n "${hex}" && ${#hex} -eq 8 ]]; then
    b1=$((16#${hex:6:2}))
    b2=$((16#${hex:4:2}))
    b3=$((16#${hex:2:2}))
    b4=$((16#${hex:0:2}))
    gw="$(printf '%d.%d.%d.%d' "${b1}" "${b2}" "${b3}" "${b4}")"
  fi

  if [[ "${requested}" == "host.docker.internal" && -n "${gw}" ]]; then
    if [[ -z "${resolved}" || "${resolved}" != "${gw}" ]]; then
      printf '%s\n' "${gw}"
      return 0
    fi
  fi
  if [[ -n "${resolved}" ]]; then
    printf '%s\n' "${resolved}"
    return 0
  fi
  if [[ -n "${gw}" ]]; then
    printf '%s\n' "${gw}"
    return 0
  fi
  printf '\n'
  return 0
}
