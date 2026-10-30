# converge 退役与 flow_commit 迁移清单（D7）

> 状态：迁移契约 + 实施状态（2026-10-23）。L1-L8 已落地；L9 删除受 7 天观察门禁，未执行。
> 代码基线：axeuh-harness `main` HEAD `19cd6bd` + 未提交 flow 工作树（2026-10-23）。
> 决策依据：`../axeuh-health-monitor/docs/记忆与心流-讨论与决策-2026-10-23.md` D7（converge 可退役，先清单后删除）与 D10（未确认前不改代码、不重启生产、不提交）。
> 硬边界：本轮未删除、未改名、未修改任何 converge 代码；7 天观察已开始；生产 09:10:51、13:39:42、14:52:02、19:48:40 已重启、未提交。
> 实施状态：L1-L8 已完成（flow_commit / FlowGate / flowEnded / JsonFlowStore / server wiring / retireConverge 开关）；Loom 全量 230 文件 / 2725 tests 绿；名称/默认主体修复定向 53 passed；`flow_list` / `flow_get` 定向 24 passed（read-tools 21 + flow-loop 3），time/tool/wake 59 passed；限额配置覆盖定向 52 passed（contract 26 + memory-store 18 + flow-config 8）。L9 删除门禁与 bucket B 迁移未执行。当前未提交工作树有多个 flow 测试，不计入收敛测试的 55 文件分桶。
> 2026-10-23 09:00 首次重启因旧工具名 `flow.commit` 含点被 provider 400；改名 `flow_commit` 后 09:10:51 重启成功，09:10 后 0 个 400。
> 已生效：生产 Loom 19:48:40 重启（当前 PID 226183）已加载 `flow_list` / `flow_get`、`formatFlowTime`、`flow.limits=10/8/32/16384` 与 `ai/agents/main.md` prompt；14:52:37 的旧进程曾返回本地 `15:11:58+08:00`，19:48:40 后按新限额启动。

## 0. 一句话结论

主会话 converge 只有两个控制信号被机器消费：`status` 决定本轮终止，`wake` 决定下一拍。回执正文 `digest`、`body`、`pointers`、`blockers` 在主会话没有机器读取方。迁移只迁这两个信号，侧会话回执与账本、死信、任务视图全部保留。

## 0.1 实施状态（2026-10-23）

| 层 | 状态 | 证据 |
|---|---|---|
| L1 契约 | 完成 | `packages/core/src/flow/{types,limits,time,store,memory-store}` + 81 tests |
| L2 工具 | 完成 | `flow/{slot,tool,args}.ts`；create/CAS/conflict/closed/错误回灌；已有 `subject_name`（缺省「主线」）自动解析为 `subject_id` + 当前 version，成功文本回显 `subject_id`；显式 `expected_version` 仍 CAS；`body`/`digest` 不支持、不持久化。只读 `flow_list` / `flow_get`（`flow/{read-tools,read-args,read-query,read-render}.ts`）在 `flow_commit` 后注册，仅主会话；list 支持 state/focus/kind、include_closed、limit/offset、focus/next/updated 排序与最新 note；get 支持 id/name/缺省「主线」、会话隔离、notes tail/offset；两者均有 4096 字节信封截断 |
| L3 Gate | 完成 | `flow/gate.ts`；session+turn 双匹配、terminal/active、unset、fail-open |
| L4 主循环 | 完成 | `main-loop/{types,loop}.ts`；`flowEnded`、`converge:"disabled"`、terminal 改标 |
| L5 持久化 | 完成 | `server/src/flow/json-flow-store.ts`；restart/CAS/corrupt-index/path-safety |
| L6 服务接线 | 完成 | `flow-wake.ts`、boot、registry、wake-scheduler、events、config；默认关闭 |
| L7 等价 | 部分 | close/wait/wake/restart/multi/unset 已有测试；bucket B 仅准备 dry-run，未迁移 |
| L8 分阶段退役 | 完成 | `flow.retireConverge=true` 已随 09:10:51 重启生效；主会话 converge 已禁用 |
| L9 观察 | 运行中 | 观察窗 2026-10-23 08:15 至 2026-10-30；2026-10-24 12:34 当前读数 events=895、wake_armed=41、wake_delivered=25、lost=14、duplicate_suppressed=124、flowEnded=164、idle=178（with_flow=164）、unset=363；gate FAIL `window not complete; 14 lost wake(s)` |
| L9 删除 | 阻塞 | 观察窗未满且有 14 lost wake(s)；未删除任何 converge 代码 |

实测：`npm test` 230 文件 / 2725 tests 全绿；`flow_list` / `flow_get` 定向 24 passed（read-tools 21 + flow-loop 3），time/tool/wake 59 passed；flow_commit 名称/默认主体修复定向 53 passed（tool 10 / contract 26 / memory-store 17），限额配置覆盖定向 52 passed（contract 26 + memory-store 18 + flow-config 8），`npm run typecheck` exit 0。生产配置 `flow.enabled=true` / `retireConverge=true` / `flow.limits=10/8/32/16384`；09:00 首次重启 400，改名 `flow_commit` 后 09:10:51 成功重启、0 个 400。flow_commit、读工具、时间、prompt 与 limits 已随 19:48:40 重启加载。

### 0.2 L9 观察窗

