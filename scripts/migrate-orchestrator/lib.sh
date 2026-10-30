#!/usr/bin/env bash
# shellcheck shell=bash
# =============================================================================
# lib.sh —— scripts/migrate-orchestrator 共享库（由 stage*.sh / rollback-stage*.sh source）
#
# 硬约束（与 README.md 的 "Script contract" 一一对应）：
#   1. 探针只读：/health、/api/services、/api/system/config、systemctl show、
#      pidfile、perception.jsonl 行数；
#   2. 写操作只经 run_sudo / run_sudo_timeout，且每条先打 EXEC 日志；
#   3. 绝不打印凭据：API token 与 LOOM_TOKEN 只经 stdin 交给 curl（-K -），
#      不进入 argv、不进入日志；
#   4. 绝不 pkill / killall / taskkill；结束进程只按 PID（kill <PID>）；
#   5. 绝不写 ai/data/**：perception.jsonl 只做 wc -l 只读快照。
#
# 审计日志：$AXEUH_STATE_DIR/logs/<stage>-<YYYYmmdd-HHMMSS>.log
# 状态目录：$AXEUH_STATE_DIR（默认 <root>/backend/data/migration-state，已被 .gitignore 覆盖）
#
# 测试缝（仅 tests/sim-stage3-window.sh 使用）：
#   AXEUH_TEST_NOW_FILE  文件内容为整数 epoch 毫秒；设置后 now_ms() 读它
# =============================================================================

# ---------------------------------------------------------------------------
# 默认配置（全部可用环境变量覆盖）
# ---------------------------------------------------------------------------
: "${AXEUH_ROOT:=/opt/kinship}"
: "${AXEUH_SERVICE:=axeuh-health}"
: "${AXEUH_LOOM_UNIT:=axeuh-loom}"
: "${AXEUH_MOSS_UNIT:=axeuh-moss-watch}"
: "${AXEUH_DROPIN:=/etc/systemd/system/axeuh-health.service.d/20-orchestrator-migration.conf}"
: "${AXEUH_STATE_DIR:=$AXEUH_ROOT/backend/data/migration-state}"
: "${AXEUH_DATA_ROOT:=$AXEUH_ROOT/ai/data}"
: "${AXEUH_CONFIG_YAML:=$AXEUH_ROOT/config.yaml}"
: "${AXEUH_AUTH_FILE:=$AXEUH_ROOT/backend/config/auth.json}"
: "${AXEUH_KERNEL_PIDFILE:=$AXEUH_ROOT/backend/data/kernel_state/kernel.pid}"
: "${AXEUH_API_BASE:=https://127.0.0.1:8768}"
: "${AXEUH_API_INSECURE:=1}"
: "${AXEUH_API_TIMEOUT_S:=8}"
: "${AXEUH_GATE_TIMEOUT_S:=90}"
: "${AXEUH_LOOM_HEALTH_URL:=http://127.0.0.1:5100/health}"
: "${AXEUH_LOOM_CREDENTIALS:=/etc/kinship-loom/credentials.conf}"
: "${AXEUH_HEALTH_TIMEOUT_S:=180}"
: "${AXEUH_SERVICE_READY_TIMEOUT_S:=300}"
: "${AXEUH_OBSERVE_MOSS_S:=600}"
: "${AXEUH_OBSERVE_KERNEL_S:=600}"
: "${AXEUH_OBSERVE_LOOM_S:=1800}"
: "${AXEUH_POLL_INTERVAL_S:=10}"
: "${AXEUH_OBSERVE_POLL_INTERVAL_S:=15}"
: "${AXEUH_GATE_MODE:=auto}"                       # auto | api | restart
: "${AXEUH_GATE_RESUME_PATH:=/api/services/%s/resume}"
: "${AXEUH_GATE_PAUSE_PATH:=/api/services/%s/pause}"
: "${LOOM_WINDOW_BUDGET_MS:=60000}"
: "${LOOM_HANDOFF_GAP_BUDGET_MS:=5000}"

# 运行期全局状态（不要手工设置）
_stage=""
_log_file="/dev/null"
AXEUH_TOKEN=""
TOKEN_SOURCE=""
LOOM_TOKEN=""
SERVICES_JSON=""
SERVICES_HTTP=""
API_HTTP=""
OPT_DRY=0
OPT_YES=0
PF_SOFT=0
SUDO_KEEPALIVE_PID=""
LOOM_WINDOW_MS=""
LOOM_HANDOFF_GAP_MS=""
LOOM_RESUME_MS=""
LOOM_STOP_MS=""
GATE_MODE_RESOLVED=""

# ---------------------------------------------------------------------------
# 日志：所有输出同时 tee 到状态目录的审计日志（失败不阻断）
# ---------------------------------------------------------------------------
log_init() {
  _stage=${1:?log_init needs a stage name}
  if mkdir -p "$AXEUH_STATE_DIR/logs" 2>/dev/null; then
    _log_file="$AXEUH_STATE_DIR/logs/${_stage}-$(date +%Y%m%d-%H%M%S).log"
    : > "$_log_file" || _log_file=/dev/null
  else
    _log_file=/dev/null
  fi
  log INFO "=============================================================="
  log INFO "stage=${_stage} user=$(id -un) host=$(hostname) root=${AXEUH_ROOT}"
  log INFO "log=${_log_file}"
  log INFO "budget: loom stop->healthy <= ${LOOM_WINDOW_BUDGET_MS} ms; handoff gap <= ${LOOM_HANDOFF_GAP_BUDGET_MS} ms"
}

