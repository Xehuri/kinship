#!/usr/bin/env bash
# loomctl.sh —— Loom 全 REST 面薄 CLI（docs/06 §5 路由面的命令行投影，源码真源 packages/server/src）。
#
# 定位：人/脚本对 loom serve（默认 127.0.0.1:5100）的通用把手；无业务断言（断言归 loom-probe.sh / loom-fleet.sh）。
# 兼容说明：scripts/loom-run.sh 保持原样继续可用（submit/status/wait/report/chat 语义不变）；
#   loomctl.sh 是其超集——runs 子命令即 loom-run.sh 对应面的直替，另补 sessions/trace/ledger/ops 全域。
#   旧调用方无需迁移；新代码建议直接用 loomctl.sh。
#
# 纪律（照抄 loom-probe.sh / loom-run.sh 头文件姿势）：
#   token 只经 0600 临时头文件进 curl `X-Loom-Token` 请求头，绝不进 argv/ps/stdout/报告；
#   本脚本不重启/kill 任何服务、不写任何配置；失败如实回显状态码并退出。
#
# 凭据：source /etc/kinship-loom/credentials.conf（LOOM_TOKEN 服务令牌 / LOOM_STATE state 根，均可被
#   LOOMCTL_CRED / LOOM_BASE 环境变量覆盖；LOOMCTL_CRED 仅供测试钩子）。
#
# 用法总览（各命令细节 loomctl.sh help）：
#   health | config | config-audit | catalog | pause
#   sessions list|create|status <sid>|history <sid> [limit] [before]|send <sid> <文本|->|
#            voice <sid> <文本|->|abort <sid>|stream <sid> [秒]
#   runs list [workflow]|submit <workflow> <prompt文件|-> [agent] [runid]|status <runid>|
#        wait <runid> [timeout=600]|cancel <runid> [reason]|rerun <runid> <prompt文件|-> [agent]
#   trace [日期] | trace-run <runid> | trace-session <sid> [日期]
#   ledger [日期] | ledger-gaps [日期]
#   api <METHOD> <PATH> [json]        # 逃生舱：任何未封装端点
set -u -o pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRED_FILE="${LOOMCTL_CRED:-/etc/kinship-loom/credentials.conf}"
BASE="${LOOM_BASE:-http://127.0.0.1:5100}"
REST_TIMEOUT=20
POLL_SEC=5

die() { echo "loomctl: $*" >&2; exit 9; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-64}"
}

