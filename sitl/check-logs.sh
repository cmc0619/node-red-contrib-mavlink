#!/usr/bin/env bash
# Best-effort proof that armed SITL services wrote a flight log.
# Usage:
#   check-logs.sh --logs-root DIR [--expect-armed NAME ...] [--newer-than-marker]
#
# With --newer-than-marker, each service dir must contain a `.arm-marker` file
# (touch it just before arming) and a non-empty .bin/.ulg newer than that marker.
set -euo pipefail

ROOT="sitl/logs"
EXPECT=()
NEWER_MARKER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --logs-root)
      if [[ $# -lt 2 || -z "${2}" ]]; then
        echo "check-logs: --logs-root requires a directory" >&2
        exit 2
      fi
      ROOT="$2"
      shift 2
      ;;
    --expect-armed)
      if [[ $# -lt 2 || -z "${2}" ]]; then
        echo "check-logs: --expect-armed requires a service name" >&2
        exit 2
      fi
      EXPECT+=("$2")
      shift 2
      ;;
    --newer-than-marker)
      NEWER_MARKER=1
      shift
      ;;
    -h|--help)
      echo "Usage: $0 --logs-root DIR [--expect-armed NAME ...] [--newer-than-marker]" >&2
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ${#EXPECT[@]} -eq 0 ]]; then
  echo "check-logs: pass at least one --expect-armed NAME" >&2
  exit 2
fi

fail=0
for name in "${EXPECT[@]}"; do
  if [[ -z "${name}" ]]; then
    echo "check-logs: empty service name" >&2
    fail=1
    continue
  fi
  dir="$ROOT/$name"
  if [[ ! -d "$dir" ]]; then
    echo "check-logs: missing directory $dir" >&2
    fail=1
    continue
  fi

  marker=""
  if [[ "$NEWER_MARKER" -eq 1 ]]; then
    marker="$dir/.arm-marker"
    if [[ ! -f "$marker" ]]; then
      echo "check-logs: missing $marker (touch it immediately before arm)" >&2
      fail=1
      continue
    fi
  fi

  found=""
  while IFS= read -r -d '' f; do
    # Reject empty files — a touch-created placeholder is not a flight log.
    if [[ ! -s "$f" ]]; then
      continue
    fi
    if [[ -n "$marker" && ! "$f" -nt "$marker" ]]; then
      continue
    fi
    found="$f"
    break
  done < <(find "$dir" -type f \( -iname '*.bin' -o -iname '*.ulg' \) -print0 2>/dev/null)

  if [[ -z "$found" ]]; then
    if [[ "$NEWER_MARKER" -eq 1 ]]; then
      echo "check-logs: no non-empty .bin/.ulg newer than $marker under $dir" >&2
    else
      echo "check-logs: no non-empty flight log (.bin/.ulg) under $dir" >&2
    fi
    fail=1
  else
    echo "check-logs: ok $name ($found)"
  fi
done

exit "$fail"