- 窗口：2026-10-23 08:15 → 2026-10-30 08:15（7 天）。
- 看板：`node scripts/flow-observation.mjs report --root <stateRoot> --json`。
- 12:55 前读数：window running；CI pass；events=39、flowEnded=9、unset=18、idle=12、wake=0；lost=0、duplicate=0、flowEndedWithoutIdle=0；gate 为 `window not complete; no wake sample`。`wake_armed=0` 时脚本追加 `no wake sample`，避免把空集误判为唤醒门通过。
- 2026-10-23 14:11 首次真实唤醒投递：`wake_delivered=1`、`wake_armed=1`、`duplicate_suppressed=10`、`lost=0`、`duplicate=0`；`no wake sample` 不再出现，唤醒门已有样本。
- 生产 Loom 于 13:39:42 与 14:52:02 重启（当前 PID 4105274），已加载 `flow_commit` 名称/默认主体修复、读工具与本地时间；14:11 唤醒成功武装并投递，`next_decision_at` 已落盘。
- 首次唤醒行显示 UTC `06:11:54Z`；`formatFlowTime` 已改为默认 `Asia/Shanghai` 并显式 `+08:00`，14:52:02 重启后已加载，14:52:37 `flow_list` 返回 `15:11:58+08:00`。
- 14:11 前 subject `next_decision_at=null`，wake armed/delivered 为 0，0 lost/duplicate 是空集；现在已有 1 次样本，但观察窗未满，不能判定门通过。
- 生产 09:00 首次重启因旧名 `flow.commit` 含点触发 400；改名 `flow_commit` 后 09:10:51 重启成功、0 个 400。观察窗仍按 08:15 起点计算。
- 2026-10-24 12:34 当前读数：events=895、wake_armed=41、wake_delivered=25、lost=14、duplicate_suppressed=124、flowEnded=164、idle=178（with_flow=164）、flow_unset=363；gate FAIL `window not complete; 14 lost wake(s)`。
- 删除门禁：窗口完成 + 上述三项为 0 + 至少一次唤醒样本 + CI 绿 + 用户批准；未满足前不得删除 converge。当前 lost=14、窗口未完成，删除门禁仍未过。
- bucket B：`docs/flow-bucket-b-migration.md` + `scripts/flow-bucket-b-migration.mjs --dry-run` 已准备 30 文件清单，未迁移、未写入。

## 1. 现状盘点

### 1.1 主会话、侧会话、子智能体的行为差异

| 面 | 工具与 schema | gate 与终止 | 回执消费 | 唤醒 | 现状 |
|---|---|---|---|---|---|
| 主会话 | `ConvergenceTool("main")` 由 `MainSessionLoop` 预置在工具数组首位，`packages/core/src/main-loop/loop.ts:226` | `buildHooks()` 或 `buildAdjudicationHooks()`，`loop.ts:232-236`；终止只认 `onTurnEnd` 的 `continue:false` | `status` 进入 stopReason 与 idle 帧；`wake` 进入 `nextWakeAt`；正文其余字段无读取方 | 仅主会话有 `wake`，`packages/server/src/session-api/registry.ts:1143-1155` | 唯一用户交互长循环，收束后 idle |
| 侧会话 | `buildConvergeSession` 自建 `ConvergenceGate({kind:"side"})` 并预置工具，`packages/core/src/kernel/kernel.ts:62-85` | 每次 run 全新 `AgentSession`，挂全量 `gate.buildHooks()`，`kernel.ts:68-83` | `status`、`digest`、`pointers`、`blockers`、`receipt` 全部映射进 `RunLaunchResult`，`packages/core/src/run-engine/side-session-port.ts:156-185` | 无 `wake`，side schema 不含该键，`packages/core/src/convergence/tool.ts:94-107` | 每次 run 无跨 run 内存，账本 expected/actual 盖棺 |
| 子智能体 | 无 converge 工具，`buildSubSession` 不挂 gate，`kernel.ts:92-110` | 无收束 gate，终局由调用方整形 | 无回执 | 无 | `task` 工具派发，结果以 `<task_metadata>` 回灌 |

主会话与侧会话的工具集来自同一数组，converge 不在该数组中，由各自门面预置：`packages/server/src/serve/tool-wiring.ts:242`、`packages/server/src/serve/boot.ts:695`、`boot.ts:721`。迁移 flow 工具时必须走主会话专属注入缝，不能加进 `toolWiring.tools`，否则侧会话也会看到 `flow_commit`。

### 1.2 代码锚点

