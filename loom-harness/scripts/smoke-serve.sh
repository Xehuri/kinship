#!/usr/bin/env bash
# T31 真 serve 冒烟（一次性回归脚本，跑完留档）：
#   1) 后台起 `node packages/server/dist/cli.js serve --port 5097 --config <临时配置>`
#   2) 15s 内 127.0.0.1:5097 可连：/health 带 token 200（无 token 401）
#   3) SSE /events/stream?sessionId= 可订阅（200 + text/event-stream）
#   4) SIGTERM → 进程 exit 0 且端口释放
# 凭据：临时配置 provider: fake + LOOM_TEST_TOKEN 假令牌，零真密钥；state 根用临时目录。
# 端口纪律（D32）：只碰 5097；5096/8768/8769/18888 绝不触碰。退出前保证杀干净（记录 PID）。
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
PORT=5097
TOKEN="smoke-tok-$$"
CLI="$REPO/packages/server/dist/cli.js"

WORK="$(mktemp -d /tmp/loom-smoke.XXXXXX)"
cleanup() {
  # 兜底：无论走到哪一步失败，都确保子进程已不在、临时目录已清。
  if [[ -n "${CHILD_PID:-}" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$CHILD_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

if [[ ! -f "$CLI" ]]; then
  echo "[smoke] 缺少 $CLI —— 先 npm run build" >&2
  exit 1
fi

# ── 临时配置（fake provider 离线；pricing.fake 满足引用校验；无凭据段） ──
cat > "$WORK/loom.yaml" <<YAML
server:
  port: $PORT
  hostname: 127.0.0.1
workspace: $REPO/fixture-workspace
models:
  - id: smoke-fake
    provider: fake
    contextWindow: 200000
    maxOutput: 4096
    timeout: 60000
pricing:
  fake:
    input: 0
    output: 0
YAML

echo "[smoke] 启动 serve（port=$PORT, state=$WORK/state）"
LOOM_TEST_TOKEN="$TOKEN" LOOM_STATE="$WORK/state" \
  node "$CLI" serve --port "$PORT" --config "$WORK/loom.yaml" >"$WORK/serve.log" 2>&1 &
CHILD_PID=$!
echo "[smoke] 子进程 PID=$CHILD_PID"

# ── 15s 轮询 health（TCP 就绪 + 带 token 200） ──
deadline=$((SECONDS + 15))
ready=0
while (( SECONDS < deadline )); do
  if ! kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "[smoke] FAIL：serve 进程提前退出；日志：" >&2
    cat "$WORK/serve.log" >&2
    exit 1
  fi
  code=$(curl -s -o "$WORK/health.json" -w '%{http_code}' \
    -H "X-Loom-Token: $TOKEN" "http://127.0.0.1:$PORT/health" || true)
  if [[ "$code" == "200" ]]; then ready=1; break; fi
  sleep 0.3
done
if (( ready != 1 )); then
  echo "[smoke] FAIL：15s 内 /health 未 200；日志：" >&2
  cat "$WORK/serve.log" >&2
  exit 1
fi
echo "[smoke] OK：/health 200（$(cat "$WORK/health.json")）"

# ── 无 token 401（鉴权无未鉴权路径） ──
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")
[[ "$code" == "401" ]] || { echo "[smoke] FAIL：无 token health 应 401，实际 $code" >&2; exit 1; }
echo "[smoke] OK：无 token → 401"

# ── SSE 可订阅：先建会话，再订阅事件流头（--max-time 收 1 块即断，深度协议归 T38） ──
SESSION=$(curl -s -X POST -H "X-Loom-Token: $TOKEN" "http://127.0.0.1:$PORT/sessions" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).sessionID))')
[[ -n "$SESSION" ]] || { echo "[smoke] FAIL：会话创建未拿到 sessionID" >&2; exit 1; }
ctype=$(curl -s -o "$WORK/sse.head" -D "$WORK/sse.hdr" -w '%{content_type}' --max-time 2 \
  -H "X-Loom-Token: $TOKEN" "http://127.0.0.1:$PORT/events/stream?sessionId=$SESSION" || true)
if [[ "$ctype" != text/event-stream* ]]; then
  echo "[smoke] FAIL：SSE 订阅 content-type 应为 text/event-stream，实际 '$ctype'" >&2
  exit 1
fi
echo "[smoke] OK：SSE 可订阅（session=$SESSION, content-type=$ctype）"

# ── SIGTERM → exit 0 ──
kill -TERM "$CHILD_PID"
wait "$CHILD_PID" && EXIT_CODE=0 || EXIT_CODE=$?
if (( EXIT_CODE != 0 )); then
  echo "[smoke] FAIL：SIGTERM 后退出码应为 0，实际 $EXIT_CODE；日志：" >&2
  cat "$WORK/serve.log" >&2
  exit 1
fi
echo "[smoke] OK：SIGTERM → exit 0"

# ── 端口释放确认（curl 应连不上） ──
if curl -s -o /dev/null --connect-timeout 2 "http://127.0.0.1:$PORT/health"; then
  echo "[smoke] FAIL：退出后端口 $PORT 仍可连（未释放）" >&2
  exit 1
fi
echo "[smoke] OK：端口 $PORT 已释放"

echo "[smoke] PASS —— serve 冒烟全链通过"
