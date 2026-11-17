#!/usr/bin/env bash
# 清理 Playwright 产物目录：删除过期文件，并在总量超限时按 mtime 从旧到新回收。
set -u -o pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AI_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
ROOT="${BROWSER_ARTIFACT_ROOT:-$AI_ROOT/data/browser}"

APPLY=0
DAYS=14
MAX_BYTES=1073741824

usage() {
  cat >&2 <<'EOF'
用法: prune_artifacts.sh [--apply] [--days N] [--max-bytes N]

  --apply          实际删除（默认演练，不删任何文件）
  --days N         删除修改时间超过 N 天的文件（默认 14）
  --max-bytes N    目录总量上限，超出后从最旧文件开始回收（默认 1073741824）

只操作 AI 根 data/browser 目录内，不跟随符号链接。
可用 BROWSER_ARTIFACT_ROOT 覆盖目录（仍需以 /data/browser 结尾）。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      APPLY=1
      shift
      ;;
    --days)
      if [ "$#" -lt 2 ]; then usage; exit 64; fi
      DAYS="$2"
      shift 2
      ;;
    --max-bytes)
      if [ "$#" -lt 2 ]; then usage; exit 64; fi
      MAX_BYTES="$2"
      shift 2
      ;;
    *)
      echo "未知参数: $1" >&2
      usage
      exit 64
      ;;
  esac
done

case "$DAYS" in ''|*[!0-9]*) echo "错误: --days 需要非负整数" >&2; exit 64 ;; esac
case "$MAX_BYTES" in ''|*[!0-9]*) echo "错误: --max-bytes 需要非负整数" >&2; exit 64 ;; esac

if [ ! -d "$ROOT" ]; then
  echo "错误: 产物目录不存在或不是目录: $ROOT" >&2
  exit 65
fi

REAL_ROOT="$(realpath -e "$ROOT" 2>/dev/null)" || REAL_ROOT=""
case "$REAL_ROOT" in
  */data/browser) ;;
  *)
    echo "错误: 目录解析后不以 /data/browser 结尾，拒绝操作: ${REAL_ROOT:-$ROOT}" >&2
    exit 65
    ;;
esac
ROOT="$REAL_ROOT"

if [ "$APPLY" -eq 1 ]; then
  while IFS= read -r -d '' f; do
    rm -f -- "$f"
    echo "已删除(过期): $f"
  done < <(find "$ROOT" -type f -mtime +"$DAYS" -print0)
else
  while IFS= read -r -d '' f; do
    echo "[dry-run] 过期: $f"
  done < <(find "$ROOT" -type f -mtime +"$DAYS" -print0)
fi

total_bytes() {
  find "$ROOT" -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {printf "%d", s+0}'
}

TOTAL="$(total_bytes)"
[ -n "$TOTAL" ] || TOTAL=0
LIST="$(find "$ROOT" -type f -printf '%T@ %s %p\n' 2>/dev/null | sort -n)"

while [ "$TOTAL" -gt "$MAX_BYTES" ] && [ -n "$LIST" ]; do
  FIRST="${LIST%%$'\n'*}"
  REST="${FIRST#* }"
  SIZE="${REST%% *}"
  FILE="${REST#* }"
  case "$SIZE" in ''|*[!0-9]*) break ;; esac
  [ -n "$FILE" ] || break

  if [ "$APPLY" -eq 1 ]; then
    rm -f -- "$FILE"
    echo "已删除(超限): $FILE"
  else
    echo "[dry-run] 超限: $FILE"
  fi
  TOTAL=$((TOTAL - SIZE))

  if [ "$LIST" = "$FIRST" ]; then
    LIST=""
  else
    LIST="${LIST#*$'\n'}"
  fi
done

REMAIN_COUNT="$(find "$ROOT" -type f -printf 'x' 2>/dev/null | wc -c)"
REMAIN_BYTES="$(total_bytes)"
[ -n "$REMAIN_BYTES" ] || REMAIN_BYTES=0

if [ "$APPLY" -eq 1 ]; then
  find "$ROOT" -mindepth 1 -type d -empty -delete 2>/dev/null || true
fi

echo "保留: $((REMAIN_COUNT)) 个文件, ${REMAIN_BYTES} bytes; 上限: ${MAX_BYTES} bytes"
exit 0