log() {
  local phase=$1
  shift
  printf '%s [%s] %-4s %s\n' "$(date '+%F %T')" "${_stage:-?}" "$phase" "$*" |
    tee -a "$_log_file"
}

phase() { # phase <PRE|EXEC|POST> <title>
  local name=$1
  shift
  printf '\n%s [%s] ===== %s: %s =====\n' \
    "$(date '+%F %T')" "${_stage:-?}" "$name" "$*" | tee -a "$_log_file"
}

die() {
  local code=$1
  shift
  log FAIL "$*"
  log FAIL "stopped. Rollback matrix: scripts/migrate-orchestrator/README.md#rollback-matrix"
  exit "$code"
}

# 前置检查软失败：--dry-run 下只 WARN，真实执行时 die
pf_fail() {
  if (( PF_SOFT )); then
    log WARN "$* (dry-run: not fatal)"
    return 0
  fi
  die 6 "$*"
}

_on_err() {
  local rc=$?
  log FAIL "unexpected command failure (rc=${rc}, line=${1:-?})"
  log FAIL "no further step ran. See README.md#rollback-matrix"
  exit "$rc"
}

_cleanup() {
  if [[ -n "${SUDO_KEEPALIVE_PID:-}" ]]; then
    kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
  fi
}

init_traps() {
  trap '_on_err $LINENO' ERR
  trap '_cleanup' EXIT
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
parse_cli() {
  OPT_DRY=0
  OPT_YES=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) OPT_DRY=1 ;;
      --yes | -y) OPT_YES=1 ;;
      -h | --help) usage; exit 0 ;;
      *) printf 'unknown argument: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
    esac
  done
  if ((OPT_DRY == 0 && OPT_YES == 0)); then
    OPT_DRY=1
    log WARN "no --yes: DRY-RUN only (nothing will be mutated). Re-run with --yes to execute."
  fi
}

require_yes() {
  if ((OPT_YES == 0)); then
    die 2 "mutating stages require --yes"
  fi
}

# ---------------------------------------------------------------------------
# 时钟（可注入，见 tests/sim-stage3-window.sh）
# ---------------------------------------------------------------------------
now_ms() {
  if [[ -n "${AXEUH_TEST_NOW_FILE:-}" ]]; then
    cat "$AXEUH_TEST_NOW_FILE"
  else
    date +%s%3N
  fi
}

# ---------------------------------------------------------------------------
# 基础工具 / sudo
# ---------------------------------------------------------------------------
require_tools() {
  local tool
  for tool in curl python3 systemctl timeout date wc find awk ps grep sed tr mktemp install hostname; do
    command -v "$tool" >/dev/null 2>&1 || pf_fail "missing required tool: $tool"
  done
  if ((OPT_DRY == 0)); then
    if [[ "$(id -u)" != "0" ]] && ! command -v sudo >/dev/null 2>&1; then
      die 5 "sudo not found and not running as root"
    fi
  fi
  log INFO "tools present (curl/python3/systemctl/timeout)"
}

ensure_state_dir() {
  [[ -n "$AXEUH_STATE_DIR" ]] || die 5 "AXEUH_STATE_DIR is empty"
  if ! mkdir -p "$AXEUH_STATE_DIR" 2>/dev/null; then
    die 5 "cannot create state dir: $AXEUH_STATE_DIR"
  fi
  log INFO "state dir ready: $AXEUH_STATE_DIR"
}

ensure_sudo() {
  if [[ "$(id -u)" == "0" ]]; then
    log INFO "running as root (sudo not needed)"
    return 0
  fi
  if ! sudo -n true 2>/dev/null; then
    if ((OPT_DRY)); then
      pf_fail "sudo timestamp missing (dry-run: systemctl checks that need root may fail)"
      return 0
    fi
    log INFO "prompting for sudo once (timestamp is refreshed in the background)"
    sudo -v || die 5 "sudo authentication failed"
  fi
  # 长观察窗里 sudo 时间戳会过期：每 60s 续期一次（退出时按 PID 结束）
  (while sleep 60; do sudo -n -v 2>/dev/null || exit 0; done) &
  SUDO_KEEPALIVE_PID=$!
  log INFO "sudo ready (keepalive pid=${SUDO_KEEPALIVE_PID})"
}

run() {
  log EXEC "run: $*"
  "$@"
}

run_sudo() {
  if [[ "$(id -u)" == "0" ]]; then
    log EXEC "run: $*"
    "$@"
  else
    log EXEC "run: sudo $*"
    sudo "$@"
  fi
}

run_sudo_timeout() { # <seconds> <cmd...>
  local seconds=$1
  shift
  if [[ "$(id -u)" == "0" ]]; then
    log EXEC "run: timeout ${seconds}s $*"
    timeout "$seconds" "$@"
  else
    log EXEC "run: timeout ${seconds}s sudo $*"
    timeout "$seconds" sudo "$@"
  fi
}