| 组件 | 文件:行 | 事实 |
|---|---|---|
| 工具名与别名 | `packages/core/src/convergence/tool.ts:30-36` | 规范名 `converge`，别名 `converge-main`、`converge-side` |
| 主 schema | `packages/core/src/convergence/tool.ts:79-92` | 只有 `status`、可选 `pointers`、`blockers`、`wake`；没有 `body` |
| 侧 schema | `packages/core/src/convergence/tool.ts:94-107` | `status`、`runId`、`workflow`、`attempt`、可选 `pointers`、`blockers`；没有 `wake` |
| schema 选择 | `packages/core/src/convergence/tool.ts:109-115` | `kind === "main"` 走主 schema，否则侧 schema |
| 工具构造 | `packages/core/src/convergence/tool.ts:217-233` | `isReadOnly: true`，`isConcurrencySafe: false`，串行执行是重复收束查重的前提 |
| execute 受理 | `packages/core/src/convergence/tool.ts:152-193` | 只写 `ACCEPTED_SLOT`，返回 `details.__convergence`，不做终止决策 |
| 同轮重复收束 | `packages/core/src/convergence/tool.ts:159-168` | 同 run 代际同 turn 已受理则拒收 |
| 回执类型 | `packages/core/src/convergence/receipt.ts:18-38` | `MainReceipt` 与 `SideReceipt`；`body` 只在 main 可选 |
| 回执解析 | `packages/core/src/convergence/receipt.ts:146-220` | 不可信模型输入的唯一边界；main 的 `body` 在此可选解析 |
| 唤醒取值 | `packages/core/src/convergence/receipt.ts:223-225` | `nextWakeAtOf` 只区分“键缺席”和“键存在” |
| 强制回执 | `packages/core/src/convergence/receipt.ts:228-260` | 非 converged 终止合成如实回执，绝不静默假完成 |
| 状态机 | `packages/core/src/convergence/machine.ts:205-277` | 终止判别全在 `decideTurnEnd`；催办、硬顶、强制收束 |
| 自然停终审 | `packages/core/src/convergence/machine.ts:180-188` | `decideNaturalTerminal` 只认本 turn 已受理 |
| 续跑决策 | `packages/core/src/convergence/machine.ts:280-292` | `decideContinuation` 供 turn-end guard 使用 |
| gate 全量钩子 | `packages/core/src/convergence/gate.ts:315-412` | `onSessionStart`、`onPostToolUse`、`onTurnEnd`、guard |
| gate 终审子集 | `packages/core/src/convergence/gate.ts:285-313` | 仅复位与受理判别，用于主会话自然停 |
| 收束 stopReason | `packages/core/src/convergence/machine.ts:164-169` | `convergence:converged:<status>` |
| 终止判据 | `packages/core/src/convergence/gate.ts:238-252` | `isConvergedTermination` 只认 `abortReason` 前缀加本会话账本 |
| wake 解析器 | `packages/core/src/convergence/wake.ts:9`、`wake.ts:155-180` | 倒计时、带时区 ISO、本地时间、`HH:MM`、`none`；上限 30 天 |
| 阈值 | `packages/core/src/convergence/limits.ts:7-23` | `nudgeLimit` 5、`escalateSameError` 3、`turnHardCap` 60、`autoContinuations` 2 |
| 主循环接线 | `packages/core/src/main-loop/loop.ts:120-240` | gate 构造、工具预置、hook 拼接、内核续跑预算 |
| 主循环终局 | `packages/core/src/main-loop/loop.ts:458-511` | `_drive` 消费 gate 账本并返回 `MainLoopResult` |
| 自然停映射 | `packages/core/src/main-loop/loop.ts:541-569` | `aborted` 加收束前缀归 `converged`，其余归 `naturalStop` |
| 终态改标 | `packages/core/src/main-loop/loop.ts:98-118` | 落盘 terminal 的 `aborted` 在收束轮改写为 `done` |
| 侧会话工厂 | `packages/core/src/kernel/kernel.ts:62-85` | 新建 side gate 与 `AgentSession` |
| 子会话工厂 | `packages/core/src/kernel/kernel.ts:92-110` | 无 gate、无 converge |
| 侧执行端口 | `packages/core/src/run-engine/side-session-port.ts:108-202` | 每次 run 新建会话；回执映射到 `RunLaunchResult` |
| 侧账本盖棺 | `packages/core/src/kernel/kernel.ts:487-550` | `TerminalSnapshot` 写 actual；pointers 进产物；failed 进死信 |
| 主循环创建 | `packages/server/src/session-api/registry.ts:978-1022` | 主会话专属 `limits`、`convergenceEnforced`、`autoWakeEnabled` 透传 |
| 主唤醒武装 | `packages/server/src/session-api/registry.ts:1143-1155` | 只有 `result.type === "converged"` 且 `nextWakeAt` 键存在才武装 |
| 唤醒投递 | `packages/server/src/session-api/registry.ts:388-409` | 空闲立即起轮，忙则入 durable 队列 |
| idle 帧 | `packages/server/src/session-api/registry.ts:1215-1218` | 收尾必发 `session.idle`，带镜像 `id` |
| 唤醒调度器 | `packages/server/src/serve/wake-scheduler.ts:89-112` | `arm(null)` 取消定时器并删 sidecar |
| 唤醒恢复 | `packages/server/src/serve/wake-scheduler.ts:121-162` | 启动恢复；超过 24 小时过期丢弃；超过 30 天丢弃 |
| 唤醒触发 | `packages/server/src/serve/wake-scheduler.ts:203-226` | 到点投递；投递失败保留 sidecar，at-least-once |
| 主会话 limits | `packages/server/src/serve/boot.ts:621-629` | 顶层 `convergence` 四值唯一物化点，主侧共享同一引用 |
| 侧端口注入 | `packages/server/src/serve/boot.ts:692-709` | 侧会话拿同一 `limits` 引用 |
| 主会话注入 | `packages/server/src/serve/boot.ts:764-788` | `convergenceEnforced`、`autoWakeEnabled`、`limits` 进 registry |
| 唤醒装配 | `packages/server/src/serve/boot.ts:819-834`、`boot.ts:861` | `autoWakeEnabled !== false` 才建调度器；队列恢复后 restore |
| 事件读取 | `packages/server/src/events/mapping.ts:141-151` | `readConvergence` 只认 `details.__convergence` |
| idle 投影 | `packages/server/src/events/project.ts:174-188` | `convergence.status` 随 `session.idle` 带出 |
| 工具结果投影 | `packages/server/src/events/project.ts:268-269` | 收束回执写入投影状态 |
| UI 消费 | `packages/server/src/serve/harness-ui.ts:1175`、`harness-ui.ts:5299-5300` | 直接读 `convergence.status` 显示“收束” |
| 配置结构 | `packages/server/src/config/loom-config.ts:106-112`、`loom-config.ts:186`、`loom-config.ts:208-211` | 顶层 `convergence` 段可选，不物化默认值 |
| server 开关 | `packages/server/src/config/section-checks.ts:16-60` | `convergenceEnforced` 与 `autoWakeEnabled` 都是主会话专属可选布尔 |
| 配置校验 | `packages/server/src/config/section-checks.ts:187-225`、`section-checks.ts:826-880` | server 开关与 convergence 四值校验；改配置需重启 |

### 1.3 哪些字段被机器消费

| 字段 | 主会话 | 侧会话 | 证据 | 迁移处置 |
|---|---|---|---|---|
| `status` | 是。终止 stopReason、`MainLoopResult` 回执、idle 帧、UI | 是。映射为 `RunLaunchResult.status` | `machine.ts:167`、`loop.ts:470-479`、`project.ts:185`、`side-session-port.ts:161-169` | 主会话映射为 flow `state`；侧会话保留 |
| `wake` | 是。只有键存在时武装或清除 | 否。side schema 无此键，携带即拒收 | `registry.ts:1143-1155`、`receipt.ts:121-123` | 主会话映射为 `next_decision_at`；侧会话不迁 |
| `digest` | 否。事件投影不读，loop 只透传 | 是。账本、死信、任务视图 | `mapping.ts:141-151`、`kernel.ts:487-550`、`task-api/types.ts:132-134` | 主会话丢弃；侧会话保留 |
| `body` | 否。不在主 schema，解析层可收但无读取方 | 侧 schema 也没有 `body` | `tool.ts:79-92`、`tool.ts:166-167` | 主会话丢弃 |
| `pointers` | 否。主 schema 可选，无读取方 | 是。产物快照与任务视图 | `tool.ts:86`、`kernel.ts:518-528`、`task-api/types.ts:132-134` | 主会话丢弃；侧会话保留 |
| `blockers` | 否。主 schema 可选；投影读取分支类型写错，实际永不命中 | 是。死信与任务视图 | `tool.ts:87`、`mapping.ts:150`、`kernel.ts:529-550` | 主会话丢弃；侧会话保留 |
| `runId`/`workflow`/`attempt` | 不适用 | 是。账本行身份与回执验证 | `tool.ts:101-103`、`side-session-port.ts:156-185` | 侧会话保留 |
| `receipt` 对象 | 机器消费仅 `status` 与 `nextWakeAt` | 是。`TerminalSnapshot.receipt` 留审计 | `loop.ts:190-225`、`kernel.ts:487-495` | 主会话终止不再依赖完整回执；侧会话保留 |

