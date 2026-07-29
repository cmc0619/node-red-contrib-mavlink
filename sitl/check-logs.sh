#!/usr/bin/env bash
# Best-effort proof that armed SITL services wrote a flight log.
# Usage: check-logs.sh --logs-root DIR [--expect-armed NAME ...]
set -euo pipefail

ROOT="sitl/logs"
EXPECT=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --logs-root)
      ROOT="$2"
      shift 2
      ;;
    --expect-armed)
      EXPECT+=("$2")
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 --logs-root DIR [--expect-armed NAME ...]" >&2
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
  dir="$ROOT/$name"
  if [[ ! -d "$dir" ]]; then
    echo "check-logs: missing directory $dir" >&2
    fail=1
    continue
  fi
  if ! find "$dir" -type f \( -iname '*.bin' -o -iname '*.ulg' \) 2>/dev/null | grep -q .; then
    echo "check-logs: no flight log (.bin/.ulg) under $dir" >&2
    fail=1
  else
    echo "check-logs: ok $name"
  fi
done

exit "$fail"
