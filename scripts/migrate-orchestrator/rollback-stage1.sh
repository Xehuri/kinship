#!/usr/bin/env bash
# shellcheck shell=bash
# rollback-stage1.sh —— 回到迁移前的代码版本（可选，默认只打印命令不执行）。
#
# 为什么默认不执行：生产检出常带大量数据脏文件（ai/**），脚本内 git checkout 代码路径
# 必须由人确认目标 rev。执行条件（两个都给齐才动手）：
#   AXEUH_ROLLBACK_REV=<pre-migration sha>
#   AXEUH_ALLOW_CODE_ROLLBACK=1
#
# 只回滚代码路径（backend/ deploy/ launcher.py），不碰 ai/** 与 config.yaml。
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
  cat <<'EOF'
rollback-stage1.sh — restore the pre-migration code rev (opt-in)

usage: rollback-stage1.sh [--dry-run] [--yes]

env:
  AXEUH_ROLLBACK_REV=<sha>        target rev; defaults to <state>/stage1-pre-rev
  AXEUH_ALLOW_CODE_ROLLBACK=1     required to execute (guard against accidents)
EOF
}

wants_code_rollback() {
  [[ -n "${TARGET_REV:-}" && "${AXEUH_ALLOW_CODE_ROLLBACK:-0}" == "1" ]]
}

print_plan() {
  phase EXEC "rollback-stage1 command plan (dry structural review)"
  log INFO "target rev: ${TARGET_REV:-<unset>}  allow_code_rollback=${AXEUH_ALLOW_CODE_ROLLBACK:-0}"
  log INFO "1. tar czf $AXEUH_STATE_DIR/backup/code-<ts>.tar.gz backend deploy launcher.py"
  log INFO "2. git -C ${AXEUH_ROOT} checkout ${TARGET_REV:-<sha>} -- backend [deploy] [launcher.py]"
  log INFO "3. rm -f ${AXEUH_DROPIN}; systemctl daemon-reload; systemctl restart ${AXEUH_SERVICE}"
  log INFO "4. assert /health 200; /api/services is 404 (old code) or orchestrator=off"
}

preflight_rollback1() {
  rollback_preflight
  TARGET_REV="${AXEUH_ROLLBACK_REV:-}"
  if [[ -z "$TARGET_REV" && -f "$AXEUH_STATE_DIR/stage1-pre-rev" ]]; then
    TARGET_REV=$(head -n 1 "$AXEUH_STATE_DIR/stage1-pre-rev")
    log INFO "target rev taken from stage1-pre-rev: ${TARGET_REV}"
  fi
  local exec_start
  exec_start=$(unit_exec_start "$AXEUH_SERVICE")
  case "$exec_start" in
    *launcher.py*) log INFO "ExecStart=launcher.py (compatible with the old code)" ;;
    *core.hot_server*)
      pf_fail "ExecStart=core.hot_server; run rollback-stage4.sh first so the old code runs under launcher"
      ;;
  esac
  if wants_code_rollback; then
    git -C "$AXEUH_ROOT" rev-parse --verify "${TARGET_REV}^{commit}" >/dev/null 2>&1 ||
      pf_fail "rollback rev ${TARGET_REV} is not a local commit in ${AXEUH_ROOT}"
    log INFO "rollback rev verified: ${TARGET_REV}"
  else
    log WARN "no rollback rev (AXEUH_ROLLBACK_REV / stage1-pre-rev) or AXEUH_ALLOW_CODE_ROLLBACK!=1: code will NOT be rolled back"
  fi
}

execute_rollback1() {
  local stamp tar_path
  stamp=$(date +%Y%m%d-%H%M%S)
  mkdir -p "$AXEUH_STATE_DIR/backup"
  tar_path="$AXEUH_STATE_DIR/backup/code-${stamp}.tar.gz"
  local items=()
  local candidate
  for candidate in backend deploy launcher.py; do
    if [[ -e "$AXEUH_ROOT/$candidate" ]]; then
      items+=("$candidate")
    fi
  done
  log EXEC "backing up ${items[*]} -> ${tar_path}"
  (cd "$AXEUH_ROOT" && tar -czf "$tar_path" "${items[@]}") ||
    die 90 "code backup failed; refusing to git checkout"
  log POST "code backup: ${tar_path}"

  local path
  for path in backend deploy launcher.py; do
    if git -C "$AXEUH_ROOT" cat-file -e "${TARGET_REV}:${path}" 2>/dev/null; then
      log EXEC "git -C ${AXEUH_ROOT} checkout ${TARGET_REV} -- ${path}"
      git -C "$AXEUH_ROOT" checkout "$TARGET_REV" -- "$path"
    else
      log INFO "path ${path} absent in ${TARGET_REV}; skipped"
    fi
  done

  if sudo test -f "$AXEUH_DROPIN" 2>/dev/null; then
    run_sudo rm -f "$AXEUH_DROPIN"
    log POST "removed migration drop-in ${AXEUH_DROPIN}"
  fi
  run_sudo_timeout 60 systemctl daemon-reload
  run_sudo_timeout 240 systemctl restart "$AXEUH_SERVICE"
  wait_health || die 91 "backend did not recover after code rollback"
}

post_rollback1() {
  if load_services_soft; then
    log WARN "/api/services still present after the code rollback (old code normally returns 404)"
    log INFO "orchestrator mode: $(services_mode)"
  else
    log POST "/api/services absent (expected on the old code)"
  fi
  snapshot_perception "after-${_stage}"
  assert_perception_not_decreased "after-${_stage}" || die 92 "perception lines decreased"
  remember_perception "after-${_stage}"
}

main() {
  log_init rollback-stage1
  init_traps
  parse_cli "$@"
  phase PRE "rollback-stage1: restore pre-migration code"
  PF_SOFT=$OPT_DRY
  preflight_rollback1
  if ((OPT_DRY)); then
    print_plan
    phase POST "dry-run only: no mutation"
    exit 0
  fi
  require_yes
  if ! wants_code_rollback; then
    log WARN "refusing to execute without a rollback rev (AXEUH_ROLLBACK_REV or stage1-pre-rev) and AXEUH_ALLOW_CODE_ROLLBACK=1"
    print_plan
    phase POST "nothing executed (guard)"
    exit 0
  fi
  phase EXEC "rollback-stage1: backup + git checkout code paths + restart"
  execute_rollback1
  phase POST "rollback-stage1: verify"
  post_rollback1
  log POST "rollback-stage1 PASSED — production code restored to ${TARGET_REV}"
}

main "$@"
