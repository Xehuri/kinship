#!/usr/bin/env bash
# shellcheck shell=bash
# stage4.sh —— 把 systemd 的 ExecStart 从 launcher.py 切到 core.hot_server（任务 25 的 unit），
# 移除 stage1/3 的迁移 drop-in，daemon-reload + restart。
#
# 前置：stage3 已完成（orchestrator=on，kernel/moss_watcher/loom 全 ready，Loom/MOSS 单元已停用）。
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
  cat <<'EOF'
stage4.sh — switch the unit to ExecStart=core.hot_server and restart

usage: stage4.sh [--dry-run] [--yes]

env:
  AXEUH_ROOT / AXEUH_API_TOKEN (see stage1.sh)
EOF
}

print_plan() {
  phase EXEC "stage4 command plan (dry structural review)"
  log INFO "1. backup /etc/systemd/system/${AXEUH_SERVICE}.service and ${AXEUH_DROPIN}"
  log INFO "2. install -m0644 ${AXEUH_ROOT}/deploy/axeuh-health.service /etc/systemd/system/${AXEUH_SERVICE}.service"
  log INFO "3. rm -f ${AXEUH_DROPIN} (unit already carries AXEUH_ORCHESTRATOR=on + AXEUH_LOOM_MODE=child)"
  log INFO "4. systemctl daemon-reload"
  log INFO "5. systemctl restart ${AXEUH_SERVICE} (timeout 240s)"
  log INFO "6. assert ExecStart contains core.hot_server; /api/services on; kernel/moss_watcher/loom ready"
  log INFO "7. assert loom pid ppid == unit MainPID (backend); units ${AXEUH_LOOM_UNIT}/${AXEUH_MOSS_UNIT} inactive"
}

require_all_ready() {
  local id missing=0
  for id in kernel moss_watcher loom; do
    if [[ "$(svc_get "$id" state)" == "ready" ]]; then
      log INFO "service ${id} ready pid=$(svc_get "$id" pid)"
    else
      pf_fail "service ${id} state=$(svc_get "$id" state) detail=$(svc_get "$id" detail)"
      missing=1
    fi
  done
  ((missing == 0)) || pf_fail "stage3 must leave kernel/moss_watcher/loom ready before stage4"
}

preflight_stage4() {
  require_tools
  ensure_state_dir
  check_root_layout
  check_api_reachable
  load_services
  require_services_200 || pf_fail "/api/services 200 required (stage3 must be done)"
  expect_orchestrator on || pf_fail "stage3 not complete: orchestrator must be on"
  require_all_ready
  check_unit_exists "$AXEUH_SERVICE"
  local exec_start
  exec_start=$(unit_exec_start "$AXEUH_SERVICE")
  case "$exec_start" in
    *core.hot_server*) log WARN "ExecStart already core.hot_server (stage4 re-run?)" ;;
    *launcher.py*) log INFO "ExecStart=launcher.py (pre-stage4 state confirmed)" ;;
    *) pf_fail "unexpected ExecStart: ${exec_start}" ;;
  esac
  [[ -f "$AXEUH_ROOT/deploy/axeuh-health.service" ]] ||
    pf_fail "deploy/axeuh-health.service missing"
  grep -q 'ExecStart=.*core\.hot_server' "$AXEUH_ROOT/deploy/axeuh-health.service" 2>/dev/null ||
    pf_fail "deploy unit does not exec core.hot_server"
  grep -q 'AXEUH_ORCHESTRATOR=on' "$AXEUH_ROOT/deploy/axeuh-health.service" 2>/dev/null ||
    pf_fail "deploy unit is missing AXEUH_ORCHESTRATOR=on"
  check_kernel_orphan || pf_fail "kernel pidfile points to a foreign process before stage4"
  snapshot_perception "before-${_stage}"
  assert_perception_not_decreased "before-${_stage}"
  assert_no_bulk_kill
  assert_no_ai_data_write
}

execute_stage4() {
  ensure_sudo
  backup_unit
  printf '%s\n' "$UNIT_BACKUP_PATH" >"$AXEUH_STATE_DIR/backup/stage4-unit-backup"
  backup_dropin "stage4" || true
  run_sudo install -m 0644 "$AXEUH_ROOT/deploy/axeuh-health.service" \
    "/etc/systemd/system/${AXEUH_SERVICE}.service"
  if sudo test -f "$AXEUH_DROPIN" 2>/dev/null; then
    run_sudo rm -f "$AXEUH_DROPIN"
    log POST "removed migration drop-in ${AXEUH_DROPIN}"
  fi
  run_sudo_timeout 60 systemctl daemon-reload
  run_sudo_timeout 240 systemctl restart "$AXEUH_SERVICE"
  wait_health || die 50 "backend did not recover after the stage4 restart"
}

post_stage4() {
  local exec_start
  exec_start=$(unit_exec_start "$AXEUH_SERVICE")
  case "$exec_start" in
    *core.hot_server*) log POST "ExecStart is core.hot_server" ;;
    *) die 51 "ExecStart was not switched: ${exec_start}" ;;
  esac
  load_services
  require_services_200 || die 52 "/api/services unavailable after stage4"
  expect_orchestrator on || die 52 "orchestrator must be on after stage4"
  wait_service_state kernel ready 300 5 || die 53 "kernel not ready after stage4"
  wait_service_state moss_watcher ready 180 5 || die 53 "moss_watcher not ready after stage4"
  wait_service_state loom ready 180 5 || die 53 "loom not ready after stage4"
  assert_loom_child_of_backend || die 54 "loom is not a child of the backend"
  local main_pid loom_pid loom_parent
  main_pid=$(unit_pid "$AXEUH_SERVICE")
  loom_pid=$(svc_get loom pid)
  loom_parent=$(ps -o ppid= -p "$loom_pid" 2>/dev/null | tr -d ' ')
  if [[ "$loom_parent" == "$main_pid" ]]; then
    log POST "loom pid=${loom_pid} is a direct child of unit MainPID=${main_pid}"
  else
    log WARN "loom parent=${loom_parent} unit MainPID=${main_pid} (launcher-less unit should make them equal)"
  fi
  assert_unit_inactive "$AXEUH_LOOM_UNIT" || die 55 "Loom unit must stay inactive after stage4"
  assert_unit_inactive "$AXEUH_MOSS_UNIT" || die 55 "MOSS unit must stay inactive after stage4"
  check_kernel_orphan || die 56 "kernel pidfile points to a foreign process after stage4"
  snapshot_perception "after-${_stage}"
  assert_perception_not_decreased "after-${_stage}" || die 57 "perception lines decreased"
  remember_perception "after-${_stage}"
}

main() {
  log_init stage4
  init_traps
  parse_cli "$@"
  phase PRE "stage4: ExecStart -> core.hot_server"
  PF_SOFT=$OPT_DRY
  preflight_stage4
  if ((OPT_DRY)); then
    print_plan
    phase POST "dry-run only: no mutation"
    exit 0
  fi
  require_yes
  phase EXEC "stage4: install unit, drop the drop-in, restart"
  execute_stage4
  phase POST "stage4: verify direct hot_server and managed children"
  post_stage4
  log POST "stage4 PASSED — ${AXEUH_SERVICE} runs core.hot_server directly; all services are children"
  log POST "migration complete. Keep the observation log; run F1-F5 verification next."
}

main "$@"
