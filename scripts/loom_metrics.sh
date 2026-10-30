#!/usr/bin/env bash
# Loom metrics snapshot + alert thresholds. Exit 0 healthy, 1 alert, 2 collection error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$ROOT/loom-harness"
LOOM_PID="$(systemctl show axeuh-loom -p MainPID --value)"
SINCE="$(systemctl show axeuh-loom -p ActiveEnterTimestamp --value)"
[[ -z "$SINCE" || "$SINCE" == "n/a" ]] && SINCE="today"

HEALTH="$(cd "$HARNESS" && ./scripts/loomctl.sh health 2>/dev/null || true)"
[[ -n "$HEALTH" ]] || { echo "FAIL: cannot read Loom health"; exit 2; }
BACKEND="$(curl -sk -m 3 https://127.0.0.1:8768/health 2>/dev/null || true)"
[[ -n "$BACKEND" ]] || { echo "FAIL: cannot read backend health"; exit 2; }

LOOM_STATUS="$(echo "$HEALTH" | jq -r '.status // "unknown"')"
LOOM_VERSION="$(echo "$HEALTH" | jq -r '.version // "unknown"')"
BACKEND_STATUS="$(echo "$BACKEND" | jq -r '.status // "unknown"')"
BACKEND_LOOM="$(echo "$BACKEND" | jq -r '.loom.status // "unknown"')"
RSS_KB="$(awk '/VmRSS/ {print $2; exit}' "/proc/$LOOM_PID/status" 2>/dev/null || echo 0)"
RESTARTS="$(systemctl show axeuh-loom -p NRestarts --value 2>/dev/null || echo 0)"
SESSION_BYTES="$(du -sb "$ROOT/ai/.loom/session" 2>/dev/null | awk '{print $1}')"
LOOM_BYTES="$(du -sb "$ROOT/ai/.loom" 2>/dev/null | awk '{print $1}')"
DISK_PCT="$(df -P "$ROOT" | awk 'NR==2 {gsub("%","",$5); print $5}')"

JOURNAL="$(journalctl -u axeuh-loom --since "$SINCE" --no-pager 2>/dev/null || true)"
COUNT_400="$(echo "$JOURNAL" | grep -c 'reasoning_content' || true)"
COUNT_MAX="$(echo "$JOURNAL" | grep -c 'MaxListenersExceededWarning' || true)"
COUNT_DEGRADE="$(echo "$JOURNAL" | grep -c 'agents degrade' || true)"
COUNT_RETRY="$(echo "$JOURNAL" | grep -c 'llm-retry' || true)"
COUNT_SSE="$(grep -c 'EventProxy\]\[loom\] 会话发现失败' "$ROOT/backend/logs/backend.log" 2>/dev/null || true)"
COUNT_DELIVERY="$(grep -c '\[LOOM-CLIENT\].*message_preview=【脚本任务】' "$ROOT/backend/logs/backend.log" 2>/dev/null || true)"
OUTPUTS="$(find "$ROOT/ai/data/daily/$(date +%F)" -maxdepth 1 -name '理解-*.md' 2>/dev/null | wc -l)"

ALERTS=0
alert() { echo "ALERT: $*"; ALERTS=$((ALERTS + 1)); }
[[ "$LOOM_STATUS" == "ok" ]] || alert "loom health status=$LOOM_STATUS"
[[ "$BACKEND_STATUS" == "healthy" && "$BACKEND_LOOM" == "online" ]] || alert "backend/loom status=$BACKEND_STATUS/$BACKEND_LOOM"
(( DISK_PCT < 80 )) || alert "disk usage ${DISK_PCT}% >= 80%"
(( SESSION_BYTES < 2147483648 )) || alert "session bytes ${SESSION_BYTES} >= 2GiB"
(( COUNT_400 == 0 )) || alert "reasoning_content errors since start=$COUNT_400"
(( COUNT_MAX == 0 )) || alert "MaxListeners warnings since start=$COUNT_MAX"
(( COUNT_SSE <= 20 )) || alert "loom SSE discovery failures=$COUNT_SSE (>20)"

echo "loom_status=$LOOM_STATUS"
echo "loom_version=$LOOM_VERSION"
echo "loom_pid=$LOOM_PID"
echo "loom_rss_kb=$RSS_KB"
echo "loom_nrestarts=$RESTARTS"
echo "backend_status=$BACKEND_STATUS"
echo "backend_loom=$BACKEND_LOOM"
echo "session_bytes=$SESSION_BYTES"
echo "loom_state_bytes=$LOOM_BYTES"
echo "disk_pct=$DISK_PCT"
echo "reasoning_content_since_start=$COUNT_400"
echo "maxlisteners_since_start=$COUNT_MAX"
echo "agents_degrade_since_start=$COUNT_DEGRADE"
echo "llm_retry_since_start=$COUNT_RETRY"
echo "sse_discovery_failures_log=$COUNT_SSE"
echo "task_delivery_log_lines=$COUNT_DELIVERY"
echo "today_understanding_files=$OUTPUTS"
echo "p90_latency_ms=not_instrumented"

exit $(( ALERTS > 0 ? 1 : 0 ))
