#!/usr/bin/env bash
# shellcheck shell=bash
# stage3.sh —— 编排器 ON，逐个接管；Loom 最后，停-接窗口硬预算 60s。
#
#   3.0  drop-in 改成 on + loom child，重启后端（启动瞬间：kernel/moss 由编排器拉起，
#        systemd Loom 仍占 5100，因此 loom child 必须失败在 port_in_use —— 这是"禁止双实例"
#        的正向证据，不是故障）
#   3.1  resume moss_watcher（已是 ready 时幂等）→ 观察 10 分钟
#   3.2  resume kernel（已在跑时无中断）→ 观察 10 分钟
#   3.3  最后：disable --now axeuh-loom 后立刻 resume loom，中间不得插入任何步骤；
#        实测 stop -> /health ok 必须 <= 60s → 观察 30 分钟
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
  cat <<'EOF'
stage3.sh — orchestrator ON, one-by-one takeover, Loom last (60s budget)

usage: stage3.sh [--dry-run] [--yes]

env:
  AXEUH_GATE_MODE     auto|api|restart (default auto: api if the route exists, else abort)
  AXEUH_OBSERVE_MOSS_S / AXEUH_OBSERVE_KERNEL_S / AXEUH_OBSERVE_LOOM_S (default 600/600/1800)
  AXEUH_API_TOKEN / AXEUH_LOOM_TOKEN
EOF
}

print_plan() {
  phase EXEC "stage3 command plan (dry structural review)"
  log INFO "3.0 drop-in -> AXEUH_ORCHESTRATOR=on + AXEUH_LOOM_MODE=child; daemon-reload; restart ${AXEUH_SERVICE}"
  log INFO "3.0 expect: kernel ready, moss_watcher ready, loom failed/port_in_use (systemd loom owns 5100)"
  log INFO "3.1 POST $(gate_resume_path moss_watcher); observe ${AXEUH_OBSERVE_MOSS_S}s"
  log INFO "3.2 POST $(gate_resume_path kernel); observe ${AXEUH_OBSERVE_KERNEL_S}s"
  log INFO "3.3 t0; systemctl disable --now ${AXEUH_LOOM_UNIT}; <resume loom: mode=${GATE_MODE_RESOLVED:-auto}>;"
  log INFO "3.3 measure t0 -> loom /health ok; assert <= ${LOOM_WINDOW_BUDGET_MS} ms; observe ${AXEUH_OBSERVE_LOOM_S}s"
}

require_moss_enabled() {
  local value=""
  api_call GET /api/system/config
  CONFIG_JSON=$API_BODY
  if [[ "$API_HTTP" == "200" ]]; then
    value=$(config_lookup moss.enabled)
    log INFO "effective config via API: moss.enabled=${value:-<empty>}"
  fi
  if [[ -z "$value" && -r "$AXEUH_CONFIG_YAML" ]]; then
    value=$(python3 - "$AXEUH_CONFIG_YAML" <<'PY' 2>/dev/null || true
import sys

try:
    import yaml
except Exception:
    sys.exit(0)
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        doc = yaml.safe_load(handle) or {}
except Exception:
    sys.exit(0)
node = doc
for part in ("moss", "enabled"):
    if not isinstance(node, dict) or part not in node:
        print("")
        sys.exit(0)
    node = node[part]
print("true" if node is True else "false" if node is False else str(node))
PY
)
    log INFO "config.yaml fallback: moss.enabled=${value:-<empty>}"
  fi
  if [[ "$value" != "true" ]]; then
    pf_fail "moss.enabled=${value:-<missing>}; set it true BEFORE stage3 (see README 1.2: set it while the old code is online, or edit config.yaml) — otherwise moss_watcher stays blocked/disabled"
  else
    log INFO "moss.enabled=true"
  fi
}

