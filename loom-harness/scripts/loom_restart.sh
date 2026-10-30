#!/usr/bin/env bash
# Loom restart runbook: SIGTERM, assert MainPID changed, fall back to SIGKILL.
# Busy sessions abort the restart. --dry-run prints the current PID only.
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="axeuh-loom"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

OLD="$(systemctl show "$UNIT" -p MainPID --value)"
if [[ ! "$OLD" =~ ^[1-9][0-9]*$ ]]; then
  echo "FAIL: $UNIT has no usable MainPID (got '$OLD')" >&2
  exit 1
fi
if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN unit=$UNIT old_pid=$OLD"
  exit 0
fi

is_new_pid() {
  [[ "$1" =~ ^[1-9][0-9]*$ && "$1" != "$OLD" ]]
}

BUSY=""
for _ in $(seq 1 30); do
  if LIST="$(cd "$HARNESS" && ./scripts/loomctl.sh sessions list 2>/dev/null)"; then
    BUSY="$(echo "$LIST" | jq '[.sessions[] | select(.status=="busy")] | length')"
    break
  fi
  sleep 1
done
if [[ -z "$BUSY" ]]; then
  echo "FAIL: Loom not ready for busy check" >&2
  exit 3
fi
if [[ "$BUSY" != "0" ]]; then
  echo "ABORT: busy sessions=$BUSY" >&2
  exit 3
fi

kill -TERM "$OLD" 2>/dev/null || true
NEW="$OLD"
for _ in $(seq 1 8); do
  sleep 1
  NEW="$(systemctl show "$UNIT" -p MainPID --value)"
  if is_new_pid "$NEW"; then
    break
  fi
done

if ! is_new_pid "$NEW"; then
  echo "SIGTERM did not replace PID; sending SIGKILL to $OLD" >&2
  kill -KILL "$OLD" 2>/dev/null || true
  for _ in $(seq 1 10); do
    sleep 1
    NEW="$(systemctl show "$UNIT" -p MainPID --value)"
    if is_new_pid "$NEW"; then
      break
    fi
  done
fi

if ! is_new_pid "$NEW"; then
  echo "FAIL: no new MainPID (old=$OLD, got '$NEW')" >&2
  exit 2
fi

for _ in $(seq 1 60); do
  if HEALTH="$(cd "$HARNESS" && ./scripts/loomctl.sh health 2>/dev/null)" && \
     echo "$HEALTH" | jq -e '.status=="ok"' >/dev/null 2>&1; then
    VERSION="$(echo "$HEALTH" | jq -r '.version')"
    echo "OK old_pid=$OLD new_pid=$NEW version=$VERSION"
    exit 0
  fi
  sleep 1
done

echo "FAIL: health not ok (new_pid=$NEW)" >&2
exit 4
