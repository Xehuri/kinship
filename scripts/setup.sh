#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PYTHON=${PYTHON:-python3}
CHECK=0

usage() {
  cat <<'USAGE'
Usage: scripts/setup.sh [--check] [--python PATH]

Create the local Python environment and initialize config.yaml and ai/ when absent.
Existing config.yaml, ai/, and .venv are never overwritten.
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

fail() { printf 'setup: %s\n' "$*" >&2; exit 4; }

command -v "$PYTHON" >/dev/null 2>&1 || fail "Python not found: $PYTHON"
"$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || fail "Python 3.10+ is required: $PYTHON"

if [ "$CHECK" -eq 1 ]; then
  [ -f "$ROOT/backend/requirements.txt" ] || fail "missing backend/requirements.txt"
  [ -f "$ROOT/config.example.yaml" ] || fail "missing config.example.yaml"
  [ -d "$ROOT/ai-template" ] || fail "missing ai-template/"
  printf 'setup check: ok\n'
  exit 0
fi

if [ ! -x "$ROOT/.venv/bin/python" ]; then
  "$PYTHON" -m venv "$ROOT/.venv"
fi

"$ROOT/.venv/bin/python" -m pip install --upgrade pip
"$ROOT/.venv/bin/python" -m pip install -r "$ROOT/backend/requirements.txt"

if [ ! -f "$ROOT/config.yaml" ]; then
  cp "$ROOT/config.example.yaml" "$ROOT/config.yaml"
  chmod 600 "$ROOT/config.yaml"
  printf 'created config.yaml from config.example.yaml\n'
else
  printf 'kept existing config.yaml\n'
fi

if [ ! -d "$ROOT/ai" ]; then
  cp -a "$ROOT/ai-template" "$ROOT/ai"
  printf 'created ai/ from ai-template/\n'
else
  printf 'kept existing ai/\n'
fi

[ -f "$ROOT/frontend/mobile/dist/index.html" ] || printf 'warning: frontend dist is missing; onboarding or a manual build is required\n'
[ -d "$ROOT/kernel" ] || printf 'warning: audio kernel is not installed; audio features remain unavailable\n'
[ -d "$ROOT/loom-harness/packages/server/dist" ] || printf 'warning: Loom dist is missing; run the documented Loom setup before expecting assistant responses\n'

printf 'setup: complete\n'
printf 'start: %s/scripts/start.sh\n' "$ROOT"
