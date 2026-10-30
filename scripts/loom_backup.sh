#!/usr/bin/env bash
# Loom state backup: gzip ai/.loom, verify archive, restore to a temp dir, retain 7.
# Reads the source only; never deletes sessions or config. --dry-run checks space.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/ai/.loom"
DEST="$ROOT/../backups/loom"
KEEP=7
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

[[ -d "$SRC" ]] || { echo "FAIL: source missing $SRC" >&2; exit 1; }
SRC_KB="$(du -sk "$SRC" | awk '{print $1}')"
mkdir -p "$DEST"
FREE_KB="$(df -Pk "$DEST" | awk 'NR==2 {print $4}')"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN source=$SRC source_kb=$SRC_KB dest=$DEST free_kb=$FREE_KB"
  exit 0
fi

if (( FREE_KB < SRC_KB * 2 )); then
  echo "FAIL: insufficient free space (source_kb=$SRC_KB free_kb=$FREE_KB)" >&2
  exit 2
fi

umask 077
chmod 700 "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$DEST/loom-$STAMP.tar.gz"

tar -czf "$ARCHIVE" -C "$ROOT/ai" .loom
chmod 600 "$ARCHIVE"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
chmod 600 "$ARCHIVE.sha256"

TMP="$(mktemp -d /tmp/loom-restore.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP"

ARCHIVE_FILES="$(tar -tzf "$ARCHIVE" | grep -cE '^\.loom/session/.*[^/]$')"
DST_FILES="$(find "$TMP/.loom/session" -type f 2>/dev/null | wc -l)"
if [[ "$ARCHIVE_FILES" != "$DST_FILES" ]]; then
  echo "FAIL: restore file count mismatch archive=$ARCHIVE_FILES dst=$DST_FILES" >&2
  exit 3
fi
cmp -s "$SRC/config.yaml" "$TMP/.loom/config.yaml" || {
  echo "FAIL: restored config.yaml differs from source" >&2
  exit 4
}

ls -1t "$DEST"/loom-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" "$old.sha256"
done

ARCHIVE_BYTES="$(stat -c '%s' "$ARCHIVE")"
echo "OK archive=$ARCHIVE bytes=$ARCHIVE_BYTES session_files=$ARCHIVE_FILES retention=$KEEP"