# ---------------------------------------------------------------------------
# 凭据（绝不打印值）
# ---------------------------------------------------------------------------
resolve_api_token() {
  local soft=${1:-}
  if [[ -n "${AXEUH_API_TOKEN:-}" ]]; then
    AXEUH_TOKEN=$AXEUH_API_TOKEN
    TOKEN_SOURCE="env:AXEUH_API_TOKEN"
  elif [[ -n "${AXEUH_TOKEN_FILE:-}" ]]; then
    if [[ ! -r "$AXEUH_TOKEN_FILE" ]]; then
      _token_fail "$soft" "token file not readable: $AXEUH_TOKEN_FILE"
      return 1
    fi
    IFS= read -r AXEUH_TOKEN <"$AXEUH_TOKEN_FILE" || true
    TOKEN_SOURCE="file:$AXEUH_TOKEN_FILE"
  else
    if [[ ! -r "$AXEUH_AUTH_FILE" ]]; then
      _token_fail "$soft" "auth file not readable: $AXEUH_AUTH_FILE (set AXEUH_API_TOKEN)"
      return 1
    fi
    AXEUH_TOKEN=$(python3 - "$AXEUH_AUTH_FILE" <<'PY'
import json
import sys
from datetime import datetime

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as handle:
        doc = json.load(handle)
except Exception:
    sys.exit(0)

now = datetime.now().isoformat()
for token, info in (doc.get("tokens") or {}).items():
    if not isinstance(info, dict):
        continue
    # /api/services 走 require_config_read：只接受 user token（service/device 会 403）
    if (info.get("kind") or "user") != "user":
        continue
    expires = str(info.get("expires_at") or "")
    if expires and expires <= now:
        continue
    print(token)
    break
PY
)
    TOKEN_SOURCE="auth-file:$AXEUH_AUTH_FILE"
  fi
  if [[ -z "${AXEUH_TOKEN:-}" ]]; then
    _token_fail "$soft" "no usable user token (set AXEUH_API_TOKEN, or AXEUH_TOKEN_FILE, or a valid token in $AXEUH_AUTH_FILE)"
    return 1
  fi
  log INFO "api token resolved from ${TOKEN_SOURCE} (value never logged)"
}

_token_fail() {
  local soft=$1
  shift
  if [[ "$soft" == "soft" ]]; then
    log WARN "$*"
    return 0
  fi
  die 3 "$*"
}

ensure_loom_token() {
  local soft=${1:-}
  [[ -n "${LOOM_TOKEN:-}" ]] && return 0
  if [[ -n "${AXEUH_LOOM_TOKEN:-}" ]]; then
    LOOM_TOKEN=$AXEUH_LOOM_TOKEN
    log INFO "loom token resolved from env:AXEUH_LOOM_TOKEN (value never logged)"
    return 0
  fi
  if [[ ! -r "$AXEUH_LOOM_CREDENTIALS" ]]; then
    if [[ "$soft" == "soft" ]]; then
      log WARN "loom credentials not readable: $AXEUH_LOOM_CREDENTIALS"
      return 1
    fi
    die 3 "loom credentials not readable: $AXEUH_LOOM_CREDENTIALS (set AXEUH_LOOM_TOKEN)"
  fi
  LOOM_TOKEN=$(sed -n 's/^[[:space:]]*LOOM_TOKEN[[:space:]]*=[[:space:]]*//p' "$AXEUH_LOOM_CREDENTIALS" |
    head -n 1 | tr -d "\"'")
  if [[ -z "$LOOM_TOKEN" ]]; then
    if [[ "$soft" == "soft" ]]; then
      log WARN "LOOM_TOKEN missing in $AXEUH_LOOM_CREDENTIALS"
      return 1
    fi
    die 3 "LOOM_TOKEN missing in $AXEUH_LOOM_CREDENTIALS"
  fi
  log INFO "loom token resolved from file:${AXEUH_LOOM_CREDENTIALS} (value never logged)"
}

# ---------------------------------------------------------------------------
# HTTP（token 只走 stdin 的 curl 配置，永不进 argv / 日志）
# ---------------------------------------------------------------------------
api_call() { # <method> <path> [json_body] [max_time_s]
  # 结果放在全局 API_BODY / API_HTTP：不要用 $(...) 捕获，命令替换是子 shell，
  # API_HTTP 传不回父 shell。
  local method=$1
  local path=$2
  local body=${3:-}
  local max_time=${4:-$AXEUH_API_TIMEOUT_S}
  local out
  out=$(mktemp "${TMPDIR:-/tmp}/axeuh-api.XXXXXX")
  local args=(-sS --max-time "$max_time" -o "$out" -w '%{http_code}' -X "$method")
  if [[ "$AXEUH_API_INSECURE" == "1" ]]; then
    args+=(-k)
  fi
  if [[ -n "$body" ]]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  local code
  if [[ -n "${AXEUH_TOKEN:-}" ]]; then
    code=$(printf 'header = "Authorization: Bearer %s"\n' "$AXEUH_TOKEN" |
      curl "${args[@]}" -K - "${AXEUH_API_BASE}${path}" 2>/dev/null) || code="000"
  else
    code=$(curl "${args[@]}" "${AXEUH_API_BASE}${path}" 2>/dev/null) || code="000"
  fi
  API_HTTP=$code
  API_BODY=$(cat "$out" 2>/dev/null || true)
  rm -f "$out"
}

fetch_services() {
  api_call GET /api/services
  SERVICES_JSON=$API_BODY
  SERVICES_HTTP=$API_HTTP
  return 0
}

services_mode() {
  printf '%s' "${SERVICES_JSON:-}" |
    python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("orchestrator", ""))
except Exception:
    print("")' 2>/dev/null || true
}

svc_get() { # <id> <field> -> value（缺失输出空串）
  local id=$1
  local field=$2
  printf '%s' "${SERVICES_JSON:-}" |
    python3 -c 'import json,sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for entry in doc.get("services") or []:
    if entry.get("id") == sys.argv[1]:
        value = entry.get(sys.argv[2])
        print("" if value is None else value)
        break' "$id" "$field" 2>/dev/null || true
}