三个硬事实必须在迁移中反复核对：

1. 主会话 `body` 不在 TypeBox schema 里（`tool.ts:79-92`），解析层虽然接受可选 `body`（`tool.ts:166-167`），但没有任何机器读取方。主会话真正的控制信号只有 `status` 与 `wake`。
2. 工具结果本身不能终止 run。`execute` 只写 `ACCEPTED_SLOT` 并返回 toolResult（`tool.ts:180-191`）；内核在 tool batch 之后仍会进入 `onTurnEnd`（`packages/core/src/session.ts:2156-2158`），只有 `onTurnEnd` 返回 `continue:false` 才触发 abort（`session.ts:2638-2642`），随后 `_runTurnsUntilStop` 才返回 `abort`（`session.ts:2168`）。
3. 侧会话回执必须保留。`status`、`digest`、`pointers`、`blockers` 经 `side-session-port.ts:156-185` 进入 `RunLaunchResult`，再写账本 actual（`kernel.ts:487-498`）、产物快照（`kernel.ts:518-528`）、死信（`kernel.ts:529-550`）与任务详情（`task-api/types.ts:132-134`）。删除这些字段会直接破坏审计面。

### 1.4 文档锚点

| 文档 | 行 | 内容 |
|---|---|---|
| `docs/01-决策冻结-D1-D32.md` | 49-56 | D25/D30/D26 收束终止与上限 |
| `docs/01-决策冻结-D1-D32.md` | 267-270 | D35/D36 回执字段收敛与主会话 wake |
| `docs/02-实施计划-v1.md` | 306-310 | T09 收束工具与验收标准 |
| `docs/02-实施计划-v1.md` | 315-317 | T10 主会话长循环接线 |
| `docs/06-Loom使用文档.md` | 27 | “收束才停”总规则 |
| `docs/06-Loom使用文档.md` | 101-111 | 自动唤醒参数、持久化、关闭方式 |
| `docs/06-Loom使用文档.md` | 359 | 回合不结束的排障口径 |
| `docs/07-调试测试手册.md` | 64-68、88 | 收束终止与阈值回归口径 |
| `docs/07-调试测试手册.md` | 398-448 | 自动唤醒验收、证据、排障 |
| `docs/09-小贺测试Loom作战手册.md` | 603-653 | S16 自动唤醒手工验收 |
| `docs/10-转正实施-runbook.md` | 35-36、62-63 | 生产配置与唤醒验收 |

### 1.5 终止链与 hook 顺序

当前主循环的 hook 数组是 gate 在前、boundary 在后、`extraHooks` 最后（`loop.ts:232-236`）。`onTurnEnd` 是 Event 类钩子，dispatcher 并行执行所有钩子（`packages/core/src/dispatcher.ts:147-160`），合并时第一个 `continue:false` 的 stopReason 生效（`dispatcher.ts:509-511`）。这意味着只把 flow 钩子追加到 `extraHooks` 不够：converge gate 仍会先注册，stopReason 可能仍是 `convergence:*`，账本也可能仍由 converge 写 terminal。

迁移必须同时满足两条：

1. flow 钩子在 `MainSessionLoop.wireParts` 中排在 converge gate 之前（改 `loop.ts:232-236` 的拼接顺序），或等价地把 flow 钩子直接并入 gate 之前。
2. converge gate 在 `onTurnEnd` 读到一个共享的 `flow committed` 槽（同 `turnIdx`、同 `runGen`）时直接放行，不调用 `decideTurnEnd`、不写 terminal、不催办。对应修改点是 `gate.ts:373-391`；槽形状可复用 `ACCEPTED_SLOT` 与 `RUN_GEN_SLOT` 的代际纪律（`tool.ts:38-57`）。

只做顺序不做让位，仍会出现两个终止器同时返回 `continue:false`；只做让位不做顺序，stopReason 仍可能被 converge 抢占。两者必须同时落地，并由测试钉死。

## 2. 信号映射

### 2.1 converge 到 flow

| converge | flow 目标 | 说明 |
|---|---|---|
| `status: "已完成"` | `state: "closed"` | 终止当前 run，关闭当前 subject |
| `status: "待用户回应"` | `state: "waiting_user"` | 终止当前 run，等待用户；`next_decision_at` 可给出下一拍 |
| `status: "需用户确认"` | `state: "waiting_user"` | 终止当前 run；“需要确认”的语义放 subject 备注或等待原因，不再作为独立状态 |
| 无对应 | `state: "active"` | 不终止，继续当前 run |
| 无对应 | `state: "waiting_event"` | 终止当前 run，等待外部事件；只有给出 `next_decision_at` 才安排下一拍 |
| `wake: "30s"/"10m"` 等 | `next_decision_at: <epoch ms>` | 复用同族语法（倒计时支持 s/秒，最小 5s 钳制）；边界策略见下表，当前原型会做钳制 |
| `wake: "none"` | `next_decision_at: null` | 清除该 subject 的下一拍 |
| 省略 `wake` | 省略 `next_decision_at` | 保持已有计划不变，不覆盖 |
| `digest`/`body`/`pointers`/`blockers` | 丢弃 | 主会话没有机器读取方；用户看到的正文就是 assistant 正文 |
| `runId`/`workflow`/`attempt` | 不迁 | 侧会话专用，保留 converge |

`wake` 到 `next_decision_at` 的迁移规则：

| 输入 | 当前行为 | flow 行为 |
|---|---|---|
| 倒计时（`30s`/`10m`）、带时区 ISO、本地时间、`HH:MM` | `resolveWakeSpec` 解析为 epoch ms（`wake.ts:155-180`） | 复用同族语法；当前原型用 `parseFlowTime` 后再套字段边界（`packages/core/src/flow/time.ts:158-212`） |
| `none` | `nextWakeAt = null`，registry 调用 `onAutoWake(sid, null)` 清除（`registry.ts:1144-1148`） | `next_decision_at: null`，调度器清除该 subject |
| 省略 | `nextWakeAt` 键缺席，registry 不调用 `onAutoWake`，已有计划保留 | 省略 `next_decision_at`，已有 `next_decision_at` 保留 |
| 超过 30 天、过去时间、非法格式 | 整体拒收回执（`wake.ts:148-153`） | 语法非法仍拒绝；`next_decision_at` 的目标边界是钳制到 `[now+5s, now+30d]`，过去与过远落到边界；`soft_deadline`/`due_at` 拒绝不晚于 now。此差异必须拍板，见 §3.1 |
| 侧会话携带 | 拒收，提示仅主会话支持（`receipt.ts:121-123`） | 侧会话仍走 converge，不提供 flow 的 wake 字段 |

