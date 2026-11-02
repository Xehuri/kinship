# Flow 面退役清单（Phase A 禁用/归档，Phase B 删码）

> 依据：`boot.ts:283-311`（`flow.enabled === true` 才构造 FlowStore/观察窗；`flow.enabled=false` = 零扫描零文件，旧行为逐字节）。
> 生产配置：`kinship-data/ai/.loom/config.yaml:18-20` 当前 `flow.enabled: true, retireConverge: true`。
> 检索方法：grep `flow`/`Flow` 全仓 `loom-harness`，逐文件确认落点；Phase A = 改配置关闭 + 保留代码，Phase B = 删源码。

## 0. 退役策略分级

- **Phase A（禁用/归档）**：将生产 `inbox.mode` 同款思路用于 Flow——`flow.enabled: false` 即零 Flow 面（`boot.ts:285` 已支持）。代码保留，仅停接线。
- **Phase B（移除代码）**：删除下列文件/出口/接线；需先确认 Phase A 观察期零回归。

## 1. 配置 schema / 段校验 / 示例

| 落点 | 文件:行 | Phase A | Phase B |
|------|---------|---------|---------|
| 段读取与缺省（enabled/retireConverge 缺省 false） | `config/section-checks.ts:841-889` | 保留（键仍解析，仅缺省关闭） | 删除整段 `checkFlow` 与 `FLOW` 校验 |
| 类型 `FlowConfig` | `config/loom-config.ts:152-156` | 保留 | 删除 `readonly flow?` 及物化 `flow` |
| 物化接线（line 218/254-255） | `config/loom-config.ts:218,254-255` | 保留 | 删除 |
| 配置示例（缺省 undefined） | `config/loom-config.ts:152-156` 注释 | 保留 | 删除段注释 |
| 测试 `config/flow-config.test.ts` | `config/flow-config.test.ts` | 保留（改期望为解析但禁用） | 删除文件 |
| 测试 `config/loom-config.test.ts` 中 Flow 用例 | `config/loom-config.test.ts`（flow 段相关） | 改期望 | 删除用例 |

## 2. core 层 Flow 工具 / gate / index 出口

| 落点 | 文件 | Phase A | Phase B |
|------|------|---------|---------|
| barrel 导出（工具/读工具/gate/store/continuation/limits/time/observation 等） | `core/src/flow/index.ts` | 保留 | 删除整个 `core/src/flow/` 目录与 barrel |
| 工具 `FlowCommitTool` / `FlowTool` | `core/src/flow/tool.ts`, `tool.test.ts` | 保留 | 删除 |
| 读工具 `FlowGetTool` / `FlowListTool` | `core/src/flow/read-tools.ts`, `read-tools.test.ts` | 保留 | 删除 |
| gate `FlowGate`（终局判别 flowEnded） | `core/src/flow/gate.ts`, `gate.test.ts` | 保留 | 删除 |
| store `FlowStore` / `MemoryFlowStore` | `core/src/flow/store.ts`, `memory-store.ts` (+tests) | 保留 | 删除 |
| continuation store | `core/src/flow/continuation-store.ts` (+test) | 保留 | 删除 |
| limits / time / slot / args / read-args / read-query / read-render / subject-factory / types / validation | `core/src/flow/*` | 保留 | 删除 |

## 3. main-loop 层 Flow 接线 / 类型

| 落点 | 文件:行 | Phase A | Phase B |
|------|---------|---------|---------|
| `loop.ts` 导入 FlowGate/FlowCommitTool/createFlowReadTools | `core/src/main-loop/loop.ts:38-40` | 保留 | 删除导入与构造 |
| `loop.ts` `flowGate` 字段（L4 注释 line 76-78, 295, 309） | `loop.ts:77,107,155-161,174-177,272,277-284` | 保留 | 删除 flowGate/hooks/tools 分支；`convergeEnabled` 永远为真（retireConverge 失效） |
| `types.ts` `flow?` 选项与 `flowEnded` 变体 | `core/src/main-loop/types.ts:26-27,76-84,243-249` | 保留 | 删除 `flow?:` 与 `type:"flowEnded"` 分支 |
| `index.ts` core main-loop barrel 是否再导出 flow | `core/src/main-loop/index.ts` | 核对（grep 无命中即未再导出） | 删除（随目录删） |

## 4. server 层 Flow stores / registry / observation / events / checkpoint-runner