services_ids() {
  printf '%s' "${SERVICES_JSON:-}" |
    python3 -c 'import json,sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(1)
print(",".join(str(e.get("id")) for e in doc.get("services") or []))' 2>/dev/null || true
}

config_lookup() { # <dotted.key> -> 值（来自 GET /api/system/config 的有效配置）
  local key=$1
  printf '%s' "${CONFIG_JSON:-}" |
    python3 -c 'import json,sys
key = sys.argv[1]
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(1)
cur = doc.get("config") or {}
for part in key.split("."):
    if not isinstance(cur, dict) or part not in cur:
        print("")
        sys.exit(0)
    cur = cur[part]
if cur is None:
    print("")
elif isinstance(cur, bool):
    print("true" if cur else "false")
else:
    print(cur)' "$key" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# 服务状态 / 健康
# ---------------------------------------------------------------------------
wait_health() { # [timeout_s]
  local timeout=${1:-$AXEUH_HEALTH_TIMEOUT_S}
  local deadline=$(($(now_ms) + timeout * 1000))
  local body status
  while :; do
    api_call GET /health
    body=$API_BODY
    if [[ "$API_HTTP" == "200" ]]; then
      status=$(printf '%s' "$body" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("status", ""))
except Exception:
    print("")' 2>/dev/null || true)
      if [[ "$status" == "healthy" || "$status" == "ok" ]]; then
        log INFO "backend /health OK"
        return 0
      fi
    fi
    if (($(now_ms) >= deadline)); then
      log FAIL "backend /health did not recover within ${timeout}s (last HTTP=${API_HTTP})"
      return 1
    fi
    sleep 2
  done
}

wait_service_state() { # <id> <want> [timeout_s] [interval_s]
  local id=$1
  local want=$2
  local timeout=${3:-$AXEUH_SERVICE_READY_TIMEOUT_S}
  local interval=${4:-$AXEUH_POLL_INTERVAL_S}
  local deadline=$(($(now_ms) + timeout * 1000))
  local state=""
  while :; do
    if fetch_services && [[ "$SERVICES_HTTP" == "200" ]]; then
      state=$(svc_get "$id" state)
      if [[ "$state" == "$want" ]]; then
        log INFO "service ${id} -> ${want}"
        return 0
      fi
    fi
    if (($(now_ms) >= deadline)); then
      log FAIL "timeout waiting ${id}=${want} (last state=${state:-<none>}, HTTP=${SERVICES_HTTP:-?})"
      return 1
    fi
    sleep "$interval"
  done
}

unit_active() { systemctl is-active --quiet "$1" 2>/dev/null; }
unit_enabled() { systemctl is-enabled --quiet "$1" 2>/dev/null; }
unit_pid() { systemctl show -p MainPID --value "$1" 2>/dev/null || echo 0; }
unit_exec_start() { systemctl show -p ExecStart --value "$1" 2>/dev/null || true; }

assert_unit_active() {
  if unit_active "$1"; then
    log INFO "unit $1 is active"
  else
    pf_fail "unit $1 is NOT active"
  fi
}

assert_unit_inactive() {
  if unit_active "$1"; then
    pf_fail "unit $1 is still active (expected inactive)"
  else
    log INFO "unit $1 is inactive"
  fi
}

assert_unit_disabled() {
  if unit_enabled "$1"; then
    pf_fail "unit $1 is still enabled (expected disabled)"
  else
    log INFO "unit $1 is disabled"
  fi
}

assert_unit_enabled() {
  if unit_enabled "$1"; then
    log INFO "unit $1 is enabled"
  else
    pf_fail "unit $1 is NOT enabled"
  fi
}

loom_probe() { # Loom 自己的 /health（200 + status=ok）
  ensure_loom_token soft || return 1
  local out code status
  out=$(mktemp "${TMPDIR:-/tmp}/axeuh-loom-health.XXXXXX")
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$LOOM_TOKEN" |
    curl -sS --max-time 3 -o "$out" -w '%{http_code}' -K - "$AXEUH_LOOM_HEALTH_URL" 2>/dev/null) || code="000"
  status=""
  if [[ "$code" == "200" ]]; then
    status=$(python3 - "$out" <<'PY' 2>/dev/null || true
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        print(json.load(handle).get("status", ""))
except Exception:
    print("")
PY
)
  fi
  rm -f "$out"
  [[ "$code" == "200" && "$status" == "ok" ]]
}

wait_loom_health() { # [timeout_s]
  local timeout=${1:-120}
  if ! ensure_loom_token soft; then
    log WARN "loom health probe skipped: no LOOM_TOKEN"
    return 1
  fi
  local deadline=$(($(now_ms) + timeout * 1000))
  while :; do
    if loom_probe; then
      log INFO "loom /health OK"
      return 0
    fi
    if (($(now_ms) >= deadline)); then
      log FAIL "loom /health did not recover within ${timeout}s"
      return 1
    fi
    sleep 1
  done
}

# ---------------------------------------------------------------------------
# 运维闸门（pause / resume）
#   现状（HEAD 00bf308e）：T8 的 pause/resume 只有进程内 API，T9 只暴露
#   GET /api/services；生产进程内的单例无法被外部脚本调用。因此本库支持两种
#   驱动方式，默认 auto：
#     api     —— POST {gate_resume_path}（推荐；需要最小路由补丁，见 README）
#     restart —— 用 systemctl restart 重建进程（降级路径；会顺带重启内核）
# ---------------------------------------------------------------------------
gate_resume_path() { printf '%s' "${AXEUH_GATE_RESUME_PATH//%s/$1}"; }
gate_pause_path() { printf '%s' "${AXEUH_GATE_PAUSE_PATH//%s/$1}"; }

