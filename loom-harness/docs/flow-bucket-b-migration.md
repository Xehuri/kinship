# Flow bucket B migration preparation（L9）

> 状态：准备稿。**L9 观察门通过前不得应用**。
> 关联：`flow-converge-migration.md` §4 桶 B、§6 删除门禁。
> 边界：本文与 `scripts/flow-bucket-b-migration.mjs` 只做 dry-run 准备；不改任何测试文件、不删 converge、不写生产 `stateRoot`、不重启服务、不提交。

## 0. 一句话结论

桶 B 是 30 个把 converge 当作“让主会话结束”的 fixture 测试。迁移只做机械替换：`converge` 工具调用改为 `flow_commit`，`converged` 终态断言改为 `flowEnded`，`status` 词表映射为 flow `state`，`wake` 改为 `next_decision_at`。测试意图、侧会话用例与断言结构不重写。

阻碍条件：必须等 7 天观察窗（2026-10-23 至 2026-10-30）满足 0 lost、0 duplicate、0 flowEnded without idle、CI 全绿、窗口完整，并由用户明确放行后才能执行。

## 1. 30 个文件

```text
packages/core/src/main-loop/main-session.test.ts
packages/core/src/main-loop/system-prompt-refresh.test.ts
packages/server/src/contract/contract-api.test.ts
packages/server/src/contract/contract-frames.test.ts
packages/server/src/serve/boot-assembly.test.ts
packages/server/src/serve/boot-instance.test.ts
packages/server/src/serve/boot-prompt-e2e.test.ts
packages/server/src/serve/boot-pty-e2e.test.ts
packages/server/src/serve/boot-rehydrate.test.ts
packages/server/src/serve/boot-reminder.test.ts
packages/server/src/serve/boot-resume-continuity.test.ts
packages/server/src/serve/boot-system-prompt-refresh.test.ts
packages/server/src/serve/boot-task-ledger.test.ts
packages/server/src/serve/boot-tools.test.ts
packages/server/src/serve/boot-transcript.test.ts
packages/server/src/serve/boot-wake.test.ts
packages/server/src/serve/boot-wire-cache.test.ts
packages/server/src/serve/context-change-boot.test.ts
packages/server/src/serve/model-routing.test.ts
packages/server/src/serve/session-context-main.test.ts
packages/server/src/serve/trace-wiring.test.ts
packages/server/src/serve/w11-live-events.test.ts
packages/server/src/serve/w9s3-tasks.test.ts
packages/server/src/session-api/boot-session-meta.test.ts
packages/server/src/session-api/compaction-history-route.test.ts
packages/server/src/session-api/compaction-status.test.ts
packages/server/src/session-api/context-api.test.ts
packages/server/src/session-api/context-full.test.ts
packages/server/src/session-api/context-full-v2.test.ts
packages/server/src/session-api/session-api.test.ts
```

混合文件注意：`boot-reminder.test.ts` 与 `boot-transcript.test.ts` 同时包含侧会话 converge 用例。侧会话的 `buildConvergeSession`、side schema、回执消费与死信链路永久保留，迁移时不得对这两段做机械替换。

## 2. 精确计划变换

| 规则 | 匹配 | 替换 | 说明 |
|---|---|---|---|
| `tool-name` | `converge` / `converge-main` / `converge-side`（单词边界） | `flow_commit` | 仅主会话 fixture。侧会话用例命中后必须人工跳过 |
| `terminal-result` | `converged`（单词边界） | `flowEnded` | `MainLoopResult.type` 与对应断言 |
| `status-done` | `status: "已完成"` | `state: "closed"` | flow 终态 |
| `status-waiting-user` | `status: "待用户回应"` | `state: "waiting_user"` | flow 终态 |
| `status-needs-confirm` | `status: "需用户确认"` | `state: "waiting_user"` | 语义折叠；“需要确认”的原因写入 notes，不新增状态 |
| `wake-field` | `wake:` | `next_decision_at:` | `wake: "none"` 对应 `next_decision_at: null`；省略则保持旧计划 |

不进入桶 B 机械替换的内容：

- `convergenceEnforced` / `convergence` 配置段与阈值：属于桶 C 语义重写，先拍板再改。
- `digest` / `body` / `pointers` / `blockers` 断言：主会话 flow 不消费这些字段，桶 C 单独处理。
- `ConvergenceGate` / `machine` / `receipt` 类型：侧会话保留，不迁移。
- 黄金帧、事件 envelope、auto-wake 全链：桶 C，不机械改名。

工具调用参数映射：

```text
converge({ status, wake, ... })
  -> flow_commit({ subject_name?, state, next_decision_at?, expected_version?, subject_id? })
```

- `status` -> `state`（按上表）。
- `wake` -> `next_decision_at`（`none` -> `null`）。
- 主会话旧 `digest`/`pointers`/`blockers` 不进入 flow 提交，fixture 中删除。
- 终态断言 `result.type === "converged"` -> `result.type === "flowEnded"`；`receipt.status` 断言改为 `flow.state`。

## 3. Dry-run 工具

```bash
node scripts/flow-bucket-b-migration.mjs --dry-run
```

行为：

- 只读扫描上述 30 个文件，按规则打印 `file:line:column`、原片段与替换目标。
- 输出汇总 `files=30 missing=0 planned=<n> writes=0`。
- 没有 `--apply`；传 `--apply` 或 `--write` 直接拒绝并退出 2。
- 不修改任何文件，不触碰生产目录。

## 4. 应用前置门禁

应用桶 B 前必须同时满足：

1. `scripts/flow-observation.mjs report` 连续 7 天窗口完整。
2. lost wakes = 0。
3. duplicate wakes = 0（`duplicate_suppressed` 单独展示，不计入失败）。
4. flowEnded without idle = 0。
5. 最新 CI 记录为 `pass`，且全量 `npm test` 绿。
6. 用户明确批准删除主 converge。

未满足任一项时，本文件与 dry-run 脚本都保持只读准备状态。
