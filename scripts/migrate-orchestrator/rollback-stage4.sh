#!/usr/bin/env bash
# shellcheck shell=bash
# rollback-stage4.sh —— 恢复 stage4 之前的 unit 与 drop-in（回到 stage3 状态：
# launcher + AXEUH_ORCHESTRATOR=on，kernel/moss_watcher/loom 仍是编排器子进程）。
#
# 注意：本脚本不 enable axeuh-loom / axeuh-moss-watch。stage3 状态下它们是 disable 的，
# 提前 enable 会与编排器子进程形成双实例。要回到"迁移前拓扑"（systemd 管 Loom/MOSS、
# 编排器 off），在 rollback-stage4 之后继续跑 rollback-stage3.sh。
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
  cat <<'EOF'
rollback-stage4.sh — restore the pre-stage4 unit + drop-in and restart

usage: rollback-stage4.sh [--dry-run] [--yes]
EOF
}

unit_backup_path() {
  local recorded="$AXEUH_STATE_DIR/backup/stage4-unit-backup"
  if [[ -f "$recorded" ]]; then
    head -n 1 "$recorded"
    return 0
  fi
  if [[ -f "$AXEUH_STATE_DIR/backup/latest-unit" ]]; then
    head -n 1 "$AXEUH_STATE_DIR/backup/latest-unit"
    return 0
  fi
  return 1
}

print_plan() {
  phase EXEC "rollback-stage4 command plan (dry structural review)"
  log INFO "1. restore unit from $(unit_backup_path 2>/dev/null || echo '<missing backup>')"
  log INFO "2. restore drop-in from $AXEUH_STATE_DIR/backup/dropin-stage4.conf (if present)"
  log INFO "3. systemctl daemon-reload; systemctl restart ${AXEUH_SERVICE}"
  log INFO "4. assert /health 200; /api/services on; kernel/moss_watcher/loom ready"
  log INFO "5. units ${AXEUH_LOOM_UNIT}/${AXEUH_MOSS_UNIT} stay disabled (run rollback-stage3.sh for pre-migration topology)"
}

preflight_rollback4() {
  rollback_preflight
  local backup
  if backup=$(unit_backup_path); then
    [[ -f "$backup" ]] || pf_fail "unit backup recorded but missing: ${backup}"
    log INFO "unit backup: ${backup}"
  else
    pf_fail "no unit backup found (stage4 never ran?); cannot restore"
  fi
  [[ -f "$AXEUH_STATE_DIR/backup/dropin-stage4.conf" ]] ||
    log WARN "no drop-in backup; the restored unit runs without the migration drop-in"
}

execute_rollback4() {
  local backup
  backup=$(unit_backup_path) || die 60 "no unit backup"
  run_sudo install -m 0644 "$backup" "/etc/systemd/system/${AXEUH_SERVICE}.service"
  log POST "unit restored from ${backup}"
  if [[ -f "$AXEUH_STATE_DIR/backup/dropin-stage4.conf" ]]; then
    run_sudo install -D -m 0644 "$AXEUH_STATE_DIR/backup/dropin-stage4.conf" "$AXEUH_DROPIN"
    log POST "drop-in restored: ${AXEUH_DROPIN}"
  fi
  run_sudo_timeout 60 systemctl daemon-reload
  run_sudo_timeout 240 systemctl restart "$AXEUH_SERVICE"
  wait_health || die 61 "backend did not recover after rollback-stage4"
}

post_rollback4() {
  log POST "ExecStart now: $(unit_exec_start "$AXEUH_SERVICE")"
  if load_services_soft; then
    expect_orchestrator on || die 62 "orchestrator must be on in the stage3 state"
    local id
    for id in kernel moss_watcher loom; do
      wait_service_state "$id" ready 180 5 || die 63 "${id} not ready after rollback-stage4"
    done
    assert_loom_child_of_backend || die 64 "loom is not a child of the backend"
  fi
  assert_unit_inactive "$AXEUH_LOOM_UNIT" || log WARN "Loom unit active; expected inactive in stage3 state"
  snapshot_perception "after-${_stage}"
  assert_perception_not_decreased "after-${_stage}" || die 65 "perception lines decreased"
  remember_perception "after-${_stage}"
}

main() {
  log_init rollback-stage4
  init_traps
  parse_cli "$@"
  phase PRE "rollback-stage4: restore pre-stage4 unit"
  PF_SOFT=$OPT_DRY
  preflight_rollback4
  if ((OPT_DRY)); then
    print_plan
    phase POST "dry-run only: no mutation"
    exit 0
  fi
  require_yes
  phase EXEC "rollback-stage4: restore unit + drop-in, restart"
  execute_rollback4
  phase POST "rollback-stage4: verify"
  post_rollback4
  log POST "rollback-stage4 PASSED — back to the stage3 state"
}

main "$@"
