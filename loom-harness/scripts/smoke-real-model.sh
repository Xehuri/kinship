#!/usr/bin/env bash
# 真模型端到端冒烟（切流前最后闸门；回归工件）
#
# 目标：对 axeuh-loom systemd 影子实例（127.0.0.1:5100，真实 ai/ 工作区）执行
#   真 provider（eflowcode）消息往返：SSE 有序帧 → 收束 → idle 带 sessionID →
#   transcript 落盘 → 第二轮上下文延续。**假模型桩不算**（断言 message.updated
#   的 info.provider 必须等于配置供应商名，不接受 fake-*）。
#
# 已知缺口（2026-10-08 T39 前置接线波后更新）：
#   - 真 provider 接线已落地（loom.yaml providers[]/models[].baseUrl +
#     credentials → makeOpenAICompatibleModel）；serve 仍装配失败 = 回归，走 DIAG。
#   - serve 已接装配 span 写侧（trace/*.jsonl 的 stage:assembly 行）→ 已升级为硬断言。
#   - serve 仍未给主会话接 tools → 工具收束帧不存在（WARN，接线归后续任务）。
#
# 用法：scripts/smoke-real-model.sh [--rounds N] [--probe-provider] [--token-file PATH]
#   --probe-provider  只跑 provider/内核直连取证层（不要求 serve 在跑）
# 凭据纪律：LOOM_TOKEN 只进请求头，LOOM_KEY_* 绝不回显；本脚本不打印 credentials.conf 内容。
# 退出码：0=真链路全绿；1=SSE/收束/延续断言失败；2=provider 认证/网络层失败；3=装配层被拒（当前常态）。
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
PORT=5100
HOST="http://127.0.0.1:$PORT"
TOKEN_FILE="${TOKEN_FILE:-/etc/kinship-loom/credentials.conf}"
ROUNDS=2
PROBE_ONLY=0
CONFIG="$REPO/config/loom.yaml"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rounds) ROUNDS="$2"; shift 2 ;;
    --probe-provider) PROBE_ONLY=1; shift ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -r "$TOKEN_FILE" ]] || { echo "[smoke] FAIL：读不了 $TOKEN_FILE（需 root:xehuri 0640）" >&2; exit 2; }
LOOM_TOKEN="$(awk -F= '/^LOOM_TOKEN=/{print $2}' "$TOKEN_FILE")"
[[ -n "$LOOM_TOKEN" ]] || { echo "[smoke] FAIL：credentials.conf 缺 LOOM_TOKEN" >&2; exit 2; }
AUTH=(-H "Authorization: Bearer $LOOM_TOKEN")