| 落点 | 文件:行 | Phase A | Phase B |
|------|---------|---------|---------|
| 服务端 Flow 实现（JsonFlowStore / JsonFlowContinuationStore / flow-wake / flow-observation + 各自 test） | `server/src/flow/*.ts` | 保留 | 删除整个 `server/src/flow/` 目录 |
| `flow/index.ts` 服务端 barrel | `server/src/flow/index.ts` | 保留 | 删除 |
| `registry.ts` Flow 字段 `#flow` / `#flowObservation` / `#flowWakePlans` | `session-api/registry.ts:127-132,137,140-146,995-1004,1116,1141` | 保留（缺省 undefined 即零面） | 删除字段与 `#syncFlowWake`/`reconcileFlowWakes`/`#armFlowWake`/`#clearFlowWake`/`flowWakeLine`/`flowWakeSubjectAt`（registry.ts:447-462, 469-524, 1630-1793） |
| `registry.ts` `#start` 中 flow 分支（line 1281, 1294-1308, 1361-1382） | `registry.ts:1281,1294-1308,1361-1382` | 保留 | 删除 flowEnded 分支与 flow 视图字段 |
| `registry.ts` flow 工具 capture hook | `registry.ts:995-1004,1116` | 保留 | 删除 `flowCapture` |
| session-api 路由（deliverWake/flow 接线） | `session-api/routes.ts`, `session-api/index.ts`（grep 无 flow 命中） | 保留 | 删除相关接线 |
| observation 事件映射（flow_commit idle 投影、__flow 判别） | `events/mapping.ts:92-103` | 保留 | 删除 |
| 事件 schema（flow 相关帧/属性） | `events/project.ts`, `events/flow-project.test.ts` | 保留 | 删除 |
| checkpoint-runner（flow wait/resume/close 动作面） | `serve/checkpoint-runner.ts:2-30,63,80-93,183,206,212,246,281,324,339-357,378-411,519-584` | 保留 | 删除 `flowTool`/`CheckpointFlowState`/`flowActioned` 分支 |
| boot 装配（flowEnabled/flowStore/flowObservation/retireConverge；render/源 reconcile；reconcileFlowWakes 调用） | `serve/boot.ts:53-56,219-220,283-311,473,1019,1085-1102,1154-1168,1184-1186,1245-1251,1307-1312,1524` | 保留 | 删除全部 Flow 构造/接线/启动步骤 |
| `wake-queue.ts` 中 `flow` 来源（source 枚举/保留期/render 映射） | `serve/wake-queue.ts:21,24,244-245,276,492-493` | **保留**（wake-queue 三来源 plan/flow/special 是既有唤醒队列契约，flow 来源仅由 reconcile 调用，关闭 Flow 后无人 enqueue 即可） | 评估是否保留（建议保留枚举，避免破坏 wake-queue 校验） |

## 5. wake-queue 源 / 动作 / 渲染（保持既有）

- `WAKE_QUEUE_SOURCES = ["plan","flow","special"]`（`wake-queue.ts:21`）：三来源是唤醒队列自身契约，
  Phase A/B 均保留——关闭 Flow 后仅无人写入 `source:"flow"` 条目（boot 的 reconcile 分支在 Phase B 删除）。
- `toWakeEntry` 中 `renderSource`（`wake-queue.ts:488-499`）保留 `flow` 分支。
- `plan-scheduler.ts:6` 仅对 `source:"plan"` 做 `reconcileSource`，**不碰** flow/special——与退役无冲突。

## 6. 测试文件（Phase B 删除或改期望）

| 测试文件 | 关联 | 动作 |
|----------|------|------|
| `core/src/main-loop/flow-loop.test.ts` | core flow loop | Phase B 删 |
| `core/src/main-loop/flow-terminal.test.ts` | core flow 终局 | Phase B 删 |
| `core/src/main-loop/system-prompt-refresh.test.ts` | 含 flow 用例？ | 改/删相关用例 |
| `server/src/session-api/flow-registry.test.ts` | registry flow 唤醒 | Phase B 删 |
| `server/src/session-api/flow-registry-observation.test.ts` | flow observation | Phase B 删 |
| `server/src/session-api/flow-queue.test.ts` | flow queue | Phase B 删 |
| `server/src/flow/*` 全部 test | server flow 实现 | Phase B 删（随目录） |
| `server/src/serve/boot-flow.test.ts` | boot flow 装配 | Phase B 删 |
| `server/src/serve/boot-pty-e2e.test.ts` 中 deliverWake flow 用例 | 复用 deliverWake | 改（去掉 flow 唤醒断言） |
| `server/src/serve/wake-scheduler.test.ts` 中 flow render 分支 | 唤醒渲染 | 改/删 |

## 7. 文档（Phase B 清理）

- `loom-harness/docs/flow-bucket-b-migration.md`、`flow-converge-migration.md`：迁移文档，Phase B 归档/删除。
- `README.md` "Flow 机制" 段（根 README 第 4 点）：Phase B 改写，声明 Flow 已退役、由 inbox + plan 取代。
- 本文件 `docs/dev/flow-retirement-inventory.md` 自身随 Phase B 收尾归档。

## 8. 生产配置（Phase A 切换点）

- `kinship-data/ai/.loom/config.yaml:18-20`：`flow.enabled: true, retireConverge: true`。
- Phase A：改为 `flow.enabled: false`（保留 `retireConverge` 亦可，boot 已约定 `retireConverge 仅 enabled=true 时采纳`，`section-checks.ts:843`）。
- 本任务**不修改**该生产配置（见 MUST NOT DO）。

## 9. 风险与依赖

- `loop.ts` 的 `convergeEnabled` 在 retireConverge 关闭时受 flow 影响；Phase B 删 Flow 后 converge 工具/钩子应**无条件保留**（旧终止行为逐字节恢复）。
- `checkpoint-runner.ts` 的 `flowTool` 是 checkpoint "一次 flow 动作" 的落点；退役后 checkpoint 不再写 flow，需改其 phase 机（Phase B 单独评估）。
- `wake-queue.ts` 的 `flow` 来源枚举建议保留以兼容历史 sidecar（避免破坏唤醒队列校验 `wake-queue.ts:244`）。