状态词表有一个必须拍板的语义变化：converge 的 `待用户回应` 与 `需用户确认` 都会折叠为 flow 的 `waiting_user`。如果 UI 或后续逻辑还需要区分“普通等待”与“需要确认”，必须把差异放进 subject 的备注或等待原因字段，不能偷偷加第二个控制状态。否则 flow 又会退化成一套并行状态机。

## 3. 行为等价矩阵

| 场景 | converge 现状 | flow 目标 | 判定 |
|---|---|---|---|
| close | `status=已完成` 受理后 `onTurnEnd` 返回 `continue:false`，stopReason `convergence:converged:已完成`，run 归 `converged`，idle 帧带 `convergence.status` | `state=closed` 对当前 focus subject 终止 run；不安排下一拍；idle 帧带 flow 终态 | PASS，除“关闭时清理旧下一拍”见 restart after close 行 |
| waiting with wake | 终止 run；registry 在 `converged` 后读到 `nextWakeAt` 才武装；到点投递 durable 用户消息并起新一轮（`registry.ts:1143-1155`、`wake-scheduler.ts:203-226`） | `state=waiting_user` 或 `waiting_event` 终止 run；`next_decision_at` 武装一次；到点投递并起一轮 | PASS。投递文案可从 `【自动唤醒】` 改为 flow 决策信封，但“一次唤醒对应一次新 run”必须不变。时间边界差异见 §3.1 |
| waiting without wake | 终止 run；`nextWakeAt` 键缺席，registry 不武装，也不清除旧计划 | 终止 run；省略 `next_decision_at` 保持旧计划；没有旧计划则不安排 | PASS。`soft_deadline` 在迁移期只持久化，不武装，避免引入 converge 没有的额外唤醒 |
| wake none | `wake=none` 产生 `nextWakeAt=null`，registry 调用 `onAutoWake(sid, null)`，调度器删定时器与 sidecar | `next_decision_at=null`，调度器清除该 subject | PASS |
| restart before wake | 唤醒 sidecar 在 `state/session/wake/{sid}.json`，boot 在队列恢复后 restore；过期 24 小时内立即触发，超过 24 小时丢弃（`wake-scheduler.ts:121-162`、`boot.ts:853-862`） | flow 状态文件是下一拍真源；boot 重建调度；同样要定义过期策略并测重启 | 当前未过门。并行原型的 `MemoryFlowStore` 是内存实现（`packages/core/src/flow/memory-store.ts:1-6`），重启即丢；durable JSON store 落地前不得判 PASS |
| restart after close | close 不带 `wake:none` 时，旧 sidecar 不会被清理，重启后仍可能触发一次唤醒 | close 清除该 subject 的 `next_decision_at`；重启后 closed subject 不武装 | 有意差异，需用户确认。这个差异修掉“已关闭还会被唤醒”的旧坑，但不再是逐字节等价 |
| missing commit | 默认强制模式：纯文本或字段不齐催办 5 次后 `forceEnded`，主会话合成“需用户确认”回执（`machine.ts:244-273`）；自然停模式：不催办，直接 `naturalStop`（`loop.ts:463-465`、`loop.ts:541-563`） | 无 flow commit 时不自动进入 waiting；记录 `flow_unset`；run 按内核自然停，不伪造回执 | 有意差异，删除主 converge 前必须拍板。若要求保留催办，flow gate 必须显式增加等价 nudge，不能默认继承 |
| error/abort with pending | 若 converge 已受理但 run 在 `onTurnEnd` 前被 abort，`nextWakeAt` 不会被 registry 武装，已受理的唤醒丢失 | commit 时持久化 `next_decision_at`；只有 run 到达 flow 终态后才武装或投递；abort/error 后重启仍能看到待决策，且不重复投递 | 有意改进，必须用 0 lost/0 duplicate 门证明。不能在工具结果里直接起定时器 |
| multi-subject | 一个会话只有一个隐式 subject，一个唤醒 sidecar，后写覆盖前写 | 每个 subject 独立 state 与 `next_decision_at`；关闭 A 不影响 B；A 的唤醒不清理 B；调度器按 subject 维持定时器或最早者加再武装 | 原型已有 `earliestPending`（`packages/core/src/flow/memory-store.ts:225-249`），但现有 `WakeScheduler` 按 sessionID 单文件（`wake-scheduler.ts:4-6`、`wake-scheduler.ts:175-181`）。调度器未按最早 subject 再武装前，属 BLOCKER |

### 3.1 删除前必须拍板的差异

1. **missing commit 的处理**：converge 默认会催办并强制收束，flow 目标记录 `flow_unset` 后自然停。保留催办还是接受自然停，必须由用户拍板；这决定 `naturalStop` 是否仍是主会话的合法终态。
2. **状态折叠**：`待用户回应` 与 `需用户确认` 合并为 `waiting_user`。若要保留区分，需要额外的展示字段，不能新增终止状态。
3. **close 清理旧唤醒**：flow 关闭 subject 时清理该 subject 的下一拍，converge 现状可能留下旧唤醒。这个差异更安全，但不是逐字节等价。
4. **多 subject 调度**：必须新增按 subject 的调度面，不能把现有单 session sidecar 直接当多 subject 用。
5. **时间边界**：converge 对过去时间与超过 30 天直接拒收；flow 原型把 `next_decision_at` 钳制到 `[now+5s, now+30d]`。严格等价就保留拒收，接受钳制则必须把“1 秒后”变“至少 5 秒后”写进验收。
6. **durable 状态**：当前 `MemoryFlowStore` 重启即丢。restart 门要求先有 JSON store 与 boot 重建，不能拿内存原型过门。

## 4. 测试分桶 A-D

统计口径：只统计 HEAD `19cd6bd` 已跟踪的测试文件，避免把并行 flow 原型的未提交测试算进 converge 分桶。