gate_probe() {
  local path
  path=$(gate_resume_path kernel)
  api_call GET "$path" >/dev/null
  case "$API_HTTP" in
    200 | 401 | 403 | 405) return 0 ;; # 路由存在（GET 不被允许 / 鉴权拒绝）
    404) return 1 ;;                   # 路由不存在
    *) return 2 ;;
  esac
}

resolve_gate_mode() {
  case "$AXEUH_GATE_MODE" in
    api)
      gate_probe && GATE_MODE_RESOLVED=api || die 7 "GATE_MODE=api but ${AXEUH_GATE_RESUME_PATH} is absent"
      ;;
    restart)
      GATE_MODE_RESOLVED=restart
      log WARN "GATE_MODE=restart: degraded path, resumes by restarting ${AXEUH_SERVICE}"
      ;;
    auto)
      if gate_probe; then
        GATE_MODE_RESOLVED=api
        log INFO "gate mode: api (${AXEUH_GATE_RESUME_PATH} present)"
      else
        log FAIL "gate mode: auto -> api route absent (HTTP=${API_HTTP})"
        log FAIL "blocked: stage3 needs pause/resume. Options:"
        log FAIL "  1) expose POST ${AXEUH_GATE_RESUME_PATH} (recommended; see README 'Operator gate')"
        log FAIL "  2) AXEUH_GATE_MODE=restart (degraded: restarts ${AXEUH_SERVICE}, may exceed the 60s window)"
        if ((PF_SOFT)); then
          GATE_MODE_RESOLVED=api
          return 0
        fi
        exit 7
      fi
      ;;
    *)
      die 2 "invalid AXEUH_GATE_MODE=$AXEUH_GATE_MODE (auto|api|restart)"
      ;;
  esac
  log INFO "gate mode resolved: ${GATE_MODE_RESOLVED}"
}

gate_resume() { # <service_id>
  local id=$1
  local path
  path=$(gate_resume_path "$id")
  log EXEC "POST ${path} (resume ${id})"
  api_call POST "$path" '{}' "$AXEUH_GATE_TIMEOUT_S" >/dev/null
  if [[ "$API_HTTP" != "200" ]]; then
    log FAIL "resume ${id} -> HTTP ${API_HTTP}"
    return 1
  fi
  log INFO "resume ${id} accepted (HTTP 200)"
}

gate_pause() { # <service_id>
  local id=$1
  local path
  path=$(gate_pause_path "$id")
  log EXEC "POST ${path} (pause ${id})"
  api_call POST "$path" '{}' "$AXEUH_GATE_TIMEOUT_S" >/dev/null
  if [[ "$API_HTTP" != "200" ]]; then
    log FAIL "pause ${id} -> HTTP ${API_HTTP}"
    return 1
  fi
  log INFO "pause ${id} accepted (HTTP 200)"
}

# ---------------------------------------------------------------------------
# Loom 停-接：唯一被允许触碰 Loom 的窗口
#   run_loom_handoff <stop_fn> <resume_fn> <health_fn> [gap_hook]
#   三个回调可注入（模拟器用假实现），真实脚本用：
#     stop   = loom_stop_systemd
#     resume = loom_resume_<mode>
#     health = wait_loom_health
#   gap_hook 仅测试用，模拟 stop 返回与 resume 发出之间被插入的工作。
#
#   两个指标不可混为一谈：
#     * HANDOFF_GAP  = stop 命令返回 -> resume 请求"发出"（命令行间隙，预期几百 ms）；
#     * LOOM_WINDOW  = stop 开始 -> Loom /health ok（用户不可用的服务就绪窗口）。
#   resume 是阻塞调用（gate API 内部等 Loom child healthy，实测 ~17s），
#   若把时间戳取在 resume 返回之后，服务就绪耗时会被误算进命令间隙。
# ---------------------------------------------------------------------------
run_loom_handoff() {
  local stop_fn=$1
  local resume_fn=$2
  local health_fn=$3
  local gap_hook=${4:-}
  local t0 t_stop t_resume t_resume_done

  t0=$(now_ms)
  "$stop_fn"
  t_stop=$(now_ms)
  if [[ -n "$gap_hook" ]]; then
    "$gap_hook"
  fi
  t_resume=$(now_ms)
  "$resume_fn"
  t_resume_done=$(now_ms)

  LOOM_STOP_MS=$((t_stop - t0))
  LOOM_HANDOFF_GAP_MS=$((t_resume - t_stop))
  LOOM_RESUME_MS=$((t_resume_done - t_resume))
  log INFO "loom unit stopped in ${LOOM_STOP_MS} ms"
  log INFO "handoff gap (stop returned -> resume issued): ${LOOM_HANDOFF_GAP_MS} ms"
  log INFO "resume call blocked for ${LOOM_RESUME_MS} ms (service-ready latency, excluded from gap)"

  "$health_fn" || {
    log FAIL "loom never became healthy inside the window"
    return 1
  }
  LOOM_WINDOW_MS=$(($(now_ms) - t0))
  log POST "LOOM_STOP_MS=${LOOM_STOP_MS} LOOM_HANDOFF_GAP_MS=${LOOM_HANDOFF_GAP_MS} LOOM_WINDOW_MS=${LOOM_WINDOW_MS}"

  assert_within_budget_ms "loom handoff gap" "$LOOM_HANDOFF_GAP_MS" "$LOOM_HANDOFF_GAP_BUDGET_MS" || return 1
  assert_within_budget_ms "loom stop->healthy window" "$LOOM_WINDOW_MS" "$LOOM_WINDOW_BUDGET_MS" || return 1
  log POST "loom handoff PASSED (<= ${LOOM_WINDOW_BUDGET_MS} ms)"
}

