#!/usr/bin/env bash
# T01 CI 入口：类型检查 -> 构建 -> 测试（任一失败即退出非零）
# T32：全程离线（fake-model 脚本回放，无网络、无 API key）。
# 留给 T31 的扩展点：`bash scripts/ci.sh --fake-only` 烟测入口——
#   只跑 packages/server/src/fake-model/**（假模型离线链路），供 serve CLI
#   冒烟阶段快速验证，不跑全量。参数分发在此接线：
#   case "${1:-}" in --fake-only) exec npm run test -- packages/server/src/fake-model ;; esac
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck && npm run build && npm run test
