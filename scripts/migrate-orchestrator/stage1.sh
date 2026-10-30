#!/usr/bin/env bash
# shellcheck shell=bash
# stage1.sh —— 部署新代码，但把编排器钉在 OFF：
#   1) 预检：/health、/api/services（允许 404）、perception.jsonl 行数快照；
#   2) 写 drop-in Environment=AXEUH_ORCHESTRATOR=off（不改主 unit、不改 ExecStart）；
#   3) daemon-reload + restart axeuh-health；
#   4) 后置断言：/api/services 顶层 orchestrator=off 且 services=[]，Loom/MOSS 单元仍在。
#
# 代码本身必须已部署到 AXEUH_ROOT（见 README "Code deployment"）。本脚本不 git checkout：
# 生产检出通常带大量数据脏文件，脚本内切代码不可回滚。
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
  cat <<'EOF'
stage1.sh — deploy with AXEUH_ORCHESTRATOR=off (orchestrator takes over nothing)

usage: stage1.sh [--dry-run] [--yes]

  --dry-run   read-only checks + print the command plan (default when --yes is absent)
  --yes       actually mutate (write drop-in, restart axeuh-health)

env:
  AXEUH_ROOT              production checkout (default: .../axeuh-health-monitor)
  AXEUH_DEPLOY_REV        optional: git checkout this sha into AXEUH_ROOT before the restart
  EXPECTED_REV            optional: assert git HEAD of AXEUH_ROOT starts with this
  AXEUH_API_TOKEN         user token for /api/services (else chosen from auth.json)
EOF
}

print_plan() {
  phase EXEC "stage1 command plan (dry structural review)"
  log INFO "1. install drop-in ${AXEUH_DROPIN}: Environment=AXEUH_ORCHESTRATOR=off + daemon-reload (before any code change)"
  log INFO "2. optional: git checkout ${AXEUH_DEPLOY_REV:-<AXEUH_DEPLOY_REV unset: code assumed deployed>} (tar backup + pre-rev record)"
  log INFO "3. systemctl restart ${AXEUH_SERVICE}   (timeout 240s)"
  log INFO "4. wait /health healthy (<= ${AXEUH_HEALTH_TIMEOUT_S}s)"
  log INFO "5. GET /api/services -> assert orchestrator=off and services=[]"
  log INFO "6. systemctl is-active ${AXEUH_LOOM_UNIT} ${AXEUH_MOSS_UNIT} (must stay active)"
  log INFO "7. kernel pidfile orphan check + perception monotonic"
}

verify_code_present() {
  [[ -f "$AXEUH_ROOT/backend/core/hot_server.py" ]] ||
    pf_fail "backend/core/hot_server.py missing (new code not deployed)"
  [[ -f "$AXEUH_ROOT/backend/services/orchestrator/runtime.py" ]] ||
    pf_fail "backend/services/orchestrator/runtime.py missing (branch not deployed)"
  [[ -f "$AXEUH_ROOT/deploy/axeuh-health.service" ]] ||
    pf_fail "deploy/axeuh-health.service missing (branch not deployed)"
  if [[ -f "$AXEUH_ROOT/deploy/axeuh-health.service" ]]; then
    grep -q 'ExecStart=.*core\.hot_server' "$AXEUH_ROOT/deploy/axeuh-health.service" 2>/dev/null ||
      pf_fail "deploy/axeuh-health.service does not exec core.hot_server"
  fi
}

deploy_code_if_requested() {
  if [[ -z "${AXEUH_DEPLOY_REV:-}" ]]; then
    log INFO "AXEUH_DEPLOY_REV unset: assuming the branch is already deployed (verify-only)"
    return 0
  fi
  git -C "$AXEUH_ROOT" rev-parse --verify "${AXEUH_DEPLOY_REV}^{commit}" >/dev/null 2>&1 ||
    die 4 "AXEUH_DEPLOY_REV=${AXEUH_DEPLOY_REV} is not a local commit in ${AXEUH_ROOT}"
  local pre_rev
  pre_rev=$(git -C "$AXEUH_ROOT" rev-parse HEAD)
  printf '%s\n' "$pre_rev" >"$AXEUH_STATE_DIR/stage1-pre-rev"
  log POST "pre-stage1 rev recorded for rollback: ${pre_rev}"

  local stamp tar_path
  stamp=$(date +%Y%m%d-%H%M%S)
  mkdir -p "$AXEUH_STATE_DIR/backup"
  tar_path="$AXEUH_STATE_DIR/backup/pre-stage1-code-${stamp}.tar.gz"
  local items=()
  local candidate
  for candidate in backend deploy launcher.py; do
    if [[ -e "$AXEUH_ROOT/$candidate" ]]; then
      items+=("$candidate")
    fi
  done
  log EXEC "code backup ${items[*]} -> ${tar_path}"
  (cd "$AXEUH_ROOT" && tar -czf "$tar_path" "${items[@]}") ||
    die 4 "code backup failed; refusing to checkout"
  log POST "code backup: ${tar_path}"

  run git -C "$AXEUH_ROOT" checkout --detach "$AXEUH_DEPLOY_REV" ||
    die 4 "git checkout ${AXEUH_DEPLOY_REV} failed (dirty tree conflict?); nothing restarted"
  log POST "code deployed: $(git -C "$AXEUH_ROOT" rev-parse --short HEAD)"
}

