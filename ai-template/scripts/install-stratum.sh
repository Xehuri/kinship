#!/usr/bin/env bash
set -euo pipefail

AI_ROOT="${1:-}"
VERSION="${STRATUM_VERSION:-v0.1.3}"
PYTHON="${PYTHON:-python3}"

if [ -z "$AI_ROOT" ]; then
  printf 'usage: %s <AI_ROOT> [STRATUM_VERSION]\n' "$0" >&2
  exit 2
fi
if [ ! -d "$AI_ROOT" ]; then
  printf 'AI root does not exist: %s\n' "$AI_ROOT" >&2
  exit 2
fi

"$PYTHON" - <<'PY'
import sys
if sys.version_info < (3, 11):
    raise SystemExit("Stratum requires Python 3.11 or newer")
PY

"$PYTHON" -m pip install --user "git+https://github.com/Xehuri/stratum.git@${VERSION}"

if command -v stratum >/dev/null 2>&1; then
  stratum --version
  stratum init --root "$AI_ROOT" --name "${STRATUM_WORKSPACE_NAME:-personal}"
  stratum status
else
  printf 'stratum installed but not on PATH; using %s -m stratum\n' "$PYTHON"
  "$PYTHON" -m stratum --version
  "$PYTHON" -m stratum init --root "$AI_ROOT" --name "${STRATUM_WORKSPACE_NAME:-personal}"
  "$PYTHON" -m stratum status
fi