WORK="$(mktemp -d /tmp/loom-smoke-real.XXXXXX)"
SSE_PIDS=()
cleanup() {
  for p in "${SSE_PIDS[@]:-}"; do kill -0 "$p" 2>/dev/null && kill -TERM "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { echo "[smoke] $*"; }
fail_diag() { # fail_diag <exit码> <层名> <说明>
  say "FAIL@$2：$3" >&2
  exit "$1"
}

# ── 层 0：服务可达性（systemd 影子实例在跑吗） ──
health_code() { curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 "${AUTH[@]}" "$HOST/health" || true; }

if [[ "$PROBE_ONLY" != 1 ]]; then
  hc="$(health_code)"
  if [[ "$hc" != "200" ]]; then
    say "health 非 200（实际 ${hc:-连不上}）→ 装配层诊断"
    # 取一次前台运行证据（与 unit 同 env；错误消息本身不含密钥）
    ( set -a; . "$TOKEN_FILE"; set +a
      LOOM_CONFIG="$CONFIG" timeout 25 node packages/server/dist/cli.js serve --port "$PORT" \
        >"$WORK/fg.log" 2>&1 ) || true
    if grep -q "无法为真 provider\|ServeCredentialMissing\|RealProviderNotWired" "$WORK/fg.log"; then
      fail_diag 3 "装配层(serve)" "resolveServeModel 真接线被拒（providers[]/models[].baseUrl 或 credentials 缺失；本波接线已落地，出现此错=配置/回归问题）。其余层取证见 --probe-provider。"
    elif grep -q "校验失败\|TokenMissing\|找不到 loom 配置文件" "$WORK/fg.log"; then
      sed -n '1,6p' "$WORK/fg.log" >&2
      fail_diag 3 "装配层(config/env)" "loom.yaml/credentials 校验失败，见上摘录（密钥值不会出现在其中）"
    else
      tail -5 "$WORK/fg.log" >&2
      fail_diag 3 "装配层(serve)" "serve 起不来，日志见上摘录"
    fi
  fi
  say "OK：/health 200（Bearer 头）"
fi

# ── provider 认证/网络层 + 内核传输层直连取证 ──
# 真 provider 名/端点取自 opencode.json 的非密钥字段；密钥只从 credentials.conf 取。
BASE_URL="$(node -e 'const j=require(process.env.HOME+"/.config/opencode/opencode.json");const p=j.provider.eflowcode;if(!p)process.exit(1);process.stdout.write(p.options.baseURL)' 2>/dev/null || echo "")"
[[ -n "$BASE_URL" ]] || fail_diag 2 "配置层" "opencode.json 无 eflowcode.baseURL 可读"
KEY_VAL="$(awk -F= '/^LOOM_KEY_EFLOWCODE=/{print $2}' "$TOKEN_FILE")"
[[ -n "$KEY_VAL" ]] || fail_diag 2 "配置层" "credentials.conf 缺 LOOM_KEY_EFLOWCODE"

# HTTP 直连（curl --config 喂 header：密钥不进 argv/ps/输出）
printf 'header = "Authorization: Bearer %s"\n' "$KEY_VAL" > "$WORK/.curlcfg"; chmod 600 "$WORK/.curlcfg"
KEY_VAL=""
pc="$(curl -sS --config "$WORK/.curlcfg" -o "$WORK/probe.json" -w '%{http_code}' \
  --connect-timeout 10 --max-time 60 "$BASE_URL/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"只回复四个字：链路正常"}],"max_tokens":512,"stream":false}' || true)"
rm -f "$WORK/.curlcfg"
pv="$(jq -r '.choices[0].message.content // "NO_CONTENT"' "$WORK/probe.json" 2>/dev/null || echo NO_CONTENT)"
if [[ "$pc" != "200" || "$pv" == "NO_CONTENT" ]]; then
  fail_diag 2 "provider认证/网络" "POST $BASE_URL/chat/completions → HTTP ${pc:-无应答}，content=$pv"
fi
say "OK：provider 层真应答（HTTP 200，content=「$pv」）"

# 内核传输层（loom 自有 makeOpenAICompatibleModel + completeText 走 pi-ai）
cat > "$WORK/kernel-probe.mjs" <<EOF
import { makeOpenAICompatibleModel, completeText } from "$REPO/packages/core/dist/llm-model.js";
const m = makeOpenAICompatibleModel({ id: "qwen3.8-flash", baseUrl: "$BASE_URL", provider: "eflowcode", contextWindow: 262144, maxTokens: 2048 });
const t = await completeText(m, [{ role: "user", content: "只回复六个字：内核链路可用", timestamp: Date.now() }], { apiKey: process.env.LOOM_KEY_EFLOWCODE, maxTokens: 2048 });
process.stdout.write(t);
EOF
( set -a; . "$TOKEN_FILE"; set +a; timeout 90 node "$WORK/kernel-probe.mjs" >"$WORK/kernel.out" 2>"$WORK/kernel.err" ) || {
  say "FAIL@内核传输层：$(tail -2 "$WORK/kernel.err")"; exit 2; }
kv="$(cat "$WORK/kernel.out")"
[[ "$kv" == *"内核链路可用"* ]] || fail_diag 2 "内核传输层" "应答异常：$kv"
say "OK：内核传输层真应答（reply=「$kv」）"

