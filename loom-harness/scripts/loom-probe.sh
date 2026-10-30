#!/usr/bin/env bash
# Loom 日常自检探针（L2 巡检层；手册见 docs/07-调试测试手册.md）。
#
# 定位：生产 opencode 定时任务每天跑本脚本，对 axeuh-loom 影子实例（127.0.0.1:5100）
#   做只读 + 最小副作用巡检（仅建一次性会话 + 发一条只读消息），人不用盯。
# 纪律：token 值绝不回显（只经 -H @文件 进 curl 头，连 argv/ps 都不暴露）；
#   不重启/kill 任何服务；不写 loom 配置；失败项如实上报，脚本自身不修复。
# 六项检查：
#   [1] GET  /health   200 且含 uptimeMs
#   [2] POST /sessions 建会话拿 sessionID（id 必须无连字符：^[a-zA-Z0-9_]+$）
#   [3] SSE  挂 /events/stream?sessionId=（后台收流 25s）+ 发一条只读消息：
#          帧序须含 message.part.delta 与 session.idle；idle 帧带 sessionID；
#          无 `event:` 行；每帧信封 {seq,payload:{type,properties}}
#   [4] trace {state根}/trace/$(date +%F).jsonl 有该会话 span 行且含 assembly 阶段
#   [5] GET  /runs 200（允许空列表）；GET /pause 200
#   [6] GET  /config 脱敏：含 "${" 引用名；除 effectiveVersionSha256 哈希指纹外
#        不得出现 [a-zA-Z0-9_-]{32,} 疑似密钥串（命中只报计数，绝不回显命中内容）
# 凭据：source /etc/kinship-loom/credentials.conf（LOOM_TOKEN 服务令牌 / LOOM_STATE state 根）。
#   文件缺失/不可解析/token 为空 → 六项全 SKIP 报"未部署"，exit 0。
# 退出码：FAIL 项数（0=全绿）；服务不可达=对应项 FAIL 并继续跑完（不中断）。
# 超时：REST 调用 curl -m 8，SSE 收流 -m 25；全程硬上限 <90s。
set -u -o pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRED_FILE="${LOOM_PROBE_CRED:-/etc/kinship-loom/credentials.conf}"
# 默认打生产影子实例；LOOM_PROBE_BASE 仅供测试钩子（L1 离线 fake serve 验 PASS 路径）
BASE="${LOOM_PROBE_BASE:-http://127.0.0.1:5100}"
REST_TIMEOUT=8
SSE_SECONDS=25
PROBE_TEXT='只回一句话然后收束，不要调用任何工具'

command -v jq >/dev/null 2>&1 || { echo "[probe] 环境缺 jq，无法解析 JSON 断言" >&2; exit 9; }

# ── 结果登记（表行 + 计数） ─────────────────────────────────────────────
ROWS=(); NPASS=0; NFAIL=0; NSKIP=0
record() { # $1 编号 $2 名称 $3 状态 $4 详情（详情里绝不允许出现密钥值）
  ROWS+=("$(printf '  [%s] %-14s %-4s  %s' "$1" "$2" "$3" "$4")")
  case "$3" in
    PASS) NPASS=$((NPASS + 1)) ;;
    FAIL) NFAIL=$((NFAIL + 1)) ;;
    SKIP) NSKIP=$((NSKIP + 1)) ;;
  esac
}
finish() {
  echo "Loom 探针 $(date '+%F %T')  target=$BASE"
  printf '%s\n' "${ROWS[@]}"
  echo "汇总: PASS=$NPASS FAIL=$NFAIL SKIP=$NSKIP"
  exit "$NFAIL"
}
skip_all() { # 未部署：整表 SKIP，非故障，exit 0
  local why="$1" n
  for n in 1-health 2-session 3-sse-turn 4-trace 5-lists 6-config-mask; do
    record "x/6" "$n" SKIP "$why"
  done
  finish
}

