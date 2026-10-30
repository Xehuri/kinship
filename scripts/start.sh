#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PYTHON=${PYTHON:-"$ROOT/.venv/bin/python"}
CHECK=0

usage() {
  cat <<'USAGE'
Usage: scripts/start.sh [--check] [--python PATH]

Start the Kinship backend in the foreground with `python -m core.hot_server`.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --python) shift; PYTHON=${1:?missing value for --python} ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

fail() { printf 'start: %s\n' "$*" >&2; exit 3; }

[ -x "$PYTHON" ] || fail "Python environment not found: $PYTHON; run scripts/setup.sh first"
[ -f "$ROOT/config.yaml" ] || fail "config.yaml is missing; run scripts/setup.sh first"
[ -d "$ROOT/ai" ] || fail "ai/ is missing; run scripts/setup.sh first"

if [ "$CHECK" -eq 1 ]; then
  printf 'start check: ok\n'
  exit 0
fi

cd "$ROOT/backend"
exec "$PYTHON" -m core.hot_server
