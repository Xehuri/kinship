#!/usr/bin/env bash
# loom-fleet.sh —— Loom 全功能场景化验收 runner（docs/07 探针的超集：探针管"活着没"，fleet 管"好用没"）。
#
# 定位：生产 opencode（小贺）或人 bash 一次，把影子实例 5100 从主会话→副会话→复盘完整测一遍，
#   逐场景 PASS/FAIL/SKIP + 耗时 + 可追 run_id，汇总 markdown 报告写 stdout 并落
#   axeuh-harness/state/fleet/（用户 00:13 新口径：loom 测试产出离产，不塞生产 ai/）。
# 纪律（docs/07 §9 四条同源）：token 只经 0600 临时头文件进请求头、绝不进 argv/ps/stdout/报告；
#   不重启/kill 服务、不改配置；场景串行、间隔 ≥2s；每场景 curl -m 硬超时，全程 <10 分钟。
# 降级姿势（照 loom-probe.sh）：credentials 缺失/不可解析 → 未部署，全场景 SKIP、exit 0；
#   服务不可达（health 非 200）→ S01–S09 全 FAIL 但完整跑完报告流程，不崩。
# 退出码：FAIL 场景数（0=无 FAIL；SKIP 不计，属"在途接线/未部署"如实登记）。
# 契约（给 docs/09 测试方案 worker）：脚本=axeuh-harness/scripts/loom-fleet.sh；
#   报告=axeuh-harness/state/fleet/fleet-YYYY-MM-DD-HHMM.md（离产区；产物形态场景预留 state/fleet/out/）；
#   exit=FAIL 数；
#   薄 CLI=scripts/loomctl.sh（深挖用 loomctl runs status / trace-run / ledger-gaps）。
#
# 场景与断言真源（路由/字段以 packages/server/src 为准，docs/06 漂移点见报告尾注）：
#   S01 主会话真应答      session-api/routes.ts + events/project.ts（delta+idle 带 sid，真 provider）
#   S02 人设/记忆注入     serve/assembly-trace.ts（今日 trace 该会话 assembly span + attrs.injectedLines>0 硬证）
#   S03 上下文延续        session-api/registry.ts（同会话两轮，JsonlSessionStore 记忆）
#   S04 副会话纯脑任务    run-engine/engine.ts + task-api/views.ts（ledger expected_at/actual join）
#   S05 副会话工具任务    boot.ts toolWiring 已挂工具面 → 不写盘姿势：bash echo marker，digest+runId join 断言
#   S06 cancel/rerun      control/plane.ts + engine.ts cancelRequested（detail.cancel_requested 置位）
#   S07 agent 角色声明    serve/side-binding.ts + serve/tool-trace.ts（agents/ 缺文件→SKIP；run 侧 trace assembly span 行已接线）
#   S08 账本缺口对账      adapters/state/ledger.ts（expected∖actual ⊆ 引擎在途集）
#   S09 trace 完整性      core/trace/types.ts SPAN_STAGES（kind∈{span,nudge,run_end}，未知 stage 才 FAIL）
#   S10 复盘小结          本脚本登记表（Top3 耗时 + 全部 run_id/session_id）
set -u -o pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRED_FILE="${LOOM_FLEET_CRED:-/etc/kinship-loom/credentials.conf}"
BASE="${LOOM_BASE:-http://127.0.0.1:5100}"
REST_TIMEOUT=10
SSE_MAX=45                 # 单轮 SSE 收流硬上限（curl -m）；先订阅确认建连再发消息，到 idle 提前收尾
SCENE_GAP=2                # 场景间隔（禁并发轰炸）
OVERALL_LIMIT=540          # 全程硬上限（<10 分钟红线 + 收尾余量）

command -v jq >/dev/null 2>&1 || { echo "[fleet] 环境缺 jq，无法做 JSON 断言" >&2; exit 9; }

T_START=$(date +%s)
ROWS=(); NPASS=0; NFAIL=0; NSKIP=0; RUN_IDS=(); SID_LIST=()
record() { # $1 场景 $2 名称 $3 状态 $4 耗时秒 $5 证据（证据绝不含密钥；竖线转义防表格串列）
  local ev="${5//|/;}"
  ROWS+=("$(printf '| %s | %s | %s | %s | %s |' "$1" "$2" "$3" "$4" "$ev")")
  case "$3" in
    PASS) NPASS=$((NPASS + 1)) ;;
    FAIL) NFAIL=$((NFAIL + 1)) ;;
    SKIP) NSKIP=$((NSKIP + 1)) ;;
  esac
  echo "[$1] $3 ${4}s | $2 | $5" >&2
}
budget_left() { echo $(( OVERALL_LIMIT - ($(date +%s) - T_START) )); }