# ── 凭据装载（source 只进 shell 变量；任何路径都不 cat/echo 文件内容） ──
if [[ ! -r "$CRED_FILE" ]]; then
  skip_all "未部署：credentials 文件不存在或不可读"
fi
# shellcheck disable=SC1090
source "$CRED_FILE" 2>/dev/null || true
if [[ -z "${LOOM_TOKEN:-}" ]]; then
  skip_all "未部署：credentials 缺 LOOM_TOKEN（或文件不可解析）"
fi

STATE_ROOT="${LOOM_STATE:-$HARNESS/state}"
[[ "$STATE_ROOT" = /* ]] || STATE_ROOT="$HARNESS/$STATE_ROOT"
TRACE_FILE="$STATE_ROOT/trace/$(date +%F).jsonl"

WORK="$(mktemp -d /tmp/loom-probe.XXXXXX)" || { echo "[probe] mktemp 失败" >&2; exit 9; }
trap 'rm -rf "$WORK"' EXIT
# token 只落 0600 临时文件供 curl -H @file 读取（不进 argv/ps/stdout）
HDR="$WORK/h"
( umask 077; printf 'X-Loom-Token: %s' "$LOOM_TOKEN" > "$HDR" )
unset LOOM_TOKEN

api() { # $1 METHOD $2 PATH [$3 JSON_BODY] → stdout 状态码；body 文件在 $WORK/body
  local m="$1" p="$2" d="${3:-}"
  local args=(-sS -o "$WORK/body" -w '%{http_code}' -m "$REST_TIMEOUT" -H "@$HDR" -X "$m")
  [[ -n "$d" ]] && args+=(-H 'Content-Type: application/json' --data "$d")
  curl "${args[@]}" "$BASE$p" 2>"$WORK/curl.err" || true
}
body_peek() { head -c 120 "$WORK/body" 2>/dev/null | tr '\n' ' '; }

# ── [1] health ─────────────────────────────────────────────────────────
st="$(api GET /health)"
if [[ "$st" == "200" ]] && grep -q '"uptimeMs"' "$WORK/body" 2>/dev/null; then
  up="$(jq -r '.uptimeMs // empty' "$WORK/body" 2>/dev/null)"
  record 1/6 health PASS "200 uptimeMs=${up:-?}"
else
  record 1/6 health FAIL "st=${st:-000} $(body_peek)"
fi

# ── [2] 建会话（无连字符断言） ─────────────────────────────────────────
st="$(api POST /sessions)"
SID=""
if [[ "$st" == "201" || "$st" == "200" ]]; then
  SID="$(jq -r '.sessionID // empty' "$WORK/body" 2>/dev/null)"
fi
if [[ -n "$SID" && "$SID" =~ ^[a-zA-Z0-9_]+$ ]]; then
  record 2/6 session PASS "sessionID=$SID"
elif [[ -n "$SID" ]]; then
  record 2/6 session FAIL "id 含非法字符（连字符回归？）: $SID"
else
  record 2/6 session FAIL "st=${st:-000} $(body_peek)"
fi

# ── [3] SSE 一轮对话收束 ───────────────────────────────────────────────
if [[ -z "$SID" ]]; then
  record 3/6 sse-turn FAIL "依赖 [2] 无 sessionID，跳过对话"
else
  curl -sS -N -m "$SSE_SECONDS" -H "@$HDR" \
    "$BASE/events/stream?sessionId=$SID" >"$WORK/sse" 2>"$WORK/sse.err" &
  SSE_PID=$!
  sleep 1
  st="$(api POST "/sessions/$SID/messages" "$(jq -cn --arg t "$PROBE_TEXT" '{text:$t}')")"
  reasons=()
  if [[ "$st" == "202" ]]; then
    wait "$SSE_PID" 2>/dev/null || true
  else
    reasons+=("发消息未受理 st=${st:-000} $(body_peek)")
    kill -TERM "$SSE_PID" 2>/dev/null || true
    wait "$SSE_PID" 2>/dev/null || true
  fi
  if [[ ! -s "$WORK/sse" ]]; then
    reasons+=("零帧收到($(head -c 80 "$WORK/sse.err" | tr '\n' ' '))")
  else
    grep -q '^data:' "$WORK/sse" || reasons+=("无 data 帧")
    grep -q '"type":"message.part.delta"' "$WORK/sse" || reasons+=("缺 delta")
    if ! grep '"type":"session.idle"' "$WORK/sse" | grep -q "$SID"; then
      reasons+=("缺 idle 或 idle 未带 sessionID")
    fi
    grep -q '^event:' "$WORK/sse" && reasons+=("出现 event: 行（契约违规）")
    shape_ok=1
    while IFS= read -r line; do
      [[ "$line" == data:* ]] || continue
      jq -e 'has("seq") and (.payload|type=="object") and (.payload|has("type") and has("properties"))' \
        <<< "${line#data:}" >/dev/null 2>&1 || { shape_ok=0; break; }
    done < "$WORK/sse"
    [[ "$shape_ok" == "1" ]] || reasons+=("信封形状不符")
  fi
  if [[ ${#reasons[@]} -eq 0 ]]; then
    record 3/6 sse-turn PASS "frames=$(grep -c '^data:' "$WORK/sse") delta+idle 齐，idle 带 id"
  else
    record 3/6 sse-turn FAIL "$(IFS='; '; echo "${reasons[*]}")"
  fi
fi

# ── [4] trace 断言 ─────────────────────────────────────────────────────
if [[ -z "$SID" ]]; then
  record 4/6 trace FAIL "依赖 [2] 无 sessionID"
elif [[ ! -f "$TRACE_FILE" ]]; then
  record 4/6 trace FAIL "无今日 trace 文件: $TRACE_FILE"
elif ! grep -qF "\"sessionId\":\"$SID\"" "$TRACE_FILE"; then
  record 4/6 trace FAIL "trace 无该会话 span 行"
elif grep -F "\"sessionId\":\"$SID\"" "$TRACE_FILE" | grep -q '"stage":"assembly"'; then
  record 4/6 trace PASS "$(basename "$TRACE_FILE") 含该会话 assembly span"
else
  record 4/6 trace FAIL "该会话 span 缺 assembly 阶段行"
fi

# ── [5] /runs + /pause ────────────────────────────────────────────────
st_r="$(api GET /runs)"
runs_shape=0
jq -e '.runs | type == "array"' "$WORK/body" >/dev/null 2>&1 && runs_shape=1
st_p="$(api GET /pause)"
if [[ "$st_r" == "200" && "$st_p" == "200" && "$runs_shape" == "1" ]]; then
  record 5/6 lists PASS "/runs 200（数组，允许空）、/pause 200"
else
  record 5/6 lists FAIL "/runs=${st_r:-000}(shape=$runs_shape) /pause=${st_p:-000}"
fi

# ── [6] /config 脱敏 ──────────────────────────────────────────────────
st="$(api GET /config)"
if [[ "$st" != "200" ]]; then
  record 6/6 config-mask FAIL "st=${st:-000}"
else
  # effectiveVersionSha256 是设计内的版本哈希（非密钥），先行摘除再扫疑似密钥串；
  # 命中只报计数与长度，绝不回显命中内容。
  stripped="$(sed -E 's/"effectiveVersionSha256":"[0-9a-f]{0,64}"/"effectiveVersionSha256":null/g' "$WORK/body")"
  hits="$(printf '%s' "$stripped" | grep -Eo '[a-zA-Z0-9_-]{32,}' | wc -l)"
  if printf '%s' "$stripped" | grep -q '\${' && [[ "$hits" == "0" ]]; then
    record 6/6 config-mask PASS '含 ${ENV} 引用名，无 32+ 位疑似密钥串'
  elif [[ "$hits" != "0" ]]; then
    record 6/6 config-mask FAIL "疑似密钥串 $hits 处（值已按纪律不回显）→ 报修"
  else
    record 6/6 config-mask FAIL '响应缺 ${...} 引用名（脱敏形状变了）'
  fi
fi

finish
