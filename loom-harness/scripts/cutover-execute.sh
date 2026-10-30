#!/usr/bin/env bash
# W39 转正切换执行器（runbook docs/10 §3 的机器化；2026-10-14 B 案拍板产物）
# 用法：
#   DRY=1 bash scripts/cutover-execute.sh          # 演练：只打印将做的事，零副作用
#   GO=1  bash scripts/cutover-execute.sh          # 真切换（需先 sudo -v 或管道喂密码）
#   bash scripts/cutover-execute.sh rollback      # §4 回滚（hm 配置还原 + unit 回切影子）
# 铁律：每步 cp -a 备份留痕；任何活体门不过 = 立即停手并打印回滚指引；绝不写 ai/.loom 以外
# 的未备份面；opencode:5096 launcher 全程不动。
set -euo pipefail

HM="${KINSHIP_ROOT:-/opt/kinship}"
HRN="${KINSHIP_ROOT:-/opt/kinship}/loom-harness"
STAGING="${KINSHIP_WORK_DIR:-/opt/kinship-work}/cutover-staging"
UNIT=/etc/systemd/system/axeuh-loom.service
TS=$(date +%Y%m%d-%H%M%S)

say() { printf '[cutover %s] %s\n' "$(date +%T)" "$*"; }
run() { if [ "${DRY:-0}" = 1 ]; then say "DRY: $*"; else say "RUN: $*"; eval "$@"; fi; }
need_root() { sudo -n true 2>/dev/null || { echo "需要 sudo 凭证：先 sudo -v（或 echo PW | sudo -S -v）"; exit 1; }; }

# ── rollback：§4 剧本 ──────────────────────────────────────────────
if [ "${1:-}" = "rollback" ]; then
  need_root
  BAK=$(ls -t "${HM}/config.yaml".bak-cutover-* 2>/dev/null | head -1 || true)
  [ -n "$BAK" ] || { echo "找不到 config.yaml 切换前备份，拒绝盲滚"; exit 1; }
  run "cp -a '$BAK' '${HM}/config.yaml'"
  run "systemctl restart axeuh-health"
  UBAK=$(ls -t "${UNIT}".bak-cutover-* 2>/dev/null | head -1 || true)
  [ -n "$UBAK" ] && run "cp -a '$UBAK' '$UNIT' && systemctl daemon-reload && systemctl restart axeuh-loom" \
                || say "unit 无切换备份（可能还没切 LOOM_INSTANCE），跳过回切"
  say "回滚完成。验证：curl -s http://127.0.0.1:8768 正常 + journalctl -u axeuh-health 投递回 opencode"
  exit 0
fi

[ "${GO:-0}" = 1 ] || [ "${DRY:-0}" = 1 ] || { echo "必须显式 GO=1（或 DRY=1 演练）。这就是审批位。"; exit 1; }
[ "${GO:-0}" = 1 ] && need_root
[ -d "$STAGING" ] || { echo "暂存区缺失：$STAGING"; exit 1; }

say "=== §3-1 unit 备份与 LOOM_INSTANCE 翻面 ==="
run "cp -a '$UNIT' '${UNIT}.bak-cutover-${TS}'"
run "sed -i 's#^Environment=LOOM_INSTANCE=.*#Environment=LOOM_INSTANCE=${HM}/ai#' '$UNIT'"
grep -n "LOOM_INSTANCE" "$UNIT" | head -2

say "=== §3-2 生产声明桥接三件（staging 已过 loader 校验）==="
for f in main data-checker reviewer; do
  SRC="$STAGING/ai-agents-${f}.md"; DST="${HM}/ai/agents/${f}.md"
  [ "$f" = main ] && SRC="$STAGING/ai-agents-main.md"
  if [ -f "$DST" ]; then run "cp -a '$DST' '${DST}.bak-cutover-${TS}'"; fi
  run "cp -a '$SRC' '$DST'"
done

say "=== §3-3 ai/.gitignore 堵 key 面（先堵后写）==="
grep -q '^\.loom/' "${HM}/ai/.gitignore" 2>/dev/null || {
  run "cp -a '${HM}/ai/.gitignore' '${HM}/ai/.gitignore.bak-cutover-${TS}'"
  run "printf '.loom/\n' >> '${HM}/ai/.gitignore'"
}
run "git -C '$HM' check-ignore -v ai/.loom/config.yaml" # 命中才算堵上（DRY 下允许显示未堵）

say "=== §3-4 ai/.loom 实例根就位 ==="
run "mkdir -p '${HM}/ai/.loom'"
run "cp -a '$STAGING/ai-dot-loom-config.yaml' '${HM}/ai/.loom/config.yaml'"

say "=== §3-5 loom 服务翻面 + 三门活体 ==="
run "systemctl daemon-reload"
run "systemctl restart axeuh-loom"
if [ "${DRY:-0}" != 1 ]; then
  sleep 8
  J=$(journalctl -u axeuh-loom --since "30 sec ago" --no-pager)
  for pat in "persona bound" "main memory roster" "sandbox policy"; do
    echo "$J" | grep -q "$pat" && say "门过: $pat" || { say "门挂: $pat —— 立即执行: bash $0 rollback"; exit 2; }
  done
  echo "$J" | grep -E "persona bound|memory roster|sandbox policy" | head -3
  TOKEN=$(grep -oP 'LOOM_TOKEN=\K[0-9a-f]+' /etc/kinship-loom/credentials.conf)
  curl -s -m 10 -X POST -H "X-Loom-Token: $TOKEN" -H "Content-Type: application/json" \
    -d '{"parts":[{"type":"text","text":"（切换后 wake 探针，无需回复）"}]}' \
    http://127.0.0.1:5100/sessions/loom_main/messages >/dev/null && say "wake 已投"
  sleep 15
  curl -s -m 15 -H "X-Loom-Token: $TOKEN" http://127.0.0.1:5100/sessions/loom_main/context/full \
    | grep -o '"prefixByteLength":[0-9]*' | head -1
fi

say "=== §3-6 hm 切流（最后一步，回滚面在 hm）==="
run "cp -a '${HM}/config.yaml' '${HM}/config.yaml.bak-cutover-${TS}'"
run "sed -i 's/^ai_backend: .*/ai_backend: loom/' '${HM}/config.yaml'"
run "systemctl restart axeuh-health"
say "完成。观察窗：下一个偶数小时 data-check 真流量 + 语音一次 + web 聊天冒烟。"
say "回滚口令：bash $0 rollback"