require_loom_config() {
  api_call GET /api/system/config
  CONFIG_JSON=$API_BODY
  if [[ "$API_HTTP" != "200" ]]; then
    pf_fail "cannot read /api/system/config (HTTP=${API_HTTP})"
    return 0
  fi
  [[ "$(config_lookup ai_backend)" == "loom" ]] ||
    pf_fail "ai_backend=$(config_lookup ai_backend) (expected loom)"
  local url
  url=$(config_lookup loom.url)
  case "$url" in
    http://127.0.0.1:* | http://localhost:*) log INFO "loom.url=${url} (loopback, child mode allowed)" ;;
    *) pf_fail "loom.url=${url} must be loopback for the child mode" ;;
  esac
  [[ -f "$AXEUH_ROOT/loom-harness/packages/server/dist/cli.js" ]] ||
    pf_fail "loom-harness dist missing: packages/server/dist/cli.js"
  command -v node >/dev/null 2>&1 || pf_fail "node missing (loom child needs it)"
  [[ -f "$AXEUH_ROOT/ai/.loom/config.yaml" ]] ||
    pf_fail "managed loom config missing: ai/.loom/config.yaml"
}

assert_loom_not_double() {
  local state detail
  state=$(svc_get loom state)
  detail=$(svc_get loom detail)
  if [[ "$state" == "ready" || "$state" == "starting" ]]; then
    log FAIL "loom state=${state} while systemd ${AXEUH_LOOM_UNIT} was still active — DOUBLE INSTANCE RISK"
    log FAIL "abort now: scripts/migrate-orchestrator/rollback-stage3.sh --yes"
    return 1
  fi
  case "$detail" in
    *port_in_use*)
      log POST "loom failed with port_in_use (expected: systemd Loom owns 5100; no double instance)"
      return 0
      ;;
    *)
      log FAIL "loom state=${state} detail=${detail} (expected failed/port_in_use)"
      return 1
      ;;
  esac
}

preflight_stage3() {
  require_tools
  ensure_state_dir
  check_root_layout
  check_api_reachable
  load_services
  require_services_200 || pf_fail "/api/services 200 required (stage1 must be done)"
  expect_orchestrator off || pf_fail "stage1 not complete: orchestrator must be off"
  assert_unit_inactive "$AXEUH_MOSS_UNIT"
  assert_unit_disabled "$AXEUH_MOSS_UNIT"
  assert_unit_active "$AXEUH_LOOM_UNIT"
  require_loom_config
  require_moss_enabled
  ensure_loom_token
  if loom_probe; then
    log INFO "systemd Loom answers on ${AXEUH_LOOM_HEALTH_URL} (owns the port)"
  else
    pf_fail "systemd Loom is not healthy on ${AXEUH_LOOM_HEALTH_URL}; fix it before the handoff"
  fi
  check_kernel_orphan || pf_fail "kernel pidfile points to a live process before stage3"
  local exec_start
  exec_start=$(unit_exec_start "$AXEUH_SERVICE")
  case "$exec_start" in
    *core.hot_server*) log WARN "ExecStart already core.hot_server (stage4 done?) — stage3 expects stage1/stage2 state" ;;
    *launcher.py*) log INFO "ExecStart=launcher.py (expected before stage4)" ;;
    *) log WARN "unexpected ExecStart: ${exec_start}" ;;
  esac
  resolve_gate_mode
  if [[ "$GATE_MODE_RESOLVED" == "restart" ]]; then
    log WARN "restart mode: 3.3 includes a backend restart + kernel cold start; the 60s window is at risk"
  fi
  snapshot_perception "before-${_stage}"
  assert_perception_not_decreased "before-${_stage}"
  assert_no_bulk_kill
  assert_no_ai_data_write
}

takeover_boot() {
  ensure_sudo
  backup_dropin "stage3" || true
  write_dropin on
  run_sudo_timeout 60 systemctl daemon-reload
  run_sudo_timeout 240 systemctl restart "$AXEUH_SERVICE"
  wait_health || die 30 "backend did not recover after the orchestrator-on restart"
  load_services
  require_services_200 || die 30 "/api/services unavailable after restart"
  expect_orchestrator on || die 30 "orchestrator must be on after the stage3 restart"
  log POST "services at boot: $(services_ids)"
  local kernel_detail
  kernel_detail=$(svc_get kernel detail)
  case "$kernel_detail" in
    *stale_kernel_detected* | *pidfile_corrupt*)
      die 31 "kernel refused to start: ${kernel_detail} (stop the pidfile PID by exact PID, then re-run stage3)"
      ;;
  esac
  wait_service_state kernel ready 300 5 || die 31 "kernel did not become ready"
  wait_service_state moss_watcher ready 180 5 || die 32 "moss_watcher did not become ready"
  assert_loom_not_double || die 33 "loom double-instance guard"
}