preflight_stage1() {
  require_tools
  ensure_state_dir
  check_root_layout
  check_api_reachable
  load_services
  allow_services_404
  if [[ "$SERVICES_HTTP" == "200" ]]; then
    local mode
    mode=$(services_mode)
    if [[ "$mode" == "on" ]]; then
      pf_fail "orchestrator is already ON — the new code restarted before the off-switch was installed"
      log FAIL "remedy: this is exactly what stage1 prevents. Do not continue; inspect /api/services first."
    fi
  fi
  if [[ -n "${AXEUH_DEPLOY_REV:-}" ]]; then
    git -C "$AXEUH_ROOT" rev-parse --verify "${AXEUH_DEPLOY_REV}^{commit}" >/dev/null 2>&1 ||
      pf_fail "AXEUH_DEPLOY_REV=${AXEUH_DEPLOY_REV} is not a local commit in ${AXEUH_ROOT}"
    log INFO "code deploy requested: ${AXEUH_DEPLOY_REV} (verified after checkout)"
  else
    verify_code_present
    if [[ -n "${EXPECTED_REV:-}" ]]; then
      local rev
      rev=$(git -C "$AXEUH_ROOT" rev-parse HEAD 2>/dev/null || true)
      case "$rev" in
        "$EXPECTED_REV"*) log INFO "AXEUH_ROOT HEAD=${rev} matches EXPECTED_REV" ;;
        *) pf_fail "AXEUH_ROOT HEAD=${rev:-<none>} does not match EXPECTED_REV=${EXPECTED_REV}" ;;
      esac
    fi
  fi
  check_unit_exists "$AXEUH_SERVICE"
  assert_unit_active "$AXEUH_SERVICE"
  assert_unit_active "$AXEUH_LOOM_UNIT"
  assert_unit_active "$AXEUH_MOSS_UNIT"
  log INFO "current ExecStart: $(unit_exec_start "$AXEUH_SERVICE")"
  check_kernel_orphan || pf_fail "kernel pidfile points to a live process before stage1"
  snapshot_perception "before-${_stage}"
  assert_perception_not_decreased "before-${_stage}"
  assert_no_bulk_kill
  assert_no_ai_data_write
}

execute_stage1() {
  ensure_sudo
  backup_dropin "stage1" || true
  write_dropin off
  run_sudo_timeout 60 systemctl daemon-reload
  deploy_code_if_requested
  verify_code_present
  if [[ -n "${EXPECTED_REV:-}" ]]; then
    local head_rev
    head_rev=$(git -C "$AXEUH_ROOT" rev-parse HEAD 2>/dev/null || true)
    case "$head_rev" in
      "$EXPECTED_REV"*) log POST "AXEUH_ROOT HEAD=${head_rev} matches EXPECTED_REV" ;;
      *) die 4 "AXEUH_ROOT HEAD=${head_rev:-<none>} does not match EXPECTED_REV=${EXPECTED_REV}" ;;
    esac
  fi
  local rev
  rev=$(git -C "$AXEUH_ROOT" rev-parse HEAD 2>/dev/null || echo "no-git")
  printf '%s\n' "$rev" >"$AXEUH_STATE_DIR/stage1-deployed-rev"
  log INFO "recording deployed rev for rollback: ${rev}"

  run_sudo_timeout 240 systemctl restart "$AXEUH_SERVICE"
  wait_health || die 10 "backend did not come back after stage1 restart"
}

post_stage1() {
  load_services
  require_services_200 || die 11 "/api/services did not appear after stage1"
  expect_orchestrator off || die 11 "orchestrator must be off after stage1"
  local ids
  ids=$(services_ids)
  [[ -z "$ids" ]] || die 11 "off mode must expose an empty services list, got: ${ids}"
  log POST "orchestrator=off, services=[]"
  assert_unit_active "$AXEUH_LOOM_UNIT" || die 12 "Loom unit must stay active in stage1"
  assert_unit_active "$AXEUH_MOSS_UNIT" || die 12 "MOSS unit must stay active in stage1"
  check_kernel_orphan || die 13 "live kernel pidfile after restart: see remediation above"
  snapshot_perception "after-${_stage}"
  assert_perception_not_decreased "after-${_stage}" || die 14 "perception lines decreased"
  remember_perception "after-${_stage}"
}

main() {
  log_init stage1
  init_traps
  parse_cli "$@"
  phase PRE "stage1: deploy with orchestrator OFF"
  PF_SOFT=$OPT_DRY
  preflight_stage1
  if ((OPT_DRY)); then
    print_plan
    phase POST "dry-run only: no mutation, no restart"
    exit 0
  fi
  require_yes
  phase EXEC "stage1: install off-switch and restart"
  execute_stage1
  phase POST "stage1: verify orchestrator=off"
  post_stage1
  log POST "stage1 PASSED — orchestrator is off; Loom/MOSS still run under systemd"
  log POST "next: stage2.sh (stop axeuh-moss-watch only)"
}

main "$@"