```bash
git ls-files 'packages/core/src/**/*.test.ts' 'packages/server/src/**/*.test.ts' \
  | xargs grep -lE 'converge|Convergence' | sort | wc -l
```

实测为 55 个文件。当前工作树另有一个未提交的 `packages/core/src/flow/time.test.ts`，裸 `grep -rl` 会得到 56；该文件属于 flow 轨道，不属于 converge 分桶。下面四组互斥，A 7 个、B 30 个、C 13 个、D 5 个，合计 55 个。混合文件按最高风险归入 C，但其中的侧会话用例仍按 A 的保留原则处理。

### A. 侧会话专属保留（7 个）

这些测试只验证 side gate、side 回执、账本或 limits，不随主会话 converge 退役而改写。

```text
packages/core/src/convergence/gate-observer.test.ts
packages/core/src/kernel/kernel.test.ts
packages/core/src/receipt/receipt.test.ts
packages/core/src/recovery/catchup.test.ts
packages/core/src/run-engine/run-engine.test.ts
packages/core/src/run-engine/side-session-context.test.ts
packages/core/src/run-engine/side-session-port.test.ts
```

### B. 机械终止器迁移（30 个）

这些测试把 converge 当作“让主会话结束”的 fixture，断言重点不在回执语义。迁移动作是把脚本里的 `converge` 调用换成 `flow_commit`，把 `converged` 终态断言换成 flow 终态，不重写测试意图。

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

注意：`boot-reminder.test.ts`、`boot-transcript.test.ts` 同时包含侧会话 converge 用例，侧会话部分不得机械替换。

### C. 语义变化重写（13 个）

这些测试断言主会话回执正文、wake、状态词表、强制收束或 `convergenceEnforced`。不能机械换名字，必须先确定 §3.1 的拍板项再重写。

```text
packages/core/src/convergence/auto-wake.test.ts
packages/core/src/convergence/convergence-adversarial.test.ts
packages/core/src/convergence/convergence.test.ts
packages/core/src/main-loop/auto-wake.test.ts
packages/core/src/main-loop/convergence-toggle.test.ts
packages/core/src/main-loop/natural-converge-acceptance.test.ts
packages/core/src/__tests__/continue-run.test.ts
packages/server/src/e2e-datacheck/golden-batch.test.ts
packages/server/src/events/envelope.test.ts
packages/server/src/golden/golden-chat.test.ts
packages/server/src/serve/boot-auto-wake.test.ts
packages/server/src/serve/boot-convergence-toggle.test.ts
packages/server/src/session-api/auto-wake-registry.test.ts
```

逐项改动方向：

| 文件 | 需要重写的断言 |
|---|---|
| `convergence/auto-wake.test.ts` | main 的 digest 派生、body 缺席、wake 解析；保留侧会话 wake 拒收 |
| `convergence/convergence.test.ts` | main 的 nudge、forceEnded、status 词表；保留侧会话 (d2)、(e3) |
| `convergence/convergence-adversarial.test.ts` | main 的强制回执诚实性；保留侧会话 A2、A6 |
| `main-loop/auto-wake.test.ts` | `nextWakeAt` 改为 flow `next_decision_at` |
| `main-loop/convergence-toggle.test.ts` | `convergenceEnforced` 语义改为 flow 开关或退役 |
| `main-loop/natural-converge-acceptance.test.ts` | 以 flow 受理替代 converge 受理；确认 missing commit 的终态 |
| `__tests__/continue-run.test.ts` | `convergenceEnforced:false` 配置项改名或删除 |
| `e2e-datacheck/golden-batch.test.ts` | 收束调用参数不再断言 digest、body、pointers；改断言 flow commit 与账本终态 |
| `events/envelope.test.ts` | idle 帧的 `convergence.status` 改为 flow 字段，或保留兼容 shim |
| `golden/golden-chat.test.ts` | 黄金帧序中的收束族改为 flow 终态族 |
| `serve/boot-auto-wake.test.ts` | converge wake 全链改为 flow `next_decision_at` 全链 |
| `serve/boot-convergence-toggle.test.ts` | 配置开关与自然停全链改为 flow 开关 |
| `session-api/auto-wake-registry.test.ts` | `onAutoWake` 触发条件从 `receipt.nextWakeAt` 改为 flow 终态 |

### D. 侧会话与黄金路径保留（5 个）

这些文件在主会话切换后仍应通过，只允许更新 fixture 字符串或新增 flow 用例，不允许删掉现有回归。

```text
packages/server/src/config/loom-config.test.ts
packages/server/src/events/tool-stream.test.ts
packages/server/src/serve/boot-pty.test.ts
packages/server/src/serve/harness-ui.test.ts
packages/server/src/serve/system-prompt-resync.test.ts
```

其中 `loom-config.test.ts` 的 `convergence` 段必须保留，因为侧会话仍读同一份 limits；`tool-stream.test.ts` 的“converge 不发 part 帧”要扩成“converge 与 flow_commit 都不发 part 帧”；`boot-pty.test.ts`、`harness-ui.test.ts` 只含构造环守卫注释，不应因删除主 converge 而误删。

### 4.1 计数核对

本次核对把四组路径分别写入临时清单，执行 `wc -l` 得到 7、30、13、5，合计 55；再与 HEAD 已跟踪测试的 grep 排序结果做 `comm`，缺失 0、多余 0。可复现模板：

```bash
git ls-files 'packages/core/src/**/*.test.ts' 'packages/server/src/**/*.test.ts' \
  | xargs grep -lE 'converge|Convergence' | sort > /tmp/loom-all.txt
# 将上面 A-D 四组路径分别写入 /tmp/loom-a.txt 到 /tmp/loom-d.txt
cat /tmp/loom-a.txt /tmp/loom-b.txt /tmp/loom-c.txt /tmp/loom-d.txt | sort -u > /tmp/loom-buckets.txt
wc -l /tmp/loom-a.txt /tmp/loom-b.txt /tmp/loom-c.txt /tmp/loom-d.txt
comm -3 /tmp/loom-all.txt /tmp/loom-buckets.txt | wc -l
```

最后一行必须为 0。数字不是从旧文档抄的，是在当前 HEAD 上重新 grep 的结果。若并行 flow 轨道提交了新的 flow 测试，只更新 flow 计数，不要把新 flow 测试塞进 A-D 的 converge 分桶。

