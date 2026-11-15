# Kinship AI 运行时：Loom、dsh 与自带 harness

> 状态：2026-11-15。本文是 AI 运行时选择与定位的唯一真源。适配器接口见 [adapter-contract.md](adapter-contract.md)。
>
> 一句话：Loom 是 Kinship 的默认运行时和完整工作流；dsh 是给已经拥有自己 harness 的用户准备的可选接入路径；其他 harness 按适配器契约接入。

## 1. 边界

Kinship 的后端不做 AI 分析，也不包含音频算法。它只负责接收数据、落盘、调度任务，并把任务投递给一个 AI 运行时。

AI 运行时负责自己的进程、会话、模型、工具和上下文。它读写 `data.ai_root` 下的数据、计划、记忆与运行状态，不修改后端代码和配置。两侧以文件系统和固定 HTTP 契约交互。

| 层 | 职责 | 不做什么 |
| --- | --- | --- |
| 后端 | 接收、存储、调度、投递任务、订阅事件 | 不做 AI 分析，不含音频算法 |
| AI 运行时 | 维护会话、执行工具、读写 AI 根内的数据 | 不碰后端业务代码 |
| 适配层 | 把 harness 的会话能力映射成 Kinship 的固定接口 | 不复制业务逻辑 |

## 2. Loom：默认、一等、完整工作流

Loom 是公开模板的默认运行时（`ai_backend: loom`），由后端托管在 loopback。它不是通用聊天壳，而是围绕 Kinship 的数据格式和工作节拍长出来的一套完整实现。

> Loom 不是通用意义上的优秀 harness，它的价值在于对 Kinship 的数据格式、任务节拍和工具链做了最完整的适配。如果你已经有自己的 harness，强烈建议尝试接入；但需要一定动手能力，不是开箱即用。

Loom 提供的完整工作流包括：

- 任务与调度：数据检查、每日复盘、周报、双周回顾、计划唤醒与自动唤醒按 Kinship 的节拍运行。
- 计划与覆盖：plan 工具维护当日计划、coverage 检查点和长期条目，计划变更有版本与冲突校验。
- 记忆：主会话与批次按不同注入面读取记忆，写入走受控工具，复盘做增量收割。
- Flow 与收敛：主线状态、等待条件、下一决策时间与回合收束都在运行时内维护。
- 压缩：按 ops 与 chat 两个视角生成摘要，只写压缩边界，不重灌全量历史。
- 工具链：PTY、子智能体、通知、收件箱与 QQ 通道按 Kinship 的接口对接。

Loom 的定位：

- 默认：公开模板和 onboarding 的默认选择是 `loom`。
- 一等：文档、安装、运维和排障都以 Loom 为主路径维护。
- 完整：上面的能力不是演示拼装，而是现行工作流的一部分。
- 持续维护：Loom 继续随 Kinship 版本更新，本文不改变它的默认地位。

## 3. dsh：自带 harness 的可选适配路径

dsh 是另一条可选路径，面向已经运行 dsh、并且愿意安装 Kinship 插件包的用户。接入层在 `harness-plugins/`，包含：

- `kinship-bridge`：loopback HTTP 与 SSE，只服务一个绑定的 Kinship 会话；同时转发实时助手流（`kinship/assistant-stream`），并提供手动压缩、模型目录、上下文窗口四个可选端点。
- `kinship-plan`：提供 plan 工具和每日计划。
- `kinship-task-compat`：提供与 Loom 工具名兼容的任务工具。
- `kinship-ui`：dsh Web 左侧栏的 **Kinship** 面板。桥接状态、token 显示/轮换、桥接配置（地址、端口、绑定策略、请求体上限等）、可绑定会话和接入片段都在这一页完成，等价于在 dsh 自己的 UI 里完成接入配置，不需要手改 profile 配置。
- Kinship preset：把 persona、工具面、压缩和计划装配成一个 dsh preset。

后端侧由 `backend/services/dsh_event_bridge.py` 把 dsh 原生事件（含实时流帧）翻译成前端已认得的 SSE 词表，并在 `/health` 里暴露 dsh 探针（bridge 连通性与绑定状态），因此 dsh 模式下网页对话同样有实时流式渲染。

dsh 路径的定位：

- 可选：它不改变 `ai_backend` 的默认值，默认仍然是 Loom。
- 自带：用户自带 dsh、模型和运行环境，Kinship 只维护适配层。
- 有边界：适配器只承诺单会话、消息、状态、事件和收件箱；Loom 的手动压缩、flow 收敛和专有工具面不在等价范围内。
- 已实现参考适配：dsh 适配层已有单元与集成测试；本文不声明所有部署环境的生产可用性，首次接入仍需自行验证。