assert_within_budget_ms() { # <label> <elapsed_ms> <budget_ms>
  local label=$1
  local elapsed=$2
  local budget=$3
  log INFO "budget check ${label}: ${elapsed} ms / ${budget} ms"
  if ((elapsed > budget)); then
    log FAIL "BUDGET EXCEEDED ${label}: ${elapsed} ms > ${budget} ms"
    return 1
  fi
  log INFO "budget OK ${label}"
}

loom_stop_systemd() {
  run_sudo_timeout 120 systemctl disable --now "$AXEUH_LOOM_UNIT"
}

loom_resume_api() {
  gate_resume loom || die 8 "gate resume loom failed"
}

loom_resume_restart() {
  log WARN "restart mode: rebuilding ${AXEUH_SERVICE} to start the loom child (kernel cold start included)"
  run_sudo_timeout 240 systemctl restart "$AXEUH_SERVICE"
  wait_health || die 8 "backend did not recover after restart (loom handoff)"
}

# ---------------------------------------------------------------------------
# systemd 单元写操作（drop-in / unit 安装）
# ---------------------------------------------------------------------------
write_dropin() { # <off|on>
  local mode=$1
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/axeuh-dropin.XXXXXX")
  {
    echo "# managed by scripts/migrate-orchestrator — do not edit by hand"
    echo "[Service]"
    case "$mode" in
      off) echo "Environment=AXEUH_ORCHESTRATOR=off" ;;
      on)
        echo "Environment=AXEUH_ORCHESTRATOR=on"
        echo "Environment=AXEUH_LOOM_MODE=child"
        ;;
      *)
        rm -f "$tmp"
        die 2 "write_dropin: invalid mode $mode"
        ;;
    esac
  } >"$tmp"
  run_sudo install -D -m 0644 "$tmp" "$AXEUH_DROPIN"
  rm -f "$tmp"
  log POST "drop-in written: ${AXEUH_DROPIN} (AXEUH_ORCHESTRATOR=${mode})"
}

backup_dropin() {
  local tag=$1
  if sudo test -f "$AXEUH_DROPIN" 2>/dev/null; then
    mkdir -p "$AXEUH_STATE_DIR/backup"
    run_sudo cp -a "$AXEUH_DROPIN" "$AXEUH_STATE_DIR/backup/dropin-${tag}.conf"
    log INFO "backed up drop-in -> $AXEUH_STATE_DIR/backup/dropin-${tag}.conf"
    return 0
  fi
  log INFO "no drop-in to back up"
  return 1
}

backup_unit() { # sets UNIT_BACKUP_PATH（不要用 $(...) 捕获：日志也走 stdout）
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  mkdir -p "$AXEUH_STATE_DIR/backup"
  local target="$AXEUH_STATE_DIR/backup/${AXEUH_SERVICE}.service.${stamp}"
  run_sudo cp -a "/etc/systemd/system/${AXEUH_SERVICE}.service" "$target"
  printf '%s\n' "$target" >"$AXEUH_STATE_DIR/backup/latest-unit"
  UNIT_BACKUP_PATH=$target
  log POST "unit backed up -> ${target}"
}

# ---------------------------------------------------------------------------
# 数据只读快照与单调断言（绝不写 ai/data/**）
# ---------------------------------------------------------------------------
perception_line_count() {
  local file=$1
  if [[ ! -f "$file" ]]; then
    echo 0
    return 0
  fi
  wc -l <"$file" | tr -d ' '
}

snapshot_perception() { # <tag>
  local tag=$1
  local today
  today=$(date +%F)
  local today_file="$AXEUH_DATA_ROOT/daily/$today/perception.jsonl"
  local today_lines total_lines
  today_lines=$(perception_line_count "$today_file")
  total_lines=$(find "$AXEUH_DATA_ROOT/daily" -maxdepth 2 -name perception.jsonl -type f -print0 2>/dev/null |
    LC_ALL=C xargs -0 -r wc -l 2>/dev/null |
    awk '$2 != "total" { s += $1 } END { print s + 0 }')
  [[ -n "$total_lines" ]] || total_lines=0
  printf '%s\n' "$today_lines" >"$AXEUH_STATE_DIR/perception-today-${tag}"
  printf '%s\n' "$total_lines" >"$AXEUH_STATE_DIR/perception-total-${tag}"
  log INFO "perception[${tag}] today(${today})=${today_lines} total=${total_lines} (read-only)"
}

assert_perception_not_decreased() { # <tag>
  local tag=$1
  local last_file="$AXEUH_STATE_DIR/perception-total.last"
  [[ -f "$last_file" ]] || {
    log INFO "no previous perception snapshot (first stage)"
    return 0
  }
  local last now
  last=$(cat "$last_file")
  now=$(cat "$AXEUH_STATE_DIR/perception-total-${tag}")
  if ((now < last)); then
    pf_fail "perception total decreased: ${last} -> ${now}"
  else
    log INFO "perception monotonic: ${last} -> ${now}"
  fi
}