takeover_moss() {
  phase EXEC "3.1 resume moss_watcher and observe"
  gate_resume moss_watcher || die 34 "resume moss_watcher failed"
  wait_service_state moss_watcher ready 120 2 || die 34 "moss_watcher not ready after resume"
  observe_window moss "$AXEUH_OBSERVE_MOSS_S" kernel moss_watcher || die 35 "moss observation failed"
}

takeover_kernel() {
  phase EXEC "3.2 resume kernel and observe"
  gate_resume kernel || die 36 "resume kernel failed"
  wait_service_state kernel ready 300 2 || die 36 "kernel not ready after resume"
  observe_window kernel "$AXEUH_OBSERVE_KERNEL_S" kernel moss_watcher || die 37 "kernel observation failed"
}

handoff_loom() {
  phase EXEC "3.3 LOOM HANDOFF: stop unit -> resume child (nothing in between)"
  local resume_fn=loom_resume_api
  if [[ "$GATE_MODE_RESOLVED" == "restart" ]]; then
    resume_fn=loom_resume_restart
  fi
  run_loom_handoff loom_stop_systemd "$resume_fn" wait_loom_health ||
    die 38 "loom handoff exceeded the budget or never became healthy"
  wait_service_state loom ready 180 2 || die 39 "loom child never reached orchestrator state=ready"
  assert_loom_child_of_backend || die 40 "loom child is not parented by the backend"
  printf 'window_ms=%s\ngap_ms=%s\nstop_ms=%s\nmode=%s\n' \
    "$LOOM_WINDOW_MS" "$LOOM_HANDOFF_GAP_MS" "$LOOM_STOP_MS" "$GATE_MODE_RESOLVED" \
    >"$AXEUH_STATE_DIR/loom-window.txt"
  log POST "loom window recorded: $AXEUH_STATE_DIR/loom-window.txt"
  observe_window loom "$AXEUH_OBSERVE_LOOM_S" kernel moss_watcher loom || die 41 "loom observation failed"
}

post_stage3() {
  load_services
  require_services_200 || die 42 "/api/services lost at the end of stage3"
  expect_orchestrator on || die 42 "orchestrator must be on at the end of stage3"
  local id
  for id in kernel moss_watcher loom; do
    if [[ "$(svc_get "$id" state)" == "ready" ]]; then
      log POST "service ${id} ready pid=$(svc_get "$id" pid)"
    else
      die 43 "service ${id} state=$(svc_get "$id" state) at the end of stage3"
    fi
  done
  assert_unit_inactive "$AXEUH_LOOM_UNIT" || die 44 "Loom unit must be inactive (child owns 5100 now)"
  assert_unit_disabled "$AXEUH_LOOM_UNIT" || die 44 "Loom unit must be disabled"
  assert_unit_inactive "$AXEUH_MOSS_UNIT" || die 44 "MOSS unit must be inactive"
  snapshot_perception "after-${_stage}"
  assert_perception_not_decreased "after-${_stage}" || die 45 "perception lines decreased"
  remember_perception "after-${_stage}"
  log POST "LOOM_WINDOW_MS=${LOOM_WINDOW_MS} (budget ${LOOM_WINDOW_BUDGET_MS})"
}

main() {
  log_init stage3
  init_traps
  parse_cli "$@"
  phase PRE "stage3: orchestrator ON, one-by-one takeover"
  PF_SOFT=$OPT_DRY
  preflight_stage3
  if ((OPT_DRY)); then
    print_plan
    phase POST "dry-run only: no mutation, no restart, no Loom touch"
    exit 0
  fi
  require_yes
  phase EXEC "3.0 orchestrator-on restart (kernel/moss taken over; loom blocked by port)"
  takeover_boot
  takeover_moss
  takeover_kernel
  handoff_loom
  phase POST "stage3: final verification"
  post_stage3
  log POST "stage3 PASSED — kernel/moss_watcher/loom are orchestrator children; loom window=${LOOM_WINDOW_MS}ms"
  log POST "next: stage4.sh (ExecStart -> core.hot_server)"
}

main "$@"
