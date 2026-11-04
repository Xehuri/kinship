#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: import-legacy-index.sh <AI_ROOT> [--index PATH] [--workspace NAME] [--dry-run]

Imports the deprecated data/index JSONL once through `stratum migrate-legacy`.
<AI_ROOT> must already be an initialized Stratum workspace.
EOF
}

AI_ROOT=""
INDEX=""
WORKSPACE=""
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --index)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      INDEX="$2"
      shift 2
      ;;
    --workspace)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      WORKSPACE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      usage
      exit 2
      ;;
    *)
      if [ -n "$AI_ROOT" ]; then
        usage
        exit 2
      fi
      AI_ROOT="$1"
      shift
      ;;
  esac
done

if [ -z "$AI_ROOT" ]; then
  usage
  exit 2
fi
if [ ! -d "$AI_ROOT" ]; then
  printf 'AI root does not exist: %s\n' "$AI_ROOT" >&2
  exit 2
fi

AI_ROOT=$(cd "$AI_ROOT" && pwd)
INDEX="${INDEX:-$AI_ROOT/data/index}"
if [ ! -d "$INDEX" ]; then
  printf 'legacy index directory does not exist: %s\n' "$INDEX" >&2
  exit 2
fi
INDEX=$(cd "$INDEX" && pwd)

if command -v stratum >/dev/null 2>&1; then
  CMD=(stratum)
else
  CMD=(python3 -m stratum)
fi
CMD+=(migrate-legacy --index "$INDEX")
if [ -n "$WORKSPACE" ]; then
  CMD+=(--workspace "$WORKSPACE")
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'Would run:'
  printf ' %q' "${CMD[@]}"
  printf '\n'
  exit 0
fi

cd "$AI_ROOT"
"${CMD[@]}"