remember_perception() { # <tag>
  cp -f "$AXEUH_STATE_DIR/perception-total-${1}" "$AXEUH_STATE_DIR/perception-total.last"
}

# ---------------------------------------------------------------------------
# 内核 pidfile（只用于发现遗留内核，不自动杀）
# ---------------------------------------------------------------------------
kernel_pidfile_pid() {
  local pf=$AXEUH_KERNEL_PIDFILE
  [[ -f "$pf" ]] || {
    echo 0
    return 0
  }
  python3 - "$pf" <<'PY' 2>/dev/null || echo 0
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        print(int((json.load(handle) or {}).get("pid") or 0))
except Exception:
    print(0)
PY
}

check_kernel_orphan() {
  local pid
  pid=$(kernel_pidfile_pid)
  if [[ "$pid" == "0" ]]; then
    log INFO "kernel pidfile: absent or empty"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    log INFO "kernel pidfile pid=${pid} is not alive (stale file is expected and harmless)"
    return 0
  fi
  local parent parent_cmd
  parent=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  parent_cmd=$(tr '\0' ' ' <"/proc/${parent}/cmdline" 2>/dev/null || true)
  case "$parent_cmd" in
    *core.hot_server*)
      log INFO "kernel pid=${pid} is a child of backend pid=${parent} (owned, not an orphan)"
      return 0
      ;;
  esac
  local cmd
  cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
  log FAIL "kernel pidfile pid=${pid} is alive but NOT parented by core.hot_server"
  log FAIL "  pid=${pid} parent=${parent:-?} cmdline=${cmd}"
  log FAIL "the new backend refuses to adopt (stale_kernel_detected); stop it by exact PID:"
  log FAIL "  sudo kill ${pid}    # only after confirming the cmdline is axeuh_kernel"
  return 1
}

assert_loom_child_of_backend() {
  local loom_pid
  loom_pid=$(svc_get loom pid)
  [[ -n "$loom_pid" && "$loom_pid" != "0" ]] || {
    pf_fail "loom pid missing from /api/services"
    return 0
  }
  local parent
  parent=$(ps -o ppid= -p "$loom_pid" 2>/dev/null | tr -d ' ')
  [[ -n "$parent" ]] || {
    pf_fail "cannot read parent of loom pid ${loom_pid}"
    return 0
  }
  local cmd
  cmd=$(tr '\0' ' ' <"/proc/${parent}/cmdline" 2>/dev/null || true)
  case "$cmd" in
    *core.hot_server*)
      log POST "loom pid=${loom_pid} is a child of backend pid=${parent} (core.hot_server) OK"
      ;;
    *)
      pf_fail "loom pid=${loom_pid} parent=${parent} is not core.hot_server: ${cmd}"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# 观察窗（每 15s 复核一次，绝不跳过）
# ---------------------------------------------------------------------------
observe_window() { # <label> <seconds> <service...>
  local label=$1
  local seconds=$2
  shift 2
  local services=("$@")
  local total_ms=$((seconds * 1000))
  local start
  start=$(now_ms)
  local next_report=$((start + 60000))
  local next_perception=$((start + 60000))
  log INFO "observation '${label}' start: ${seconds}s over services: ${services[*]}"
  local now
  local consecutive_failures=0
  while :; do
    now=$(now_ms)
    if ((now - start >= total_ms)); then
      break
    fi

    if ! fetch_services || [[ "$SERVICES_HTTP" != "200" ]]; then
      consecutive_failures=$((consecutive_failures + 1))
      log WARN "observation '${label}': /api/services HTTP=${SERVICES_HTTP:-?} (attempt ${consecutive_failures}/3)"
      if ((consecutive_failures >= 3)); then
        log FAIL "observation '${label}': /api/services unreachable three times in a row"
        return 1
      fi
      sleep "$AXEUH_OBSERVE_POLL_INTERVAL_S"
      continue
    fi
    consecutive_failures=0
    local id state
    for id in "${services[@]}"; do
      state=$(svc_get "$id" state)
      if [[ "$state" != "ready" ]]; then
        log FAIL "observation '${label}': ${id} state=${state:-<none>} (expected ready)"
        log FAIL "detail=$(svc_get "$id" detail) reason=$(svc_get "$id" reason_code)"
        return 1
      fi
    done

    if ((now >= next_report)); then
      log INFO "observation '${label}': $(((now - start) / 1000))s / ${seconds}s — all ready"
      next_report=$((now + 60000))
    fi
    if ((now >= next_perception)); then
      local today_lines file
      file="$AXEUH_DATA_ROOT/daily/$(date +%F)/perception.jsonl"
      today_lines=$(perception_line_count "$file")
      local baseline_file="$AXEUH_STATE_DIR/observation-${label}.perception"
      if [[ ! -f "$baseline_file" ]]; then
        printf '%s\n' "$today_lines" >"$baseline_file"
      else
        local baseline
        baseline=$(cat "$baseline_file")
        if ((today_lines < baseline)); then
          log FAIL "observation '${label}': perception today decreased ${baseline} -> ${today_lines}"
          return 1
        fi
      fi
      next_perception=$((now + 60000))
    fi
    sleep "$AXEUH_OBSERVE_POLL_INTERVAL_S"
  done
  log INFO "observation '${label}' complete: ${seconds}s, services stayed ready"
}