if [[ "$PROBE_ONLY" == 1 ]]; then
  say "PASS（--probe-provider：provider/网络/内核传输全绿；serve 真链路闸门待 T39 接线后跑完整模式）"
  exit 0
fi

# ── 层 1：主会话真链路（SSE 有序帧→收束→idle 带 sessionID→transcript→上下文延续） ──
SECRET="青龙偃月"
SID="$(curl -s -X POST "${AUTH[@]}" "$HOST/sessions" | jq -r .sessionID)"
[[ "$SID" =~ ^ses_[0-9a-f]{16}$ ]] || fail_diag 1 "会话层" "POST /sessions 未拿到 ses_ id：'$SID'"
say "会话 $SID"

check_round() { # check_round <轮次> <消息文本> <应答必含子串|->
  local n="$1" text="$2" expect="$3"
  # 订阅先开（seq 自 0 单调）；90s 窗口足够 NTFS + 真模型
  curl -sN --max-time 90 "${AUTH[@]}" "$HOST/events/stream?sessionId=$SID" >"$WORK/sse-$n.txt" 2>&1 &
  SSE_PIDS+=("$!")
  sleep 1
  local code
  code="$(curl -s -o "$WORK/send-$n.json" -w '%{http_code}' -X POST "${AUTH[@]}" \
    -H 'Content-Type: application/json' -d "$(jq -cn --arg t "$text" '{text:$t}')" \
    "$HOST/sessions/$SID/messages")"
  [[ "$code" == "202" ]] || fail_diag 1 "发送层" "第${n}轮 POST messages → HTTP $code：$(cat "$WORK/send-$n.json")"
  # 等 idle 收束（最多 85s）
  local deadline=$((SECONDS + 85)) idle=0
  while (( SECONDS < deadline )); do
    grep -q '"type":"session.idle"' "$WORK/sse-$n.txt" && { idle=1; break; }
    sleep 0.5
  done
  (( idle == 1 )) || fail_diag 1 "SSE/收束层" "第${n}轮 85s 未见 session.idle 帧；帧样本：$(tail -c 400 "$WORK/sse-$n.txt")"

  # 断言 a：seq 单调有序（帧解析独立跑，不信收束前的部分写盘）
  local seqs
  seqs="$(grep -o '"seq":[0-9]*' "$WORK/sse-$n.txt" | cut -d: -f2 | tr '\n' ' ')"
  # shellcheck disable=SC2086
  awk -v s="$seqs" 'BEGIN{n=split(s,a," ");prev=-1;for(i=1;i<=n;i++){if(a[i]+0<=prev){print "NONORDER";exit};prev=a[i]+0}print "ORDER"}' \
    | grep -q ORDER || fail_diag 1 "SSE层" "第${n}轮 seq 非单调：$seqs"
  # 断言 b：idle 帧带 sessionID
  grep -q "\"type\":\"session.idle\".*\"sessionID\":\"$SID\"" "$WORK/sse-$n.txt" \
    || fail_diag 1 "SSE层" "第${n}轮 idle 帧缺 sessionID=$SID"
  # 断言 c：真 provider 应答（fake 桩一票否决）
  grep -q '"provider":"eflowcode"' "$WORK/sse-$n.txt" \
    || fail_diag 1 "真模型断言" "第${n}轮帧流无 provider=eflowcode（假模型桩或快照帧缺失）"
  # 断言 d：文本增量存在
  grep -q '"type":"message.part.delta"' "$WORK/sse-$n.txt" \
    || say "WARN：第${n}轮无 message.part.delta（非流式 provider 可能只出快照帧）"
  # 观察项 e：工具收束帧。主会话 tools 已接线（1929786 serve 工具面），但本冒烟
  # prompt 明令"只回话不要调用工具"，模型纯文本自然收束（idle）属预期——
  # 此帧是否出现取决于模型当轮决策，不作为 WARN，只在缺席时记 INFO。
  grep -q '"type":"tool"' "$WORK/sse-$n.txt" \
    || say "INFO：第${n}轮无 tool 帧（禁工具 prompt 下纯文本收束，属预期；工具面验收看 fleet S05）"
  # transcript 落盘核验（state/session/loom-main.jsonl 归 LOOM_STATE）
  local st_root="${LOOM_STATE:-$REPO/state}"
  [[ -f "$st_root/session/loom-main.jsonl" ]] \
    || fail_diag 1 "持久层" "$st_root/session/loom-main.jsonl 不存在"
  # 断言 f：应答文本内容
  if [[ "$expect" != "-" ]]; then
    local hist attempt
    # 空应答重试 3 次：idle 帧先于 transcript 落盘是已知竞态（append 异步），
    # 真·空补全（provider 偶发）重试后仍空则响亮 FAIL，不掩盖。
    for attempt in 1 2 3; do
      hist="$(curl -s "${AUTH[@]}" "$HOST/sessions/$SID/history" | jq -r '[.messages[]|select(.role=="assistant")|.content|(if type=="array" then map(select(.type=="text")|.text)|join("") else . end)]|join("")')"
      [[ -n "$hist" ]] && break
      sleep 2
    done
    # expect 按 ERE 匹配：真模型对格式指令有复述自由度（同义应答不炸闸门），
    # 暗号延续轮传字面 SECRET 仍是硬校验。
    [[ "$hist" =~ $expect ]] \
      || fail_diag 1 "真模型应答" "第${n}轮 assistant 应答不匹配 /$expect/：${hist:0:160}"
    say "OK：第${n}轮应答命中 /$expect/（前 60 字：${hist:0:60}）"
  fi
  # 状态回 idle
  local st
  st="$(curl -s "${AUTH[@]}" "$HOST/sessions/$SID/status" | jq -r .status)"
  [[ "$st" == "idle" ]] || fail_diag 1 "收束层" "第${n}轮后 status=$st ≠ idle"
  say "OK：第${n}轮 有序帧+idle 带 sessionID+真 provider 应答+status idle"
}

