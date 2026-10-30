#!/usr/bin/env bash
# loom-run.sh —— Loom 并行任务 CLI：小贺（或人）把手头任务外包给 loom 的把手。
# 用法:
#   loom-run.sh submit <workflow> <prompt-file|-> [agent]   # 派发副会话任务，stdout 只回 run_id（可命令替换）
#   loom-run.sh status <run_id>                              # run 详情 JSON（含账本 expected/actual join）
#   loom-run.sh wait <run_id> [timeout=600]                  # 轮询到终态；exit: 0=done 1=partial 2=failed 3=超时
#   loom-run.sh report <run_id>                              # 评估三件套：detail + trace span 阶段行 + 账本缺口
#   loom-run.sh chat <文本>                                  # 一次性主会话问话（SSE 收流，纯大脑活不依赖工具）
# 纪律：token 只经临时头文件进请求头，不进 argv/ps/stdout；本脚本不重启/kill 任何服务。
set -u -o pipefail

BASE="${LOOM_BASE:-http://127.0.0.1:5100}"
CRED_FILE="/etc/kinship-loom/credentials.conf"
HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLL_SEC=5

die() { echo "loom-run: $*" >&2; exit 9; }

[[ -r "$CRED_FILE" ]] || die "凭据文件不可读: $CRED_FILE（未部署？）"
# shellcheck disable=SC1090
source "$CRED_FILE" 2>/dev/null || true
[[ -n "${LOOM_TOKEN:-}" ]] || die "LOOM_TOKEN 为空（未部署）"
STATE_ROOT="${LOOM_STATE:-$HARNESS/state}"
[[ "${STATE_ROOT:-}" != /* && -n "${LOOM_STATE:-}" ]] && STATE_ROOT="$HARNESS/$LOOM_STATE"
command -v jq >/dev/null || die "缺少 jq"

WORK="$(mktemp -d /tmp/loom-run.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
umask 077
printf 'X-Loom-Token: %s' "$LOOM_TOKEN" > "$WORK/hdr"

# api <METHOD> <PATH> [json-data]；状态码打印到 stdout，响应体在 $WORK/body
api() {
  local m="$1" p="$2" d="${3:-}"
  local args=(-sS -o "$WORK/body" -w '%{http_code}' -m 20 -H "@$WORK/hdr" -X "$m")
  [[ -n "$d" ]] && args+=( -H 'Content-Type: application/json' --data "$d" )
  curl "${args[@]}" "$BASE$p" 2>"$WORK/curl.err" || true
}

cmd="${1:-}"; shift || true
case "$cmd" in
  submit)
    workflow="${1:-}"; prompt_src="${2:--}"; agent="${3:-}"
    [[ -n "$workflow" ]] || die "用法: submit <workflow> <prompt-file|-> [agent]"
    if [[ "$prompt_src" == "-" ]]; then prompt="$(cat)"; else [[ -r "$prompt_src" ]] || die "prompt 文件不可读: $prompt_src"; prompt="$(cat "$prompt_src")"; fi
    [[ -n "${prompt// /}" ]] || die "prompt 为空"
    body="$(jq -n --arg w "$workflow" --arg p "$prompt" --arg a "$agent" \
      '{workflow:$w, prompt:$p, actor:"script", trigger:"manual"} + (if $a != "" then {agent:$a} else {} end)')"
    st="$(api POST /runs "$body")"
    [[ "$st" == "202" ]] || { echo "提交失败 st=$st body:" >&2; head -c 400 "$WORK/body" >&2; exit 8; }
    jq -r '.run_id' "$WORK/body"
    ;;
  status)
    run="${1:-}"; [[ -n "$run" ]] || die "用法: status <run_id>"
    st="$(api GET "/runs/$run")"
    [[ "$st" == "200" ]] || { echo "status 失败 st=$st" >&2; exit 8; }
    jq -c '{run_id,status,session_id,attempt,trigger,expected_at:.ledger.expected_at,actual:.ledger.actual}' "$WORK/body" 2>/dev/null || cat "$WORK/body"
    ;;
  wait)
    run="${1:-}"; timeout="${2:-600}"; [[ -n "$run" ]] || die "用法: wait <run_id> [timeout]"
    deadline=$(( $(date +%s) + timeout ))
    while true; do
      st="$(api GET "/runs/$run")"
      if [[ "$st" == "200" ]]; then
        state="$(jq -r '.status // .state // "?"' "$WORK/body" 2>/dev/null)"
        case "$state" in
          done)    echo "done" >&2; exit 0 ;;
          partial) echo "partial" >&2; exit 1 ;;
          failed)  echo "failed" >&2; exit 2 ;;
          *) echo "[$(date +%H:%M:%S)] $run -> $state" >&2 ;;
        esac
      else
        echo "[$(date +%H:%M:%S)] 查询失败 st=$st" >&2
      fi
      (( $(date +%s) >= deadline )) && { echo "超时 ${timeout}s 未到终态" >&2; exit 3; }
      sleep "$POLL_SEC"
    done
    ;;
  report)
    run="${1:-}"; [[ -n "$run" ]] || die "用法: report <run_id>"
    st="$(api GET "/runs/$run")"
    [[ "$st" == "200" ]] || die "report 失败 st=$st"
    echo "=== run detail ==="
    jq . "$WORK/body"
    sid="$(jq -r '.session_id // ""' "$WORK/body")"
    trace="$STATE_ROOT/trace/$(date +%F).jsonl"
    if [[ -n "$sid" && -r "$trace" ]]; then
      echo "=== trace stages (session $sid) ==="
      grep -F "\"sessionId\":\"$sid\"" "$trace" | jq -r '[.stage, .kind] | @tsv' 2>/dev/null | sort | uniq -c
    fi
    ledger="$STATE_ROOT/ledger/$(date +%F).jsonl"
    if [[ -r "$ledger" ]]; then
      echo "=== ledger rows (run $run) ==="
      grep -F "\"runId\":\"$run\"" "$ledger" | jq -c '{t,status,at}' 2>/dev/null
    fi
    ;;
  chat)
    text="${1:-}"; [[ -n "$text" ]] || die "用法: chat <文本>"
    chat_timeout="${LOOM_CHAT_TIMEOUT:-90}"
    st="$(api POST /sessions)"; [[ "$st" == "201" || "$st" == "200" ]] || die "建会话失败 st=$st"
    sid="$(jq -r '.sessionID // .session_id // ""' "$WORK/body")"
    [[ -n "$sid" ]] || die "响应无 sessionID"
    curl -sS -N -m "$chat_timeout" -H "@$WORK/hdr" "$BASE/events/stream?sessionId=$sid" > "$WORK/sse" 2>&1 &
    ssepid=$!
    sleep 1
    mbody="$(jq -n --arg t "$text" '{text:$t}')"
    st="$(api POST "/sessions/$sid/messages" "$mbody")"
    [[ "$st" == "202" ]] || { kill "$ssepid" 2>/dev/null; die "消息未受理 st=$st"; }
    wait "$ssepid" 2>/dev/null
    got_idle="$(grep -c '"type":"session.idle"' "$WORK/sse" || true)"
    (( got_idle >= 1 )) || echo "警告: ${chat_timeout}s 内未见 idle，输出为已收到的部分" >&2
    grep '^data:' "$WORK/sse" | sed 's/^data://' | jq -r 'select(.payload.type=="message.part.delta") | (.payload.properties.delta // .payload.properties.text // "")' 2>/dev/null | tr -d '\n'
    echo
    ;;
  *)
    sed -n '2,10p' "$0"
    exit 64
    ;;
esac
