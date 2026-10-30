#!/usr/bin/env bash
# shellcheck shell=bash
# stage2.sh —— 只停 MOSS 旁路单元（axeuh-moss-watch）。Loom 不动。
#
# 动机：moss_watcher 是纯 sidecar（只写 audio_deepdive.jsonl），停多久都不影响主链；
# 先把它从 systemd 摘下来，stage3 的编排器启动时才不会出现"双 watcher"重复消费。
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
  cat <<'EOF'
stage2.sh — stop the pure sidecar axeuh-moss-watch (Loom untouched)

usage: stage2.sh [--dry-run] [--yes]

env:
  AXEUH_ROOT / AXEUH_API_TOKEN (see stage1.sh)
EOF
}

print_plan() {
  phase EXEC "stage2 command plan (dry structural review)"
  log INFO "1. systemctl disable --now ${AXEUH_MOSS_UNIT}   (timeout 120s)"
  log INFO "2. assert ${AXEUH_MOSS_UNIT} inactive + disabled"
  log INFO "3. assert ${AXEUH_LOOM_UNIT} still active (never touched here)"
  log INFO "4. assert /health 200 and /api/services orchestrator=off"
  log INFO "5. perception monotonic"
}

stray_watchers() {
  local managed pids
  managed=$(systemctl show -p MainPID --value "$AXEUH_MOSS_UNIT" 2>/dev/null || echo 0)
  [[ -n "$managed" ]] || managed=0
  pids=$(ps -eo pid=,args= 2>/dev/null | grep -F 'moss-shadow/watcher.py' | grep -v grep |
    awk -v managed="$managed" '$1 != managed { print $1 }' | tr '\n' ' ' || true)
  printf '%s' "${pids% }"
}

preflight_stage2() {
  require_tools
  ensure_state_dir
  check_root_layout
  check_api_reachable
  load_services
  require_services_200 || pf_fail "/api/services 200 required (stage1 must be done)"
  expect_orchestrator off || pf_fail "stage1 not complete: orchestrator must be off"
  check_unit_exists "$AXEUH_MOSS_UNIT"
  if unit_active "$AXEUH_MOSS_UNIT"; then
    log INFO "unit ${AXEUH_MOSS_UNIT} is active"
  else
    log WARN "unit ${AXEUH_MOSS_UNIT} already inactive (stage2 re-run?) — continuing"
  fi
  assert_unit_active "$AXEUH_LOOM_UNIT"
  local stray
  stray=$(stray_watchers)
  if [[ -n "$stray" ]]; then
    pf_fail "stray MOSS watcher already running outside systemd (pids: ${stray})"
  else
    log INFO "no stray MOSS watcher"
  fi
  snapshot_perception "before-${_stage}"
  assert_perception_not_decreased "before-${_stage}"
  assert_no_bulk_kill
  assert_no_ai_data_write
}

execute_stage2() {
  ensure_sudo
  run_sudo_timeout 120 systemctl disable --now "$AXEUH_MOSS_UNIT"
}

post_stage2() {
  assert_unit_inactive "$AXEUH_MOSS_UNIT" || die 20 "MOSS unit still active after disable --now"
  assert_unit_disabled "$AXEUH_MOSS_UNIT" || die 20 "MOSS unit still enabled"
  assert_unit_active "$AXEUH_LOOM_UNIT" || die 21 "Loom unit was disturbed in stage2"
  load_services
  require_services_200 || die 22 "/api/services lost after stage2"
  expect_orchestrator off || die 22 "orchestrator must remain off in stage2"
  wait_health || die 23 "backend /health unhealthy after stage2"
  local stray
  stray=$(stray_watchers)
  [[ -z "$stray" ]] || die 24 "stray MOSS watcher remains after stage2 (pids: ${stray})"
  snapshot_perception "after-${_stage}"
  assert_perception_not_decreased "after-${_stage}" || die 25 "perception lines decreased"
  remember_perception "after-${_stage}"
}

main() {
  log_init stage2
  init_traps
  parse_cli "$@"
  phase PRE "stage2: stop MOSS sidecar only"
  PF_SOFT=$OPT_DRY
  preflight_stage2
  if ((OPT_DRY)); then
    print_plan
    phase POST "dry-run only: no mutation"
    exit 0
  fi
  require_yes
  phase EXEC "stage2: disable --now ${AXEUH_MOSS_UNIT}"
  execute_stage2
  phase POST "stage2: verify sidecar stopped, main chain intact"
  post_stage2
  log POST "stage2 PASSED — MOSS watcher is down (sidecar only); Loom still active under systemd"
  log POST "next: stage3.sh (orchestrator ON, one-by-one takeover, Loom last)"
}

main "$@"
