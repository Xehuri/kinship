#!/usr/bin/env bash
# shellcheck shell=bash
# sim-stage3-window.sh —— 60s 预算逻辑的离线仿真：
#   * 不调用 systemd、不调用 curl、不碰生产；
#   * 用 AXEUH_TEST_NOW_FILE 假时钟 + 注入的 stop/resume/health 回调；
#   * 直接复用 stage3 真正调用的 run_loom_handoff / wait_service_state / assert_within_budget_ms。
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
LIB="$HERE/../lib.sh"
[[ -f "$LIB" ]] || {
  echo "lib.sh not found: $LIB" >&2
  exit 2
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/sim-stage3.XXXXXX")
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

export AXEUH_STATE_DIR="$TMP/state"
export AXEUH_TEST_NOW_FILE="$TMP/clock"
printf '1000000' >"$AXEUH_TEST_NOW_FILE"

# shellcheck source=../lib.sh
source "$LIB"

log_init sim-stage3
log INFO "simulation root: $TMP"

PASS=0
FAIL=0
ok() {
  printf 'SIM PASS  %s\n' "$*" | tee -a "$_log_file"
  PASS=$((PASS + 1))
}
ng() {
  printf 'SIM FAIL  %s\n' "$*" | tee -a "$_log_file"
  FAIL=$((FAIL + 1))
}

clock_add() {
  local delta=$1
  local now
  now=$(cat "$AXEUH_TEST_NOW_FILE")
  printf '%s' "$((now + delta))" >"$AXEUH_TEST_NOW_FILE"
}

reset_clock() { printf '1000000' >"$AXEUH_TEST_NOW_FILE"; }

fake_stop() { clock_add "${FAKE_STOP_MS:-5000}"; }
fake_gap() { clock_add "${FAKE_GAP_MS:-0}"; }
fake_resume() { clock_add "${FAKE_RESUME_MS:-50}"; }
fake_health_ok() {
  clock_add "${FAKE_HEALTH_MS:-12000}"
  return 0
}
fake_health_never() {
  clock_add "${FAKE_HEALTH_MS:-70000}"
  return 1
}

expect_handoff_ok() {
  local label=$1 stop=$2 gap=$3 resume=$4 health=$5
  reset_clock
  FAKE_STOP_MS=$stop FAKE_GAP_MS=$gap FAKE_RESUME_MS=$resume FAKE_HEALTH_MS=$health
  if run_loom_handoff fake_stop fake_resume fake_health_ok fake_gap >/dev/null 2>&1; then
    ok "${label}: window=${LOOM_WINDOW_MS}ms gap=${LOOM_HANDOFF_GAP_MS}ms resume=${LOOM_RESUME_MS}ms (accepted)"
  else
    ng "${label}: window=${LOOM_WINDOW_MS:-?}ms gap=${LOOM_HANDOFF_GAP_MS:-?}ms (unexpected rejection)"
  fi
}

expect_handoff_fail() {
  local label=$1 stop=$2 gap=$3 resume=$4 health=$5
  reset_clock
  FAKE_STOP_MS=$stop FAKE_GAP_MS=$gap FAKE_RESUME_MS=$resume FAKE_HEALTH_MS=$health
  if run_loom_handoff fake_stop fake_resume fake_health_ok fake_gap >/dev/null 2>&1; then
    ng "${label}: window=${LOOM_WINDOW_MS}ms should have been rejected"
  else
    ok "${label}: rejected (window=${LOOM_WINDOW_MS:-?}ms gap=${LOOM_HANDOFF_GAP_MS:-?}ms)"
  fi
}

# --- 1) F4 实跑形态：6s stop + 0.2s gap + 17.1s 阻塞 resume + 12s health ------
#      阻塞 resume 不得计入 gap（gap 只有 200ms），window 仍在 60s 内。
expect_handoff_ok "F4 shape (resume blocks 17.1s, gap 200ms)" 6000 200 17123 12000

# --- 2) 恰好 60s 边界：50s stop + 10s health = 60.0s（> 才算失败） ----------
expect_handoff_ok "boundary 60000ms" 50000 0 0 10000

# --- 3) 超预算：15s stop + 46s health = 61s --------------------------------
expect_handoff_fail "over budget 61s" 15000 0 50 46000

# --- 4) handoff gap 超预算（stop 与 resume 之间插入别的步骤） ----------------
expect_handoff_fail "gap 8s" 5000 8000 0 12000

# --- 5) loom 永不健康 -------------------------------------------------------
reset_clock
if run_loom_handoff fake_stop fake_resume fake_health_never fake_gap >/dev/null 2>&1; then
  ng "health never ok: should have been rejected"
else
  ok "health never ok: rejected"
fi

# --- 6) wait_service_state：starting -> ready，假时钟 2s/次 -----------------
FAKE_STATE=starting
POLLS=0
fetch_services() {
  SERVICES_HTTP=200
  POLLS=$((POLLS + 1))
  clock_add 2000
  if ((POLLS >= 3)); then FAKE_STATE=ready; fi
}
svc_get() { printf '%s' "$FAKE_STATE"; }
reset_clock
if wait_service_state loom ready 60 0.01 >/dev/null 2>&1; then
  ok "wait_service_state: reached ready after ${POLLS} polls"
else
  ng "wait_service_state: did not reach ready"
fi

# --- 7) wait_service_state 超时 --------------------------------------------
FAKE_STATE=failed
POLLS=0
if wait_service_state loom ready 1 0.01 >/dev/null 2>&1; then
  ng "wait_service_state: timeout case returned success"
else
  ok "wait_service_state: timeout reported as failure"
fi

# --- 8) 默认时钟（无假时钟）也能工作 --------------------------------------
unset AXEUH_TEST_NOW_FILE
T0=$(now_ms)
T1=$(now_ms)
if [[ "$T1" =~ ^[0-9]+$ ]] && ((T1 >= T0)); then
  ok "real clock fallback: ${T0} -> ${T1}"
else
  ng "real clock fallback broken: ${T0} -> ${T1}"
fi

printf '\nSIM SUMMARY: pass=%d fail=%d\n' "$PASS" "$FAIL" | tee -a "$_log_file"
((FAIL == 0))