command -v jq >/dev/null 2>&1 || die "环境缺 jq（runs/sessions JSON 解析依赖）"
[[ -r "$CRED_FILE" ]] || die "凭据文件不可读: $CRED_FILE（未部署？LOOMCTL_CRED 可覆盖）"
# shellcheck disable=SC1090
source "$CRED_FILE" 2>/dev/null || true
[[ -n "${LOOM_TOKEN:-}" ]] || die "LOOM_TOKEN 为空（未部署）"
STATE_ROOT="${LOOM_STATE:-$HARNESS/state}"
[[ "$STATE_ROOT" = /* ]] || STATE_ROOT="$HARNESS/$STATE_ROOT"

WORK="$(mktemp -d /tmp/loomctl.XXXXXX)" || die "mktemp 失败"
trap 'rm -rf "$WORK"' EXIT
# token 只落 0600 临时文件供 curl -H @file 读取（不进 argv/ps/stdout）
umask 077
printf 'X-Loom-Token: %s' "$LOOM_TOKEN" > "$WORK/hdr"
unset LOOM_TOKEN

# api <METHOD> <PATH> [json-data]；stdout=HTTP 状态码，响应体在 $WORK/body
api() {
  local m="$1" p="$2" d="${3:-}"
  local args=(-sS -o "$WORK/body" -w '%{http_code}' -m "$REST_TIMEOUT" -H "@$WORK/hdr" -X "$m")
  [[ -n "$d" ]] && args+=(-H 'Content-Type: application/json' --data "$d")
  curl "${args[@]}" "$BASE$p" 2>"$WORK/curl.err" || true
}

# 通用输出：非 2xx 时 body 打到 stderr 并返回失败码（不落密钥，只落响应，与 loom-run.sh 姿势一致）
show_or_die() { # $1 期望状态前缀（如 2） $2 动作名
  local ok="$1" what="$2"
  if [[ "$ST" != "$ok"* ]]; then
    echo "loomctl: $what 失败 st=${ST:-000}" >&2
    head -c 400 "$WORK/body" >&2 2>/dev/null; echo >&2
    exit 8
  fi
  jq . "$WORK/body" 2>/dev/null || cat "$WORK/body"
}

# 读取文本参数：`-`=stdin；存在的文件路径=文件内容；其余按字面文本处理
read_text_arg() { # $1 值 $2 用途说明
  local v="$1"
  if [[ "$v" == "-" ]]; then cat
  elif [[ -r "$v" && ! -d "$v" ]]; then cat "$v"
  else printf '%s' "$v"
  fi
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  # ── 运维域（只读四件套） ────────────────────────────────────────────
  health)        ST="$(api GET /health)";        show_or_die 2 health ;;
  config)        ST="$(api GET /config)";        show_or_die 2 config ;;
  config-audit)  ST="$(api GET /config/audit)";  show_or_die 2 config-audit ;;
  catalog)       ST="$(api GET /catalog/models)"; show_or_die 2 catalog ;;
  pause)         ST="$(api GET /pause)";         show_or_die 2 pause ;;

  # ── 会话域（docs/06 §5 会话表 + 事件流） ───────────────────────────
  sessions)
    sub="${1:-}"; shift || true
    case "$sub" in
      list)
        ST="$(api GET /sessions)"; show_or_die 2 sessions-list ;;
      create)
        ST="$(api POST /sessions)"; show_or_die 2 sessions-create ;;
      status)
        sid="${1:-}"; [[ -n "$sid" ]] || die "用法: sessions status <sid>"
        ST="$(api GET "/sessions/$sid/status")"; show_or_die 2 sessions-status ;;
      history)
        sid="${1:-}"; [[ -n "$sid" ]] || die "用法: sessions history <sid> [limit] [before-cursor]"
        lim="${2:-}"; before="${3:-}"
        q=""
        [[ -n "$lim" ]] && q="limit=$lim"
        [[ -n "$before" ]] && q="${q:+$q&}before=$before"
        ST="$(api GET "/sessions/$sid/history${q:+?$q}")"; show_or_die 2 sessions-history ;;
      send)
        sid="${1:-}"; text="${2:-}"; [[ -n "$sid" && -n "$text" ]] || die "用法: sessions send <sid> <文本|->"
        body="$(jq -n --arg t "$(read_text_arg "$text" "文本")" '{text:$t}')"
        ST="$(api POST "/sessions/$sid/messages" "$body")"; show_or_die 2 sessions-send ;;
      voice)
        sid="${1:-}"; text="${2:-}"; [[ -n "$sid" && -n "$text" ]] || die "用法: sessions voice <sid> <文本|->"
        body="$(jq -n --arg t "$(read_text_arg "$text" "文本")" '{text:$t}')"
        ST="$(api POST "/sessions/$sid/voice" "$body")"; show_or_die 2 sessions-voice ;;
      abort)
        sid="${1:-}"; [[ -n "$sid" ]] || die "用法: sessions abort <sid>"
        ST="$(api POST "/sessions/$sid/abort")"; show_or_die 2 sessions-abort ;;
      stream)
        # SSE 收流 N 秒原样打印（帧只有 data: 行；断言归 fleet/probe）
        sid="${1:-}"; secs="${2:-25}"; [[ -n "$sid" ]] || die "用法: sessions stream <sid> [秒=25]"
        curl -sS -N -m "$secs" -H "@$WORK/hdr" "$BASE/events/stream?sessionId=$sid" || true
        ;;
      *) die "未知 sessions 子命令: ${sub:-<空>}（list|create|status|history|send|voice|abort|stream）" ;;
    esac ;;

  # ── 任务域（docs/06 §5 任务表；runs.submit/status/wait 与 loom-run.sh 同名命令语义兼容） ──
  runs)
    sub="${1:-}"; shift || true
    case "$sub" in
      list)
        wf="${1:-}"
        ST="$(api GET "/runs${wf:+?workflow=$wf}")"; show_or_die 2 runs-list ;;
      submit)
        workflow="${1:-}"; prompt_src="${2:--}"; agent="${3:-}"; runid="${4:-}"
        [[ -n "$workflow" ]] || die "用法: runs submit <workflow> <prompt文件|-> [agent] [runid]"
        prompt="$(read_text_arg "$prompt_src" "prompt")"
        [[ -n "${prompt// /}" ]] || die "prompt 为空"
        body="$(jq -n --arg w "$workflow" --arg p "$prompt" --arg a "$agent" --arg r "$runid" \
          '{workflow:$w, prompt:$p, actor:"script", trigger:"manual"}
           + (if $a != "" then {agent:$a} else {} end)
           + (if $r != "" then {runId:$r} else {} end)')"
        ST="$(api POST /runs "$body")"
        [[ "$ST" == "202" ]] || { echo "loomctl: 提交失败 st=${ST:-000}" >&2; head -c 400 "$WORK/body" >&2; exit 8; }
        jq -r '.run_id' "$WORK/body" ;;
      status)
        run="${1:-}"; [[ -n "$run" ]] || die "用法: runs status <run_id>"
        ST="$(api GET "/runs/$run")"; show_or_die 2 runs-status ;;
      wait)
        run="${1:-}"; timeout="${2:-600}"; [[ -n "$run" ]] || die "用法: runs wait <run_id> [timeout=600]"
        deadline=$(( $(date +%s) + timeout ))
        while true; do
          ST="$(api GET "/runs/$run")"
          if [[ "$ST" == "200" ]]; then
            state="$(jq -r '.status // "?"' "$WORK/body" 2>/dev/null)"
            case "$state" in
              done)    echo "done" >&2; exit 0 ;;
              partial) echo "partial" >&2; exit 1 ;;
              failed)  echo "failed" >&2; exit 2 ;;
              *) echo "[$(date +%H:%M:%S)] $run -> $state" >&2 ;;
            esac
          else
            echo "[$(date +%H:%M:%S)] 查询失败 st=${ST:-000}" >&2
          fi
          (( $(date +%s) >= deadline )) && { echo "超时 ${timeout}s 未到终态" >&2; exit 3; }
          sleep "$POLL_SEC"
        done ;;
      cancel)
        run="${1:-}"; [[ -n "$run" ]] || die "用法: runs cancel <run_id> [reason]"
        reason="${2:-cancel requested by loomctl}"
        body="$(jq -n --arg r "$reason" '{actor:"script", reason:$r}')"
        ST="$(api POST "/runs/$run/cancel" "$body")"; show_or_die 2 runs-cancel ;;
      rerun)
        run="${1:-}"; prompt_src="${2:--}"; agent="${3:-}"
        [[ -n "$run" ]] || die "用法: runs rerun <run_id> <prompt文件|-> [agent]"
        prompt="$(read_text_arg "$prompt_src" "prompt")"
        [[ -n "${prompt// /}" ]] || die "prompt 为空"
        body="$(jq -n --arg p "$prompt" --arg a "$agent" \
          '{prompt:$p, actor:"script", trigger:"manual"} + (if $a != "" then {agent:$a} else {} end)')"
        ST="$(api POST "/runs/$run/rerun" "$body")"
        [[ "$ST" == "202" ]] || { echo "loomctl: rerun 失败 st=${ST:-000}" >&2; head -c 400 "$WORK/body" >&2; exit 8; }
        jq . "$WORK/body" ;;
      *) die "未知 runs 子命令: ${sub:-<空>}（list|submit|status|wait|cancel|rerun）" ;;
    esac ;;

  # ── L0 直读（docs/06 §8：trace/ledger 文件即真源，loom 不开聚合端点） ──
  trace)
    day="${1:-$(date +%F)}"
    f="$STATE_ROOT/trace/$day.jsonl"
    [[ -r "$f" ]] || die "trace 文件不可读: $f"
    cat "$f" ;;
  trace-run)
    run="${1:-}"; [[ -n "$run" ]] || die "用法: trace-run <run_id> [日期]"
    day="${2:-$(date +%F)}"
    f="$STATE_ROOT/trace/$day.jsonl"
    [[ -r "$f" ]] || die "trace 文件不可读: $f"
    grep -F "\"runId\":\"$run\"" "$f" || true ;;
  trace-session)
    sid="${1:-}"; [[ -n "$sid" ]] || die "用法: trace-session <sid> [日期]"
    day="${2:-$(date +%F)}"
    f="$STATE_ROOT/trace/$day.jsonl"
    [[ -r "$f" ]] || die "trace 文件不可读: $f"
    grep -F "\"sessionId\":\"$sid\"" "$f" || true ;;
  ledger)
    day="${1:-$(date +%F)}"
    f="$STATE_ROOT/ledger/$day.jsonl"
    [[ -r "$f" ]] || die "ledger 文件不可读: $f"
    cat "$f" ;;
  ledger-gaps)
    # 缺口 = 有 expected 无 actual 的 runId（D15 对账原料）；扫指定日（缺省：今日+服务启动日两文件并集）
    day="${1:-}"
    days=()
    up_start=""
    today="$(date +%F)"
    ST="$(api GET /health)"
    [[ "$ST" == "200" ]] && up_start="$(jq -r '.startedAt // empty' "$WORK/body" 2>/dev/null)"
    if [[ -n "$day" ]]; then days=("$day"); else
      days=("$today")
      if [[ -n "$up_start" ]]; then
        boot_day="$(date -d "$up_start" +%F 2>/dev/null || echo "")"
        [[ -n "$boot_day" && "$boot_day" != "$today" ]] && days+=("$boot_day")
      fi
    fi
    seen_exp=""; seen_act=""
    for d in "${days[@]}"; do
      [[ -n "$d" ]] || continue
      f="$STATE_ROOT/ledger/$d.jsonl"
      [[ -r "$f" ]] || continue
      while IFS=$'\t' read -r t rid; do
        case "$t" in
          expected) seen_exp+="$rid"$'\n' ;;
          actual)   seen_act+="$rid"$'\n' ;;
        esac
      done < <(jq -r '[.t, .runId] | @tsv' "$f" 2>/dev/null)
    done
    comm -23 <(printf '%s' "$seen_exp" | sort -u | sed '/^$/d') \
             <(printf '%s' "$seen_act" | sort -u | sed '/^$/d') ;;

  api)
    m="${1:-}"; p="${2:-}"; d="${3:-}"
    [[ -n "$m" && -n "$p" ]] || die "用法: api <METHOD> <PATH> [json]"
    ST="$(api "$m" "$p" "$d")"
    echo "st=$ST" >&2
    cat "$WORK/body" ;;

  help|-h|--help) usage 0 ;;
  *) die "未知命令: $cmd（loomctl.sh help 看用法）" ;;
esac