dsh 是 Loom 之外的另一条可选路径。选择 dsh 的理由通常是你已经有一套自己的 harness 和工具习惯，而不是因为 Loom 不能完成 Kinship 的工作流。Loom 继续作为默认运行时维护；dsh 也不改变这个默认值。

## 4. 未来 harness

任何 harness 都可以作为 Kinship 的 AI 运行时，只要满足下面任一条件：

- 直接实现 [adapter-contract.md](adapter-contract.md) 的端点、会话模型和错误码。
- 写一个等价适配层，把这套契约翻译成该 harness 的原生 API。

dsh 只是一个参考实现，不是唯一答案。`harness-plugins/` 展示了一个完整适配层的结构：bridge、plan、task compatibility 和 preset。后来者可以复用这个结构，也可以用自己的语言和进程模型重写。

## 5. 怎么选

| 你的情况 | 选择 | 理由 |
| --- | --- | --- |
| 想按 Kinship 的完整工作流直接使用 | Loom | 默认、一等、无需自己写适配层 |
| 已经在用 dsh，愿意安装插件并绑定会话 | dsh 适配路径 | 复用现有 harness，保留自己的模型与工具习惯 |
| 想先看一个可运行的适配层再决定 | `harness-plugins/` | dsh 参考实现，包含 bridge、plan 与 task 兼容层 |
| 用的是其他 harness，或准备新写一个 | [adapter-contract.md](adapter-contract.md) | 按契约实现，不依赖 Loom 或 dsh 的内部结构 |

## 6. 能力对比

| 能力 | Loom | dsh 适配路径 | 未来 harness |
| --- | --- | --- | --- |
| 工作流 | 完整：任务、调度、复盘、通知、收件箱按 Kinship 节拍实现 | 由 dsh preset 与插件组合决定；实时流式、手动压缩、模型目录、上下文窗口、`/health` 探针已由适配层补齐 | 由实现方决定，契约只约束会话与消息面 |
| 计划 | 内置 plan 工具、master/overlay 与 coverage 检查点 | `kinship-plan` 提供 plan 工具与每日计划 | 需自行实现或适配 |
| 工具 | 自带工具面，按 Kinship 数据格式调优 | dsh 工具面加 Kinship 兼容工具，模型选择在 preset | 由实现方决定 |
| 维护 | Kinship 主路径，随版本更新 | 用户自持 dsh 与插件版本，Kinship 维护适配层 | 用户自持 |
| 目标用户 | 想直接使用完整系统的人 | 已有 dsh、愿意动手接入的人 | 想深度定制自己 harness 的开发者 |

## 7. 明确警告：自带 harness 需要动手

dsh 或其他 harness 的接入不是点一个开关。至少需要：

- 安装并维护 harness 版本，以及 Kinship 的插件包。
- 准备 AI 根、计划根和 preset 需要的环境变量。
- 在 harness 里创建一个 root 会话，让它运行 Kinship preset 并完成绑定。
- 配置后端的 `ai_backend: dsh`、`dsh.url` 和 Bearer token（配置文件声明，或在设置页的
  AI 后端字段选择 dsh；没有运行时切换按钮），然后按配置加载规则让后端生效。dsh 里的
  Kinship 面板会显示这三项的确切取值，可直接复制。
- 自己检查 bridge 日志、SSE 事件、会话状态和子会话目录。

出问题时，Kinship 只对适配契约内的行为负责，不替用户维护 harness 本身。如果你只想稳定使用 Kinship，选 Loom。如果你已经有自己的 harness，接入值得做，但请把它当成一次集成工作。

## 8. 状态与承诺

| 路径 | 状态 | 说明 |
| --- | --- | --- |
| Loom | 默认，一等 | 公开模板与 onboarding 的默认选择 |
| dsh 适配路径 | 可选，参考适配已实现并验证 | 在真实 dsh 0.2.2-rc.3 上验证过挂载/绑定/投递/SSE 翻译/压缩受理/模型目录/上下文窗口；生产可用性仍按部署环境验证，接口行为以适配器契约为准 |
| 其他 harness | 契约开放 | 按 adapter-contract 实现 |

本文不评价 Loom 在通用 harness 市场上的强弱，也不承诺 dsh 适配路径的生产质量。选择依据是适配完整度、维护成本和你的动手能力。

## 9. 相关文档

- [adapter-contract.md](adapter-contract.md)：适配器端点、会话模型、错误码与安全要求。
- [AI_SYSTEM.md](AI_SYSTEM.md)：Loom 现行架构、任务、记忆与数据流。
- [PROJECT_MAP.md](PROJECT_MAP.md)：目录结构与子系统路由。
- [../ops/CONFIGURATION.md](../ops/CONFIGURATION.md)：`ai_backend`、`loom` 与 `dsh` 配置键。
- [../../loom-harness/docs/06-Loom使用文档.md](../../loom-harness/docs/06-Loom使用文档.md)：Loom 使用文档。