# ---------------------------------------------------------------------------
# 通用前置检查
# ---------------------------------------------------------------------------
check_api_reachable() {
  local body
  api_call GET /health
  body=$API_BODY
  if [[ "$API_HTTP" != "200" ]]; then
    pf_fail "backend /health unreachable at ${AXEUH_API_BASE} (HTTP=${API_HTTP})"
    return 0
  fi
  log INFO "backend /health HTTP 200"
  local status
  status=$(printf '%s' "$body" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("status", ""))
except Exception:
    print("")' 2>/dev/null || true)
  [[ "$status" == "healthy" || "$status" == "ok" ]] || pf_fail "backend /health status=${status:-<empty>}"
}

load_services() {
  resolve_api_token
  fetch_services
  log INFO "/api/services HTTP=${SERVICES_HTTP} mode=$(services_mode) ids=$(services_ids)"
}

require_services_200() {
  if [[ "$SERVICES_HTTP" != "200" ]]; then
    pf_fail "/api/services expected 200, got ${SERVICES_HTTP} (new code deployed?)"
    return 0
  fi
}

allow_services_404() {
  case "$SERVICES_HTTP" in
    200) ;;
    404) log WARN "/api/services 404 — old code (expected before stage1)" ;;
    *) pf_fail "/api/services unexpected HTTP ${SERVICES_HTTP}" ;;
  esac
}

expect_orchestrator() { # <off|on>
  local want=$1
  [[ "$SERVICES_HTTP" == "200" ]] || {
    pf_fail "/api/services unavailable; cannot verify orchestrator=${want}"
    return 0
  }
  local got
  got=$(services_mode)
  if [[ "$got" == "$want" ]]; then
    log INFO "orchestrator=${got} (expected ${want})"
    return 0
  fi
  pf_fail "orchestrator=${got:-<empty>} (expected ${want})"
}

check_root_layout() {
  [[ -d "$AXEUH_ROOT" ]] || pf_fail "AXEUH_ROOT not found: $AXEUH_ROOT"
  [[ -d "$AXEUH_DATA_ROOT/daily" ]] || pf_fail "data root not found: $AXEUH_DATA_ROOT/daily"
  log INFO "root layout OK: ${AXEUH_ROOT}"
}

check_config_yaml() {
  [[ -r "$AXEUH_CONFIG_YAML" ]] || pf_fail "config.yaml not readable: $AXEUH_CONFIG_YAML"
}

check_unit_exists() {
  local state
  state=$(systemctl show -p LoadState --value "$1" 2>/dev/null || true)
  if [[ "$state" == "loaded" ]]; then
    log INFO "unit $1 present"
  else
    pf_fail "unit $1 not found (LoadState=${state:-<empty>})"
  fi
}

rollback_preflight() {
  # 回滚是恢复路径：后端不可达只 WARN，不阻断；本地前置（sudo/备份/数据根）仍硬校验。
  require_tools
  ensure_state_dir
  check_root_layout
  local body
  api_call GET /health
  body=$API_BODY
  if [[ "$API_HTTP" == "200" ]]; then
    log INFO "backend /health OK ($(printf '%s' "$body" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("status", ""))
except Exception:
    print("")' 2>/dev/null || true))"
  else
    log WARN "backend /health HTTP=${API_HTTP} — recovery path continues without it"
  fi
  load_services_soft || true
  snapshot_perception "before-${_stage}"
  assert_no_bulk_kill
  assert_no_ai_data_write
  ensure_sudo
}

load_services_soft() {
  if ! resolve_api_token soft; then
    log WARN "no api token; service-state assertions are skipped"
    return 1
  fi
  fetch_services
  if [[ "$SERVICES_HTTP" == "200" ]]; then
    log INFO "/api/services HTTP=200 mode=$(services_mode) ids=$(services_ids)"
    return 0
  fi
  log WARN "/api/services HTTP=${SERVICES_HTTP}; service-state assertions are skipped"
  return 1
}

# ---------------------------------------------------------------------------
# 凭据/安全自检（只读）
# ---------------------------------------------------------------------------
assert_no_bulk_kill() {
  # 运行期自证：本脚本目录不得出现按名杀（pkill/killall/taskkill）的命令调用。
  # 注释里出现这些词是允许的，所以只在"命令位"匹配（行首或 ; & | ( 之后）。
  local hit_lines
  hit_lines=$(grep -rnE '(^|[;&|(])[[:space:]]*(sudo[[:space:]]+)?(pkill|killall|taskkill)([[:space:]]|$)' \
    "$(dirname "${BASH_SOURCE[0]}")" --include='*.sh' 2>/dev/null | grep -v 'grep -rnE' || true)
  if [[ -n "$hit_lines" ]]; then
    log FAIL "forbidden bulk-kill usage found:"
    printf '%s\n' "$hit_lines" | tee -a "$_log_file"
    return 1
  fi
  log INFO "no pkill/killall/taskkill in migration scripts"
}

assert_no_ai_data_write() {
  # 运行期自证：迁移脚本不得出现写 ai/data 的重定向或 rm/mv/cp/tee。
  local hit_lines
  hit_lines=$(grep -rnE '(>|>>|\btee\b|(^|[[:space:]])(rm|mv|cp)[[:space:]])' \
    "$(dirname "${BASH_SOURCE[0]}")" --include='*.sh' 2>/dev/null |
    grep -F 'ai/data' | grep -v 'grep -rnE' | grep -vE ':[0-9]+:[[:space:]]*#' || true)
  if [[ -n "$hit_lines" ]]; then
    log FAIL "suspicious ai/data write pattern found:"
    printf '%s\n' "$hit_lines" | tee -a "$_log_file"
    return 1
  fi
  log INFO "no write pattern targeting ai/data/** in migration scripts"
}