## 5. 四阶段发布

| 阶段 | 动作 | 退出条件 | 禁止 |
|---|---|---|---|
| 1. 影子并行 | flow 工具与 flow 钩子进场；flow 钩子排在 converge gate 前；converge 保留；同一 turn 有 flow commit 时 converge 让位；两条链都记 trace | flow 终态、idle、唤醒三项与 converge 对照无丢失；开始 7 天观察 | 删除 converge；删除 side 回执；把 flow 工具加进共享 `toolWiring.tools` |
| 2. 提示词切换 | 主会话 system prompt 与工具描述改为 flow_commit 优先；converge 标为 legacy 回退；侧会话提示词不动 | 主会话 converge 调用趋近 0；flow commit 覆盖主会话终止；7 天观察门通过 | 改 side schema；改历史转录 |
| 3. 删除主 converge 工具与 schema | 只删主会话注册面、主 schema、主会话对强制链的挂载；共享 `machine`/`receipt`/`limits` 保留给侧会话，侧会话 `buildConvergeSession` 与 side schema 原样保留 | §6 五门全过；用户明确批准删除 | 删除共享 `receipt.ts`、`limits.ts`、side 回执消费链；删除历史读取器 |
| 4. 最终清理 | 清理主会话专属开关、文档旧段落、测试桶 C 的旧断言；保留桶 A/D；跑全量 CI | 全量 CI 绿；文档与代码一致；无残留主 converge 引用 | 删侧会话 converge；删账本、死信、任务视图；重写历史 |

### 5.1 阶段 1 的接线清单

1. **主会话专属注入**：flow 工具经 `SessionRegistry` 的主会话 `tools` 缝进入（`registry.ts:978-1022`、`registry.ts:986`），不要加进 `toolWiring.tools`（`tool-wiring.ts:242`）。侧会话端口继续只拿共享工具数组（`boot.ts:692-709`）。
2. **钩子顺序**：在 `MainSessionLoop.wireParts` 里把 flow 钩子放在 converge gate 之前（`loop.ts:232-236`）。`onTurnEnd` 是并行 Event，不能依赖执行先后（`dispatcher.ts:147-160`），只能依赖注册顺序决定 stopReason（`dispatcher.ts:509-511`）。
3. **共享槽**：flow commit 写入 `flow.committed` 槽，字段至少包含 `turnIdx`、`runGen`、`subjectId`。复用 `ACCEPTED_SLOT`/`RUN_GEN_SLOT` 的代际纪律（`tool.ts:38-57`）。
4. **converge 让位**：`ConvergenceGate.onTurnEnd` 在 `gate.ts:373-391` 先检查同 turn 同代际的 flow 槽；命中则直接返回，不调用 `decideTurnEnd`。`ConvergenceTool.execute` 在 `tool.ts:152-193` 同 turn 命中时不再写 `ACCEPTED_SLOT`，返回“flow 已受理，本次 converge 忽略”，不进入催办。
5. **终止映射**：`MainSessionLoop._drive`（`loop.ts:458-511`）需要识别 flow 终态；不要把 flow 终态伪装成 converge `converged` 回执。flow 终态至少暴露 `state`、`subjectId`、`nextDecisionAt` 三个控制值。
6. **idle 与唤醒**：flow 终态走 registry 的非 error 分支（`registry.ts:1171-1173`），最终必发 `session.idle`（`registry.ts:1215-1218`）。唤醒武装点从 `result.type === "converged"` 加 `nextWakeAt`（`registry.ts:1143-1155`）扩展为 flow 终态的 `nextDecisionAt`，`null` 表示清除。
7. **事件面**：`session.idle` 当前带 `convergence.status`（`project.ts:174-188`），UI 直接读该字段（`harness-ui.ts:1175`、`harness-ui.ts:5299-5300`）。阶段 1 可同时带 flow 字段与旧 `convergence` 兼容字段；阶段 4 再决定是否移除旧字段。
8. **调度器**：现有 `WakeScheduler` 按 sessionID 单文件（`wake-scheduler.ts:4-6`、`wake-scheduler.ts:175-181`）。flow 原型已提供 `earliestPending`（`packages/core/src/flow/memory-store.ts:225-249`），应据此维护最早下一拍，触发后重算并再武装；直接复用 session 级 sidecar 会覆盖同一会话的其他 subject。
9. **boot 恢复**：flow 状态扫描放在 `recoverSendQueues` 之后、唤醒 restore 同窗口（`boot.ts:853-862`）。当前 `MemoryFlowStore` 不持久化，阶段 1 前必须先落 durable JSON store；不要把 flow 状态写进 `tasks_state.json` 或 `task_executions.yaml`。
10. **配置开关**：阶段 1 需要单一回滚开关。建议键名 `server.flowEnabled`，缺省 false，staging 显式 true；与现有 `convergenceEnforced`、`autoWakeEnabled` 一样改配置后重启生效，无热重载（`section-checks.ts:25-27`、`section-checks.ts:58`）。

阶段 1 的“flow 赢”判据是行为判据，不是代码判据：同一 turn 同时有 flow commit 和 converge 调用时，最终 stopReason 必须是 flow 前缀，gate 账本不得出现 converge `converged`，idle 帧不得同时出现两套终态。

## 6. 删除门禁

| 门 | 阈值 | 证据 | 当前状态 |
|---|---|---|---|
| 7 天观察 | 连续 7 个自然日，覆盖至少一次跨夜、一次重启、一次忙时唤醒 | 每日对照报告，记录 flow 终态、converge 回退、唤醒、idle | 运行中（至 2026-10-30）；当前 25 delivered / 14 lost，gate FAIL；仍需覆盖跨夜、重启与忙时 |
| 0 丢失或重复唤醒 | `scheduled next_decision_at` 数 = 实际投递数 = 新增 run 数；重启后不重复 | flow 状态文件、wake 日志、`deliverWake` 记录、session turns 对照 | FAIL：当前 lost=14，wake_delivered=25 |
| 0 个 flowEnded 无 idle | 每个 flow 终态 run 恰好对应一条 `session.idle` | trace 或事件日志按 `sessionID` 与 turn join；缺失即失败 | PASS：当前 flowEndedWithoutIdle=0 |
| 全量 CI 绿 | `npm run typecheck` 与 `npm test` 全绿 | 仓库根命令；侧会话测试、黄金路径、契约帧均包含 | PASS：230 文件 / 2725 tests；typecheck exit 0 |
| 用户明确批准 | 删除主 converge 前一次明确批准 | D10 要求；批准记录进执行日志 | 未批准 |