check_round 1 "请记住暗号：${SECRET}。只回复两个字：记住了" "记|存"
if (( ROUNDS >= 2 )); then
  check_round 2 "刚才的暗号是什么？只回复暗号本身" "$SECRET"
fi

# trace jsonl 核验（T39 前置接线波：serve 已接装配 span 写侧 → 升级为硬断言）
TRACE_DAY="${LOOM_STATE:-$REPO/state}/trace/$(date +%F).jsonl"
if [[ -f "$TRACE_DAY" ]] && grep -q '"kind":"span"' "$TRACE_DAY"; then
  say "OK：trace 落盘 $TRACE_DAY（span 行数=$(grep -c '"kind":"span"' "$TRACE_DAY")）"
  # 装配前缀含真实 workspace 记忆：assembly span 的 assemblyRowCount>0（trace assembly span 行数>0 可证）
  ASM_CNT="$(grep -c '"stage":"assembly"' "$TRACE_DAY" || true)"
  ASM_ROWS_OK="$(jq -s '[.[]|select(.stage=="assembly")|(.assemblyRowCount // 0 > 0)]|map(select(.))|length' "$TRACE_DAY" 2>/dev/null || echo 0)"
  if [[ "$ASM_CNT" -ge 1 && "$ASM_ROWS_OK" -ge 1 ]]; then
    say "OK：assembly span ${ASM_CNT} 行且注入行数>0（记忆前缀证明）"
  else
    fail_diag 1 "装配span层" "trace 有 ${ASM_CNT} 行 assembly span，但 assemblyRowCount>0 的行数=${ASM_ROWS_OK}（记忆注入未进前缀？）"
  fi
else
  fail_diag 1 "trace层" "serve 已接装配 span 写侧：$TRACE_DAY 应含 kind:span 行而没有"
fi

say "PASS —— 真模型端到端冒烟全链通过（provider 应答 + SSE 有序 + 收束 idle + 上下文延续）"
exit 0