# ── 凭据装载（姿势照 loom-probe.sh：source 只进 shell 变量，任何路径不 cat/echo 文件内容） ──
DEPLOYED=0; UNREACHABLE=0; BOOT_DAY=""; PROVIDER=""; WS=""; PRE=""
if [[ -r "$CRED_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CRED_FILE" 2>/dev/null || true
  [[ -n "${LOOM_TOKEN:-}" ]] && DEPLOYED=1
fi

STATE_ROOT="${LOOM_STATE:-$HARNESS/state}"
[[ "$STATE_ROOT" = /* ]] || STATE_ROOT="$HARNESS/$STATE_ROOT"
TODAY="$(date +%F)"
TRACE_FILE="$STATE_ROOT/trace/$TODAY.jsonl"
# 离产口径（用户 00:13）：fleet 一切写落 harness state；生产 ai/ 只读
FLEET_OUT_DIR="$STATE_ROOT/fleet"          # 报告区
FLEET_ARTIFACT_DIR="$STATE_ROOT/fleet/out" # 产物形态场景预留区（当前 S05 不写盘，不创建）

WORK="$(mktemp -d /tmp/loom-fleet.XXXXXX)" || { echo "[fleet] mktemp 失败" >&2; exit 9; }
trap 'rm -rf "$WORK"' EXIT
HDR="$WORK/h"
if [[ "$DEPLOYED" == "1" ]]; then
  ( umask 077; printf 'X-Loom-Token: %s' "$LOOM_TOKEN" > "$HDR" )
  unset LOOM_TOKEN
fi

api() { # $1 METHOD $2 PATH [$3 JSON] → stdout 状态码；body 在 $WORK/body
  [[ "$DEPLOYED" == "1" ]] || { echo "000"; return 0; }
  local m="$1" p="$2" d="${3:-}"
  local args=(-sS -o "$WORK/body" -w '%{http_code}' -m "$REST_TIMEOUT" -H "@$HDR" -X "$m")
  [[ -n "$d" ]] && args+=(-H 'Content-Type: application/json' --data "$d")
  curl "${args[@]}" "$BASE$p" 2>"$WORK/curl.err" || true
}
peek() { head -c 100 "$WORK/body" 2>/dev/null | tr '\n' ' '; }
hex16() { head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
ev_cut() { local s="$*"; printf '%s' "${s:0:220}"; }

SSE_PID=""; SSE_OUT=""; SSE_SEQ=0
sse_start() { # $1 sid：开后台收流（-m SSE_MAX），记 $SSE_OUT/$SSE_PID
  SSE_SEQ=$((SSE_SEQ + 1))
   SSE_OUT="$WORK/sse.$SSE_SEQ"
   : > "$SSE_OUT"
   curl -sS -N -m "$SSE_MAX" -H "@$HDR" "$BASE/events/stream?sessionId=$1" >"$SSE_OUT" 2>"$WORK/sse.err" &
   SSE_PID=$!
   # 先订阅后发送：1.5s 确认 curl 建连存活（连接被拒/401 会立刻退出，此时 SSE_ALIVE=0）
   sleep 1.5
   SSE_ALIVE=1
   kill -0 "$SSE_PID" 2>/dev/null || SSE_ALIVE=0
 }
sse_wait_idle() { # $1 sid：轮询到 idle 或 -m 到点；命中 idle 提前 kill（省全程预算）
  local sid="$1"
  until grep -q '"type":"session.idle"' "$SSE_OUT" 2>/dev/null; do
    kill -0 "$SSE_PID" 2>/dev/null || break
    sleep 1
  done
  kill -TERM "$SSE_PID" 2>/dev/null || true
  wait "$SSE_PID" 2>/dev/null || true
  SSE_PID=""
}
SSE_REASONS=()
sse_assert() { # $1 outfile $2 sid → 填全局 SSE_REASONS（真源 docs/07 §4.4 四点硬契约）
  SSE_REASONS=()
  [[ -s "$1" ]] || { SSE_REASONS+=("零帧收到"); return 0; }
  grep -q '^data:' "$1" || SSE_REASONS+=("无 data 帧")
  grep -q '"type":"message.part.delta"' "$1" || SSE_REASONS+=("缺 delta")
  grep '"type":"session.idle"' "$1" | grep -q "$2" || SSE_REASONS+=("缺 idle 或 idle 未带 sessionID")
  grep -q '^event:' "$1" && SSE_REASONS+=("出现 event: 行（契约违规）")
  local shape_ok=1 line
  while IFS= read -r line; do
    [[ "$line" == data:* ]] || continue
    jq -e 'has("seq") and (.payload|type=="object") and (.payload|has("type") and has("properties"))' \
      <<< "${line#data:}" >/dev/null 2>&1 || { shape_ok=0; break; }
  done < "$1"
  [[ "$shape_ok" == "1" ]] || SSE_REASONS+=("信封形状不符")
}
sse_text() { # $1 outfile：拼全部 text 段 delta 为一行（真源 events/project.ts：field=='text' 才进正文）
  grep '^data:' "$1" 2>/dev/null | sed 's/^data://' \
    | jq -r 'select(.payload.type=="message.part.delta") | (.payload.properties | select(.field=="text") | .delta)' 2>/dev/null | tr -d '\n'
}
merge_sse_reasons() { # 把 SSE_REASONS 并入调用方的 reasons（仅非空数组时）
  [[ ${#SSE_REASONS[@]} -gt 0 ]] && reasons+=("${SSE_REASONS[@]}")
  return 0
}

wait_run() { # $1 run_id $2 超时秒 → echo 终态词（done/partial/failed/timeout）
  local run="$1" tmo="$2" st state dl
  dl=$(( $(date +%s) + tmo ))
  while true; do
    st="$(api GET "/runs/$run")"
    if [[ "$st" == "200" ]]; then
      state="$(jq -r '.status // "?"' "$WORK/body" 2>/dev/null)"
      case "$state" in done|partial|failed) echo "$state"; return 0;; esac
    fi
    (( $(date +%s) >= dl )) && { echo "timeout"; return 0; }
    sleep 5
  done
}
LAST_ST=""
submit_run() { # $1 workflow $2 prompt $3 agent $4 runid → echo run_id（失败空串）；LAST_ST=HTTP 状态码
  local body st
  body="$(jq -n --arg w "$1" --arg p "$2" --arg a "$3" --arg r "$4" \
    '{workflow:$w, prompt:$p, actor:"script", trigger:"manual"}
     + (if $a != "" then {agent:$a} else {} end)
     + (if $r != "" then {runId:$r} else {} end)')"
  st="$(api POST /runs "$body")"
  LAST_ST="$st"
  if [[ "$st" == "202" ]]; then jq -r '.run_id' "$WORK/body" 2>/dev/null; else echo ""; fi
}

# scene_gate <场景号> <名称>：未部署→SKIP / 不可达→FAIL / 预算不足→SKIP；返回 1 = 已登记跳过执行
scene_gate() {
  if [[ "$DEPLOYED" == "0" ]]; then
    record "$1" "$2" SKIP "0" "未部署：credentials 缺失/不可解析（照 probe 降级，不计 FAIL）"
    return 1
  fi
  if [[ "$UNREACHABLE" == "1" ]]; then
    record "$1" "$2" FAIL "0" "服务不可达（health=$PRE），全场景如实 FAIL"
    return 1
  fi
  if (( $(budget_left) < 60 )); then
    record "$1" "$2" SKIP "0" "全程预算(${OVERALL_LIMIT}s)剩余不足 60s，未执行（10 分钟红线）"
    return 1
  fi
  return 0
}

# ── 预检：health（可达性+启动日）→ catalog provider（真模型面）→ config workspace（S07 agent 文件核对） ──
if [[ "$DEPLOYED" == "1" ]]; then
  st="$(api GET /health)"
  if [[ "$st" != "200" ]]; then
    UNREACHABLE=1; PRE="${st:-000}"
  else
    BOOT_DAY="$(jq -r '.startedAt // empty' "$WORK/body" 2>/dev/null)"
    st="$(api GET /catalog/models)"
    PROVIDER="$(jq -r '.models[0].provider // "none"' "$WORK/body" 2>/dev/null)"
    st="$(api GET /config)"
    WS="$(jq -r '.workspace // empty' "$WORK/body" 2>/dev/null)"
    PRE="200 provider=$PROVIDER"
  fi
fi

# ── S01 主会话真应答：先订阅后发送+建连确认；短答应答形态有变，miss 重试一次（判据不放宽） ──
t0=$(date +%s)
if scene_gate S01 "主会话真应答"; then
  s01_att=0; s01_why=""
  for att_no in 1 2; do
    s01_att=$att_no; reasons=()
    st="$(api POST /sessions)"; SID1=""
    [[ "$st" == "201" || "$st" == "200" ]] && SID1="$(jq -r '.sessionID // empty' "$WORK/body")"
    [[ -n "$SID1" ]] || { reasons+=("建会话失败 st=${st:-000} $(peek)"); break; }
    SID_LIST+=("S01#$att_no:$SID1")
    [[ "$SID1" =~ ^[a-zA-Z0-9_]+$ ]] || reasons+=("sid 含非法字符（连字符回归？）")
    sse_start "$SID1"
    [[ "$SSE_ALIVE" == "1" ]] || reasons+=("SSE 连接未建立（curl 即退，查 $(head -c 60 "$WORK/sse.err" | tr '\n' ' ')）")
    mbody="$(jq -n --arg t '先用一行纯文本回复：loom fleet 在的；这行文本发出后再调用收束工具收束。不要调用其他任何工具。' '{text:$t}')"
    st="$(api POST "/sessions/$SID1/messages" "$mbody")"
    [[ "$st" == "202" ]] || reasons+=("发消息未受理 st=${st:-000}")
    sse_wait_idle "$SID1"
    sse_assert "$SSE_OUT" "$SID1"; merge_sse_reasons
    TXT1="$(sse_text "$SSE_OUT")"
    # 空文本仅在"确有 delta 帧"时才归因 fake 通道；超时缺帧场景上面已有"缺 delta"在列
    if grep -q '"type":"message.part.delta"' "$SSE_OUT" 2>/dev/null; then
      (( ${#TXT1} > 0 )) || reasons+=("delta 文本为空（fake 通道嫌疑）")
    fi
    [[ "$PROVIDER" != "fake" && "$PROVIDER" != "none" ]] || reasons+=("provider=$PROVIDER 非真模型面")
    (( ${#reasons[@]} == 0 )) && break
    s01_why="${reasons[*]:-}"
  done
  if (( ${#reasons[@]} == 0 )); then
    record S01 "主会话真应答" PASS "$(( $(date +%s) - t0 ))" "sid=$SID1 att=$s01_att frames=$(grep -c '^data:' "$SSE_OUT") provider=$PROVIDER 首答:${TXT1:0:40}"
  else
    record S01 "主会话真应答" FAIL "$(( $(date +%s) - t0 ))" "att=$s01_att $(ev_cut "$s01_why")"
  fi
fi
[[ "$DEPLOYED" == "1" && "$UNREACHABLE" == "0" ]] && sleep "$SCENE_GAP"; true

# ── S02 人设/记忆注入：应答非空 + 今日 trace 该会话 assembly span 且 attrs.injectedLines>0 硬证（应答形态变例重试一次） ──
t0=$(date +%s); TXT2=""; asm2=0
if scene_gate S02 "人设/记忆注入"; then
  s02_att=0; s02_why=""
  for att_no in 1 2; do
    s02_att=$att_no; reasons=()
    st="$(api POST /sessions)"; SID2=""
    [[ "$st" == "201" || "$st" == "200" ]] && SID2="$(jq -r '.sessionID // empty' "$WORK/body")"
    if [[ -z "$SID2" ]]; then
      reasons+=("建会话失败 st=${st:-000} $(peek)")
      s02_why="${reasons[*]:-}"
      continue
    fi
    SID_LIST+=("S02#$att_no:$SID2")
    sse_start "$SID2"
    [[ "$SSE_ALIVE" == "1" ]] || reasons+=("SSE 连接未建立")
    q="$(jq -n --arg t '你的 AGENTS.md 规则里第一条是什么风格的内容？直接用纯文本回答一句概述（不要调用工具），回答后收束。' '{text:$t}')"
    st="$(api POST "/sessions/$SID2/messages" "$q")"
    [[ "$st" == "202" ]] || reasons+=("发消息未受理 st=${st:-000}")
    sse_wait_idle "$SID2"
    TXT2="$(sse_text "$SSE_OUT")"
    (( ${#TXT2} > 0 )) || reasons+=("应答为空（frames=$(grep -c '^data:' "$SSE_OUT")）")
    # assembly span 由 registry 在回合尾写盘，可能晚于 idle 数拍——轮询窗口消竞态
    asm2=0; inj2=0
    for _try in 1 2 3 4 5 6; do
      if [[ -f "$TRACE_FILE" ]] && grep -F "\"sessionId\":\"$SID2\"" "$TRACE_FILE" | grep -q '"stage":"assembly"'; then
        asm2="$(grep -F "\"sessionId\":\"$SID2\"" "$TRACE_FILE" | grep -c '"stage":"assembly"')"
        inj2="$(grep -F "\"sessionId\":\"$SID2\"" "$TRACE_FILE" | grep '"stage":"assembly"' | grep -c '"injectedLines":[1-9]')"
        break
      fi
      sleep 2
    done
    if [[ ! -f "$TRACE_FILE" ]]; then
      reasons+=("无今日 trace 文件: $TRACE_FILE")
    elif (( asm2 == 0 )); then
      reasons+=("该会话无 assembly span（轮询 12s 竞态窗口内）")
    elif (( inj2 == 0 )); then
      reasons+=("assembly span 无 attrs.injectedLines>0 硬证（记忆注入行数未落盘）")
    fi
    (( ${#reasons[@]} == 0 )) && break
    s02_why="${reasons[*]:-}"
  done
  if (( ${#reasons[@]} == 0 )); then
    record S02 "人设/记忆注入" PASS "$(( $(date +%s) - t0 ))" "sid=$SID2 att=$s02_att assembly=${asm2}行 injectedLines>0=${inj2}行 答:${TXT2:0:50}"
  else
    record S02 "人设/记忆注入" FAIL "$(( $(date +%s) - t0 ))" "sid=${SID2:-无} att=$s02_att $(ev_cut "$s02_why")"
  fi
fi
[[ "$DEPLOYED" == "1" && "$UNREACHABLE" == "0" ]] && sleep "$SCENE_GAP"; true

# ── S03 上下文延续：同会话两轮，第二轮复述命中关键词 ──
t0=$(date +%s); reasons=(); TXT3=""
if scene_gate S03 "上下文延续"; then
  s03_att=0; s03_why=""
  for att_no in 1 2; do
    s03_att=$att_no; reasons=()
    st="$(api POST /sessions)"; SID3=""
    [[ "$st" == "201" || "$st" == "200" ]] && SID3="$(jq -r '.sessionID // empty' "$WORK/body")"
    KW="紫云织机$(hex16 | cut -c1-4)"
    if [[ -z "$SID3" ]]; then
      reasons+=("建会话失败 st=${st:-000} $(peek)")
      break
    fi
    SID_LIST+=("S03#$att_no:$SID3")
    sse_start "$SID3"
    [[ "$SSE_ALIVE" == "1" ]] || reasons+=("第一轮 SSE 连接未建立")
    m="$(jq -n --arg t "请记住关键词「$KW」。本轮请直接用纯文本回复：收到。回复后收束。" '{text:$t}')"
    st="$(api POST "/sessions/$SID3/messages" "$m")"
    [[ "$st" == "202" ]] || reasons+=("第一轮未受理 st=${st:-000}")
    sse_wait_idle "$SID3"
    sse_start "$SID3"
    [[ "$SSE_ALIVE" == "1" ]] || reasons+=("第二轮 SSE 连接未建立")
    m="$(jq -n --arg t "我刚才让你记住的关键词是什么？直接用纯文本回复关键词本身，不要调用工具。回复后收束。" '{text:$t}')"
    st="$(api POST "/sessions/$SID3/messages" "$m")"
    [[ "$st" == "202" ]] || reasons+=("第二轮未受理 st=${st:-000}（409=第一轮未收束）")
    sse_wait_idle "$SID3"
    TXT3="$(sse_text "$SSE_OUT")"
    if [[ ${#TXT3} == "0" ]]; then
      reasons+=("第二轮应答为空（frames=$(grep -c '^data:' "$SSE_OUT") 形态变例）")
    elif [[ "$TXT3" != *"$KW"* ]]; then
      reasons+=("第二轮不含关键词「$KW」（答:${TXT3:0:40}）")
    fi
    (( ${#reasons[@]} == 0 )) && break
    s03_why="${reasons[*]:-}"
  done
  if (( ${#reasons[@]} == 0 )); then
    record S03 "上下文延续" PASS "$(( $(date +%s) - t0 ))" "sid=$SID3 att=$s03_att kw=$KW 复述命中"
  else
    record S03 "上下文延续" FAIL "$(( $(date +%s) - t0 ))" "sid=${SID3:-无} att=$s03_att $(ev_cut "$s03_why")"
  fi
fi
[[ "$DEPLOYED" == "1" && "$UNREACHABLE" == "0" ]] && sleep "$SCENE_GAP"; true

# ── S04 副会话纯脑任务：fleet-brain → done，detail 含 ledger.expected_at + actual ──
t0=$(date +%s); reasons=(); RUN4="run_$(hex16)"; RID4=""
if scene_gate S04 "副会话纯脑任务"; then
  RUN_IDS+=("$RUN4")
  RID4="$(submit_run "fleet-brain" "用一句话收束本任务。收束回执字段照抄：run_id=$RUN4，workflow=fleet-brain，status=done，digest=fleet S04 ok；pointers 留空，blockers 留空。除收束外不要调用其他工具。" "" "$RUN4")"
  if [[ -z "$RID4" ]]; then
    reasons+=("提交失败 st=${LAST_ST:-000} $(peek)")
  else
    term4="$(wait_run "$RID4" 90)"
    st="$(api GET "/runs/$RID4")"
    exp_at="$(jq -r '.ledger.expected_at // empty' "$WORK/body" 2>/dev/null)"
    act4="$(jq -c '.ledger.actual // empty' "$WORK/body" 2>/dev/null)"
    [[ "$term4" == "done" ]] || reasons+=("终态=$term4（期望 done）")
    [[ -n "$exp_at" ]] || reasons+=("detail.ledger.expected_at 缺失")
    [[ -n "$act4" ]] || reasons+=("detail.ledger.actual 缺失")
  fi
  if [[ ${#reasons[@]} -eq 0 ]]; then
    record S04 "副会话纯脑任务" PASS "$(( $(date +%s) - t0 ))" "run=$RID4 done expected_at=$exp_at actual=$act4"
  else
    record S04 "副会话纯脑任务" FAIL "$(( $(date +%s) - t0 ))" "run=$RID4 $(ev_cut "${reasons[*]:-}")"
  fi
fi
[[ "$DEPLOYED" == "1" && "$UNREACHABLE" == "0" ]] && sleep "$SCENE_GAP"; true

# ── S05 副会话工具任务（不写盘姿势，用户 00:13 口径）：done + runId join tool span>0 + digest 含 marker ──
t0=$(date +%s); RUN5="run_$(hex16)"
if scene_gate S05 "副会话工具任务"; then
  RUN_IDS+=("$RUN5")
  MARKER="FLEET-MARKER-$(hex16 | cut -c1-8)"
  RID5="$(submit_run "fleet-tool" "用 bash 工具执行命令：echo $MARKER 。然后调用收束工具，把该命令的输出原样写进 digest（digest 只放这串标记本身，不加引号不加解释）。除 bash 和收束外不要调用其他工具，不要写任何文件。" "" "$RUN5")"
  if [[ -z "$RID5" ]]; then
    record S05 "副会话工具任务" FAIL "$(( $(date +%s) - t0 ))" "run=$RUN5 提交未受理 st=${LAST_ST:-000} $(peek)"
  else
    term5="$(wait_run "$RID5" 240)"
    st="$(api GET "/runs/$RID5")"
    # tool span 计数走 GET /runs/:id 的 trace 字段（服务端 runId join，task-api/views.ts traceSpansOf）
    toolspans="$(jq '[.trace[]? | select(.stage=="tool")] | length' "$WORK/body" 2>/dev/null)"
    [[ "$toolspans" =~ ^[0-9]+$ ]] || toolspans=0
    digest5="$(jq -r '(.terminal.digest // .receipt.digest // "")' "$WORK/body" 2>/dev/null)"
    if [[ "$term5" == "timeout" ]]; then
      api POST "/runs/$RID5/cancel" '{"actor":"script","reason":"fleet S05 deadline"}' >/dev/null 2>&1 || true
      record S05 "副会话工具任务" FAIL "$(( $(date +%s) - t0 ))" "run=$RID5 240s 未到终态（已尽力 cancel）"
    elif [[ "$term5" != "done" ]]; then
      record S05 "副会话工具任务" FAIL "$(( $(date +%s) - t0 ))" "run=$RID5 终态=$term5（期望 done） digest:${digest5:0:50}"
    elif (( toolspans == 0 )); then
      record S05 "副会话工具任务" FAIL "$(( $(date +%s) - t0 ))" "run=$RID5 done 但 runId join tool span=0（boot.ts 00:20 版已挂工具面，若命中此判据=接线回归，报修项）"
    elif [[ "$digest5" == *"$MARKER"* ]]; then
      record S05 "副会话工具任务" PASS "$(( $(date +%s) - t0 ))" "run=$RID5 done tool_spans=$toolspans digest 含 $MARKER"
    else
      record S05 "副会话工具任务" FAIL "$(( $(date +%s) - t0 ))" "run=$RID5 done tool_spans=$toolspans 但 digest 不含 marker（digest:${digest5:0:60}）"
    fi
  fi
fi
[[ "$DEPLOYED" == "1" && "$UNREACHABLE" == "0" ]] && sleep "$SCENE_GAP"; true

# ── S06 cancel/rerun：cancel_requested 置位（cancel 只命中 running，engine 契约）；rerun attempt+1 parent=源 ──
t0=$(date +%s); reasons=(); RUN6=""; SRC=""; RID6B=""; ATT6=""; PAR6=""
if scene_gate S06 "cancel/rerun"; then
  LONG="请写一篇约 500 字的关于织机与记忆的中文随笔，正文全部写完后才允许调用收束工具收束，不要提前收束。"
  CANCELLED_RID=""
  for attempt_no in 1 2; do
    RUN6="run_$(hex16)"; RUN_IDS+=("$RUN6")
    rid="$(submit_run "fleet-cancel" "$LONG" "" "$RUN6")"
    if [[ -z "$rid" ]]; then
      reasons+=("第${attempt_no}次提交失败 st=${LAST_ST:-000} $(peek)")
      break
    fi
    s=""
    for _poll in 1 2 3 4 5 6 7 8 9 10; do
      st="$(api GET "/runs/$RUN6")"
      s="$(jq -r '.status // "?"' "$WORK/body" 2>/dev/null)"
      [[ "$s" == "running" || "$s" == "done" || "$s" == "partial" || "$s" == "failed" ]] && break
      sleep 2
    done
    if [[ "$s" != "running" ]]; then
      reasons+=("第${attempt_no}次 cancel 窗口错过（状态=$s）")
      continue
    fi
    st="$(api POST "/runs/$RUN6/cancel" '{"actor":"script","reason":"fleet S06 cancel"}')"
    [[ "$st" == "200" ]] || { reasons+=("cancel 调用失败 st=${st:-000}"); continue; }
    sleep 1
    st="$(api GET "/runs/$RUN6")"
    crq="$(jq -r '.cancel_requested // empty' "$WORK/body" 2>/dev/null)"
    if [[ -n "$crq" ]]; then CANCELLED_RID="$RUN6"; break; fi
    reasons+=("第${attempt_no}次 cancel_requested 未置位")
  done
  [[ -n "$CANCELLED_RID" ]] || reasons+=("两轮尝试均未取得 cancel 证据")
  SRC="${CANCELLED_RID:-$RUN6}"
  st="$(api GET "/runs/$SRC")"
  src_att="$(jq -r '.attempt // empty' "$WORK/body" 2>/dev/null)"
  st="$(api POST "/runs/$SRC/rerun" "$(jq -n --arg p '只答一个字：好。然后立即调用收束工具。' '{prompt:$p, actor:"script", trigger:"manual"}')" )"
  if [[ "$st" == "202" ]]; then
    RID6B="$(jq -r '.run_id // empty' "$WORK/body")"
    ATT6="$(jq -r '.attempt // empty' "$WORK/body")"
    PAR6="$(jq -r '.parent_run // empty' "$WORK/body")"
    [[ -n "$RID6B" ]] && RUN_IDS+=("$RID6B")
    [[ "$PAR6" == "$SRC" ]] || reasons+=("rerun parent_run=$PAR6 ≠ $SRC")
    [[ -n "$src_att" && -n "$ATT6" && "$ATT6" == "$(( src_att + 1 ))" ]] || reasons+=("rerun attempt=$ATT6 ≠ 源($src_att)+1")
    sleep 2
    api POST "/runs/$RID6B/cancel" '{"actor":"script","reason":"fleet S06 cleanup"}' >/dev/null 2>&1 || true
  else
    reasons+=("rerun 未受理 st=${st:-000} $(peek)")
  fi
  if [[ ${#reasons[@]} -eq 0 ]]; then
    record S06 "cancel/rerun" PASS "$(( $(date +%s) - t0 ))" "run=$SRC cancel_requested 置位；rerun=$RID6B attempt=$ATT6 parent=$SRC"
  else
    record S06 "cancel/rerun" FAIL "$(( $(date +%s) - t0 ))" "run=$SRC $(ev_cut "${reasons[*]:-}")"
  fi
fi
[[ "$DEPLOYED" == "1" && "$UNREACHABLE" == "0" ]] && sleep "$SCENE_GAP"; true

# ── S07 agent 角色声明：文件缺失→SKIP；断言 run 侧 trace assembly span 行数>0 ──
t0=$(date +%s); reasons=(); RUN7="run_$(hex16)"
if scene_gate S07 "agent 角色声明"; then
  AGENT="01_data_check"
  if [[ -z "$WS" || ! -r "$WS/agents/01-data-check.md" ]]; then
    record S07 "agent 角色声明" SKIP "$(( $(date +%s) - t0 ))" "agent 文件缺失/不可读：${WS:-?}/agents/01-data-check.md"
  else
    RUN_IDS+=("$RUN7")
    RID7="$(submit_run "fleet-agent" "按你的角色职责，用一句话概述你能做什么。然后调用收束工具收束，收束回执字段照抄：run_id=$RUN7，workflow=fleet-agent，status=done，digest=你的那句概述；pointers 与 blockers 留空。" "$AGENT" "$RUN7")"
    if [[ -z "$RID7" ]]; then
      reasons+=("带 agent 提交失败 st=${LAST_ST:-000} $(peek)")
    else
      term7="$(wait_run "$RID7" 90)"
      # done/partial=角色绑定生效正常盖棺（partial 常为 gate 如实报 blocker，正是反假完成设计）；
      # failed/timeout=绑定或执行故障（agent 缺失会走崩溃形状留账本缺口）
      case "$term7" in done|partial) ;; *) reasons+=("终态=$term7（期望 done/partial；failed/timeout=绑定或执行故障）") ;; esac
      asm7="$(jq '[.trace[]? | select(.stage=="assembly")] | length' "$WORK/body" 2>/dev/null)"
      [[ "$asm7" =~ ^[0-9]+$ ]] || asm7=0
      (( asm7 > 0 )) || reasons+=("run 侧 trace assembly span 行数=0")
    fi
    if [[ ${#reasons[@]} -eq 0 ]]; then
      record S07 "agent 角色声明" PASS "$(( $(date +%s) - t0 ))" "run=$RID7 agent=$AGENT assembly=${asm7}行"
    else
      record S07 "agent 角色声明" FAIL "$(( $(date +%s) - t0 ))" "run=$RID7 $(ev_cut "${reasons[*]:-}")"
    fi
  fi
fi
[[ "$DEPLOYED" == "1" && "$UNREACHABLE" == "0" ]] && sleep "$SCENE_GAP"; true

# ── S08 账本缺口对账：expected∖actual ⊆ 在途集；差集外命中才 FAIL ──
t0=$(date +%s); reasons=(); KINDS_NOTE=""
if scene_gate S08 "账本缺口对账"; then
  # 顺序敏感：先拍在途快照（/runs ∪ /tasks——W9 切片 3 后后台 sub 入账本，只拍 /runs
  # 会把在飞后台子误判为缺口=定稿点名最硬约束），再扫账本（反向会出"扫描间隙完成"的假阳性缺口）
  st="$(api GET /runs)"
  RUNNING=""
  if [[ "$st" == "200" ]]; then
    RUNNING="$(jq -r '.runs[] | select(.status=="queued" or .status=="admitted" or .status=="running") | .run_id' "$WORK/body" 2>/dev/null)"
  else
    reasons+=("GET /runs st=${st:-000}")
  fi
  tst="$(api GET /tasks)"
  if [[ "$tst" == "200" ]]; then
    RUNNING+="$(jq -r '.tasks[] | select(.status=="queued" or .status=="admitted" or .status=="running") | .run_id' "$WORK/body" 2>/dev/null)"
  else
    reasons+=("GET /tasks st=${tst:-000}")
  fi
  # ledger 分片轴=UTC 日（layout.ts stateDateKey=toISOString），trace 轴=本地日——跨午夜必分叉；
  # 扫描日并集：{本地今日, UTC 今日, 启动UTC日(startedAt 前 10 位)} 去重
  days=()
  u_now="$(date -u +%F)"; u_boot="${BOOT_DAY:0:10}"
  for cand in "$TODAY" "$u_now" "$u_boot"; do
    [[ -n "$cand" ]] || continue
    case " ${days[*]-} " in *" $cand "*) continue;; esac
    days+=("$cand")
  done
  EXP=""; ACT=""
  for d in "${days[@]}"; do
    f="$STATE_ROOT/ledger/$d.jsonl"
    [[ -r "$f" ]] || continue
    while IFS=$'\t' read -r rowt rowrid; do
      [[ -n "$rowrid" ]] || continue
      [[ "$rowt" == "expected" ]] && EXP+="$rowrid"$'\n'
      [[ "$rowt" == "actual" ]] && ACT+="$rowrid"$'\n'
    done < <(jq -r '[.t, .runId] | @tsv' "$f" 2>/dev/null)
  done
  # comm 必须吃 C 字节序（zh_CN collate 会忽略下划线致"not properly sorted"假序）
  GAP="$(comm -23 <(printf '%s' "$EXP" | sed '/^$/d' | LC_ALL=C sort -u) <(printf '%s' "$ACT" | sed '/^$/d' | LC_ALL=C sort -u))"
  EXTRA="$(comm -23 <(printf '%s' "$GAP" | sed '/^$/d' | LC_ALL=C sort -u) <(printf '%s' "$RUNNING" | sed '/^$/d' | LC_ALL=C sort -u))"
  n_exp="$(printf '%s' "$EXP" | sed '/^$/d' | LC_ALL=C sort -u | wc -l)"
  n_gap="$(printf '%s' "$GAP" | sed '/^$/d' | wc -l)"
  n_run="$(printf '%s' "$RUNNING" | sed '/^$/d' | wc -l)"
  if [[ -n "$EXTRA" ]]; then
    # 命中缺口逐个回读引擎：404=引擎无痕（历史崩溃残账，T13 对账输入），如实标注性质供人区分
    nature=""
    for r in $(echo "$EXTRA" | head -3); do
      st="$(api GET "/runs/$r")"
      if [[ "$st" == "404" ]]; then nature+=" $r(引擎无痕=历史残账)"; else
        cr="$(jq -r '.crashed // "?"' "$WORK/body" 2>/dev/null)"
        nature+=" $r(crashed=$cr)"
      fi
    done
    reasons+=("差集外命中:${nature}")
  fi
  if [[ ${#reasons[@]} -eq 0 ]]; then
    record S08 "账本缺口对账" PASS "$(( $(date +%s) - t0 ))" "扫描日[${days[*]}; ] expected=$n_exp gap=$n_gap 全部∈在途($n_run)；差集外=0"
  else
    record S08 "账本缺口对账" FAIL "$(( $(date +%s) - t0 ))" "$(ev_cut "${reasons[*]:-}")"
  fi
fi
[[ "$DEPLOYED" == "1" && "$UNREACHABLE" == "0" ]] && sleep "$SCENE_GAP"; true

# ── S09 trace 完整性：今日文件存在；未知 stage 才 FAIL（kind 并集按源码 types.ts，任务书"每行 kind=span"系漂移） ──
t0=$(date +%s); reasons=(); total=0; bad=0; unk=0; KINDS_SUM=""
if scene_gate S09 "trace 完整性"; then
  if [[ ! -f "$TRACE_FILE" ]]; then
    reasons+=("无今日 trace 文件: $TRACE_FILE")
  else
    kinds=""
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      total=$(( total + 1 ))
      k="$(printf '%s' "$line" | jq -r '.kind // "BAD"' 2>/dev/null)" || k="BAD"
      case "$k" in
        span|nudge|run_end) kinds+="$k"$'\n' ;;
        *) bad=$(( bad + 1 ));;
      esac
      if [[ "$k" == "span" ]]; then
        sgi="$(printf '%s' "$line" | jq -r '.stage // "NONE"' 2>/dev/null)"
        case "$sgi" in
          queued|admitted|assembly|turn|tool|summary|delivered) ;;
          *) unk=$(( unk + 1 )); reasons+=("未知 stage: $sgi");;
        esac
      fi
    done < "$TRACE_FILE"
    (( bad == 0 )) || KINDS_NOTE="撕裂容忍行=$bad;"
    KINDS_SUM="$(printf '%s' "$kinds" | sed '/^$/d' | sort | uniq -c | tr '\n' ' ')"
  fi
  if [[ ${#reasons[@]} -eq 0 ]]; then
    record S09 "trace 完整性" PASS "$(( $(date +%s) - t0 ))" "$(basename "$TRACE_FILE") 行数=$total 未知stage=0 ${KINDS_NOTE}kind[$KINDS_SUM]"
  else
    record S09 "trace 完整性" FAIL "$(( $(date +%s) - t0 ))" "$(ev_cut "${reasons[*]:-}")"
  fi
fi
[[ "$DEPLOYED" == "1" && "$UNREACHABLE" == "0" ]] && sleep "$SCENE_GAP"; true

# ── S10 复盘小结：Top3 耗时 + 全部 run_id/sid；报告落 harness state/fleet/（离产口径） ──
t0=$(date +%s)
ELAPSED_TOTAL=$(( $(date +%s) - T_START ))
REPORT_PATH=""
if mkdir -p "$FLEET_OUT_DIR" 2>/dev/null; then
  rp="$FLEET_OUT_DIR/fleet-$TODAY-$(date +%H%M).md"
  {
    echo "# Loom 全功能验收报告（fleet）$TODAY $(date '+%H:%M:%S')"
    echo
    echo "> 工件：axeuh-harness/scripts/loom-fleet.sh（场景 runner）+ scripts/loomctl.sh（全 REST 薄 CLI）"
    echo "> 目标：$BASE ｜ state 根：$STATE_ROOT ｜ workspace：${WS:-未取}（只读）｜ provider：${PROVIDER:-未取} ｜ health：$PRE"
    echo "> 全程耗时：${ELAPSED_TOTAL}s（硬上限 ${OVERALL_LIMIT}s）｜ PASS=$NPASS FAIL=$NFAIL SKIP=$NSKIP ｜ exit=$NFAIL"
    echo
    echo "| 场景 | 名称 | 状态 | 耗时(s) | 证据 |"
    echo "|---|---|---|---|---|"
    printf '%s\n' "${ROWS[@]}"
    echo
    echo "## 复盘（S10）"
    echo
    echo "- 耗时 Top3："
    printf '%s\n' "${ROWS[@]}" | sed 's/|/\t/g' \
      | awk -F'\t' '{sec=$5; name=$2" "$3; gsub(/^ +| +$/,"",sec); if (sec ~ /^[0-9]+$/) print sec"\t"name}' \
      | sort -rn | head -3 | awk -F'\t' '{printf "  - %ss | %s\n", $1, $2}'
    echo "- 全部 run_id（深挖：loomctl.sh runs status <id> / trace-run <id> / ledger-gaps）："
    if (( ${#RUN_IDS[@]} > 0 )); then printf '  - %s\n' "${RUN_IDS[@]}"; else echo "  - （无）"; fi
    echo "- 主会话 session_id："
    if (( ${#SID_LIST[@]} > 0 )); then printf '  - %s\n' "${SID_LIST[@]}"; else echo "  - （无）"; fi
    echo
    echo "## 尾注纪律（docs/07 §9 四条 + 用户 00:13 离产口径）"
    echo
    echo "1. 密钥不回显、不进上下文：本报告无任何 credentials 内容；token 只经请求头传递。"
    echo "2. loom cron 调度器永远关：本运行由人/生产 opencode 显式触发；fleet 绝不配置任何 loom 任务。"
    echo "3. opencode 只报告不运维：不重启服务、不 kill、不改 loom 配置与 harness 代码；FAIL 原样进报告。"
    echo "4. 产出离产（用户 00:13 口径，覆盖原探针报告落点约定）：loom 测试产出不塞生产 ai/；"
    echo "   fleet 报告与全部写落 axeuh-harness/state/fleet/（产物预留区 state/fleet/out/），其余路径一律只读。"
    echo
    echo "## 在途能力与文档漂移判据"
    echo "- S05 不写盘姿势：bash echo marker → done + runId join tool span>0 + digest 含 marker；工具面已接线（boot.ts 00:20 版 toolWiring），此场景为全判据 PASS/FAIL，不再 SKIP 糊弄。"
    echo "- 漂移1：SSE 实路由 = GET /events/stream?sessionId=（docs/06 §5 概写 GET /events；真源 serve/boot.ts）。"
    echo "- 漂移2：发消息体 text/message/content/parts 四种键均被 session-api/routes.ts extractText 接受。"
    echo "- 漂移3：trace 行 kind 源码真源为 {span,nudge,run_end} 判别联合（core/trace/types.ts），非仅 span；S09 按并集判，未知 stage 才是 FAIL 线。"
    echo "- 漂移4：agent 引用形以源码为准——文件名 stem 清洗（sanitizeType，连字符→下划线），故 S07 用 01_data_check 引 ai/agents/01-data-check.md；字面连字符引用源码不认。"
    echo "- 漂移5：ledger 分片按 UTC 日（stateDateKey），trace 分片按本地日（localDateKey）——S08 三轴并集扫描消跨午夜分叉。"
  } > "$rp" 2>/dev/null && REPORT_PATH="$rp"
fi
if [[ -n "$REPORT_PATH" && -s "$REPORT_PATH" ]]; then
  record S10 "复盘小结" PASS "$(( $(date +%s) - t0 ))" "报告已落 $REPORT_PATH"
else
  record S10 "复盘小结" SKIP "$(( $(date +%s) - t0 ))" "报告文件未写入（未部署/workspace 未确认），stdout 汇总仍完整"
fi

# ── stdout 汇总（无论降级与否都完整输出同一张 markdown 表） ──
echo "# Loom fleet 验收汇总 $TODAY $(date '+%H:%M:%S')  target=$BASE"
echo
echo "| 场景 | 名称 | 状态 | 耗时(s) | 证据 |"
echo "|---|---|---|---|---|"
printf '%s\n' "${ROWS[@]}"
echo
echo "汇总: PASS=$NPASS FAIL=$NFAIL SKIP=$NSKIP 全程=${ELAPSED_TOTAL}s 报告=${REPORT_PATH:-仅stdout}"
exit "$NFAIL"