补充观测项，不替代五门：

- 主会话 converge 调用数在提示词切换后应为 0；若仍有调用，先查工具是否仍暴露、提示词是否仍提旧工具。
- `flow_unset` 计数按天记录；若比例过高，先修提示词或 flow 工具描述，不要直接恢复 converge。
- 侧会话 converge 与死信用例必须全绿，证明删除主面没有误伤共享模块。

## 7. 不可删除清单

| 项 | 位置 | 原因 |
|---|---|---|
| 侧会话 converge 工具与 schema | `tool.ts:30-36`、`tool.ts:94-107`；`kernel.ts:62-85`；`side-session-port.ts:108-202` | 侧会话仍以 converge 回执作为唯一合法终止通道 |
| 回执类型与解析 | `receipt.ts:18-38`、`receipt.ts:146-220` | 侧会话回执、历史转录、审计仍需要 |
| 侧 gate 与 machine | `gate.ts:315-412`、`machine.ts` 全文件 | 侧会话催办、分级强制、死信仍依赖 |
| 账本 actual 与终态快照 | `kernel.ts:487-498`、`run-engine/types.ts:169-180` | `digest`/`pointers`/`blockers` 是账本事实 |
| 产物快照 | `kernel.ts:518-528` | `pointers` 是产物声明，任务视图与验证块依赖 |
| 死信 | `kernel.ts:529-550`、`serve/dead-letter-sink.ts:29-42` | 侧会话 failed 的死信投递与审计 |
| 任务视图 | `task-api/types.ts:131-141`、`task-api/views.ts:130-160` | 展示终态 digest/pointers/blockers |
| 历史 converge 读取器 | `events/mapping.ts:141-151`、`events/project.ts:268-269` | 旧转录与旧事件里的 `details.__convergence` 仍需解析 |
| 历史 marker 与 abortReason | `gate.ts:125-139`、`outcome.ts:118-140`、`gate.ts:238-252` | `_meta.kind="convergence_receipt"` 与 `convergence:converged` 前缀是历史证据 |
| 侧会话 limits 与配置 | `limits.ts:7-23`；`boot.ts:621-629`、`boot.ts:702`、`boot.ts:788`；`section-checks.ts:826-880` | 顶层 `convergence` 段删除后侧会话会失去阈值 |
| 历史转录 | `state/sessions/loom-main.jsonl`、`loom-sessions.jsonl` 及实例内旧转录 | 不改写、不迁移、不删除旧 converge 调用与回执 |
| 唤醒开关兼容层 | `server.autoWakeEnabled` 与 `wake-scheduler.ts` | flow 调度器未接管前不能删；删除需单独的配置迁移 |

## 8. 回滚

| 步骤 | 操作 | 边界 |
|---|---|---|
| 1. 配置回退 | staging 设 `server.flowEnabled: false`，重启 staging 服务；主会话回到 converge 终止链 | 只在 staging；生产重启必须单独明确批准 |
| 2. 代码回退 | 按逆序 `git revert --no-edit <sha>` 回退 flow 阶段提交；不 force push，不改写历史 | 保留 side converge 与回执消费链 |
| 3. 数据处置 | flow 状态文件留在 staging 状态目录，不删除、不导入生产；旧 converge 转录原样保留 | 不做数据迁移，不批量删文件 |
| 4. 回归 | 跑 `npx tsc -b`、`npx vitest run`；重点跑桶 A、D 与 `packages/core/src/convergence`、`packages/core/src/main-loop`、`packages/server/src/serve/wake-scheduler.test.ts` | 全绿才算回滚完成 |
| 5. 记录 | 在执行日志记录回滚原因、commit 列表、验证结果 | 不自动提交，除非用户明确要求 |

回滚期间不得删除 flow 已写出的状态文件用于“清理”，否则会制造 lost wake 证据缺口。若 staging 需要干净环境，归档目录而不是删除。

## 9. 关键风险与拍板项

1. **missing commit 的强制语义**：converge 默认会催办并强制收束，flow 目标不自动等待，只记录 `flow_unset`。这是最大语义差异，删除前必须由用户拍板。
2. **状态折叠**：`待用户回应` 与 `需用户确认` 合并为 `waiting_user`。若 UI 需要区分，只能加展示字段，不能加第二个终止状态。
3. **多 subject 调度**：已用 `#flowWakePlans` 按 session 记录多个 subjectAt，同一 subjectAt 只 arm 一次；boot reconcile 对 overdue 用 `now+5s` 宽限；`flow-wake` 渲染 due 主体列表。
4. **close 清理旧唤醒**：flow 关闭 subject 时清理该 subject 的下一拍，比 converge 现状更安全，但不是逐字节等价。
5. **历史数据**：不迁、不删、不重写。旧 converge 回执只读保留，读者继续兼容 `details.__convergence` 与 `_meta.kind="convergence_receipt"`。
6. **持久化缺口**：已落地 `JsonFlowStore`（subjects/index/unset，atomic/CAS/corrupt-index/path-safety），boot 从真源重建；定向 restart 测试通过；生产 7 天观察仍未开始。

## 10. 本文验证

本次只写文档，未改代码、未提交、未重启任何服务。文档落盘后执行：

```bash
test -s docs/flow-converge-migration.md
git diff --check -- docs/flow-converge-migration.md
git ls-files 'packages/core/src/**/*.test.ts' 'packages/server/src/**/*.test.ts' \
  | xargs grep -lE 'converge|Convergence' | sort | wc -l
```

第三条输出必须为 55。当前工作树有多个未提交的 flow 测试（core/server），裸 `grep -rl` 会高于 55；`git ls-files` 只统计已跟踪的 converge 测试。若未来代码变动导致测试分桶变化，先更新 §4 的路径清单与计数，再更新本文结论，不要沿用旧数字。

新文件是 untracked 时，`git diff --check` 需要先 `git add -N docs/flow-converge-migration.md`，检查后 `git reset -- docs/flow-converge-migration.md`；本次验证按此执行，返回码 0。
