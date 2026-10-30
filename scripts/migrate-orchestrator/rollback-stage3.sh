#!/usr/bin/env bash
# shellcheck shell=bash
# rollback-stage3.sh —— 回到"迁移前拓扑"：
#   AXEUH_ORCHESTRATOR=off（drop-in）→ 重启后端（编排器子进程随 cgroup 停止）
#   → enable --now axeuh-loom axeuh-moss-watch → 验证三单元 active + Loom /health。
#
# 顺序不可反：先 enable 单元会与仍在运行的 loom child / moss child 抢 5100 与订阅目录，
# 形成双实例。必须"先 off + 重启（子进程退出），再 enable"。
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
  cat <<'EOF'
rollback-stage3.sh — orchestrator off + systemd Loom/MOSS restored

usage: rollback-stage3.sh [--dry-run] [--yes]
EOF
}

print_plan() {
  phase EXEC "rollback-stage3 command plan (dry structural review)"
  log INFO "1. drop-in -> AXEUH_ORCHESTRATOR=off; systemctl daemon-reload"
  log INFO "2. systemctl restart ${AXEUH_SERVICE}  (stops all orchestrator children)"
  log INFO "3. wait /health (warn-but-continue on failure)"
  log INFO "4. systemctl enable --now ${AXEUH_LOOM_UNIT} ${AXEUH_MOSS_UNIT}"
  log INFO "5. assert 3 units active + Loom /health ok + /api/services orchestrator=off"
}

preflight_rollback3() {
  rollback_preflight
  check_unit_exists "$AXEUH_LOOM_UNIT"
  check_unit_exists "$AXEUH_MOSS_UNIT"
  ensure_loom_token soft || true
}

execute_rollback3() {
  local t0
  t0=$(now_ms)
  write_dropin off
  run_sudo_timeout 60 systemctl daemon-reload
  run_sudo_timeout 240 systemctl restart "$AXEUH_SERVICE"
  if wait_health; then
    log POST "backend healthy after orchestrator-off restart"
  else
    log WARN "backend unhealthy after restart; continuing so systemd Loom/MOSS come back"
  fi
  run_sudo_timeout 120 systemctl enable --now "$AXEUH_LOOM_UNIT" "$AXEUH_MOSS_UNIT"
  if wait_loom_health 120; then
    local elapsed=$(($(now_ms) - t0))
    log POST "loom is healthy again after ${elapsed} ms (rollback budget 60000 ms)"
    if ((elapsed > LOOM_WINDOW_BUDGET_MS)); then
      log WARN "rollback loom downtime exceeded the 60s budget"
    fi
  else
    log WARN "systemd Loom did not become healthy within 120s; inspect journalctl -u ${AXEUH_LOOM_UNIT}"
  fi
}

post_rollback3() {
  assert_unit_active "$AXEUH_LOOM_UNIT" || die 70 "Loom unit is not active after rollback-stage3"
  assert_unit_active "$AXEUH_MOSS_UNIT" || die 70 "MOSS unit is not active after rollback-stage3"
  assert_unit_active "$AXEUH_SERVICE" || die 70 "backend unit is not active"
  assert_unit_enabled "$AXEUH_LOOM_UNIT" || die 71 "Loom unit is not enabled"
  assert_unit_enabled "$AXEUH_MOSS_UNIT" || die 71 "MOSS unit is not enabled"
  if load_services_soft; then
    expect_orchestrator off || die 72 "orchestrator must be off after rollback-stage3"
  fi
  snapshot_perception "after-${_stage}"
  assert_perception_not_decreased "after-${_stage}" || die 73 "perception lines decreased"
  remember_perception "after-${_stage}"
}

main() {
  log_init rollback-stage3
  init_traps
  parse_cli "$@"
  phase PRE "rollback-stage3: orchestrator off, systemd Loom/MOSS restored"
  PF_SOFT=$OPT_DRY
  preflight_rollback3
  if ((OPT_DRY)); then
    print_plan
    phase POST "dry-run only: no mutation"
    exit 0
  fi
  require_yes
  phase EXEC "rollback-stage3: off -> restart -> enable units"
  execute_rollback3
  phase POST "rollback-stage3: verify three units active"
  post_rollback3
  log POST "rollback-stage3 PASSED — pre-migration topology restored (orchestrator off)"
}

main "$@"
