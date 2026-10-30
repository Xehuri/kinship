#!/usr/bin/env bash
# shellcheck shell=bash
# rollback-stage2.sh —— 恢复 MOSS 旁路单元：systemctl enable --now axeuh-moss-watch。
# Loom 不碰。
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
  cat <<'EOF'
rollback-stage2.sh — re-enable axeuh-moss-watch (Loom untouched)

usage: rollback-stage2.sh [--dry-run] [--yes]
EOF
}

print_plan() {
  phase EXEC "rollback-stage2 command plan (dry structural review)"
  log INFO "1. systemctl enable --now ${AXEUH_MOSS_UNIT}   (timeout 120s)"
  log INFO "2. assert active + enabled; assert ${AXEUH_LOOM_UNIT} still active"
  log INFO "3. assert /health 200"
}

preflight_rollback2() {
  rollback_preflight
  check_unit_exists "$AXEUH_MOSS_UNIT"
  check_unit_exists "$AXEUH_LOOM_UNIT"
  local stray managed
  managed=$(systemctl show -p MainPID --value "$AXEUH_MOSS_UNIT" 2>/dev/null || echo 0)
  [[ -n "$managed" ]] || managed=0
  stray=$(ps -eo pid=,args= 2>/dev/null | grep -F 'moss-shadow/watcher.py' | grep -v grep |
    awk -v managed="$managed" '$1 != managed { print $1 }' | tr '\n' ' ' || true)
  if [[ -n "${stray% }" ]]; then
    pf_fail "a MOSS watcher is already running (pids: ${stray% }); enabling the unit would double-run"
  else
    log INFO "no stray MOSS watcher"
  fi
}

execute_rollback2() {
  run_sudo_timeout 120 systemctl enable --now "$AXEUH_MOSS_UNIT"
}

post_rollback2() {
  assert_unit_active "$AXEUH_MOSS_UNIT" || die 80 "MOSS unit is not active after rollback-stage2"
  assert_unit_enabled "$AXEUH_MOSS_UNIT" || die 80 "MOSS unit is not enabled after rollback-stage2"
  assert_unit_active "$AXEUH_LOOM_UNIT" || die 81 "Loom unit must stay active (untouched)"
  if load_services_soft; then
    log INFO "orchestrator mode: $(services_mode)"
  fi
  snapshot_perception "after-${_stage}"
  assert_perception_not_decreased "after-${_stage}" || die 82 "perception lines decreased"
  remember_perception "after-${_stage}"
}

main() {
  log_init rollback-stage2
  init_traps
  parse_cli "$@"
  phase PRE "rollback-stage2: re-enable MOSS sidecar"
  PF_SOFT=$OPT_DRY
  preflight_rollback2
  if ((OPT_DRY)); then
    print_plan
    phase POST "dry-run only: no mutation"
    exit 0
  fi
  require_yes
  phase EXEC "rollback-stage2: enable --now ${AXEUH_MOSS_UNIT}"
  execute_rollback2
  phase POST "rollback-stage2: verify"
  post_rollback2
  log POST "rollback-stage2 PASSED — MOSS watcher back under systemd"
}

main "$@"
