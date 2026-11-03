---
title: Loom think / 锦囊机制研究
date: 2026-10-30
status: 研究稿（未实现）
scope: 主会话优先；分析批次后续
---

# Loom think / 锦囊机制研究

> 公开脱敏版。个人对话、运行数据、私有记忆路径已省略；完整研究记录保存在私有运行区。

## 0. 摘要

这份文档记录为 Loom 主会话增加“慢思考 / 回复质量”机制的研究与设计。

核心结论：

1. 问题不是“模型想得不够久”，而是开口前没有拿到对的**判断框架**、**证据来源**、**语域**和**修复方式**。
2. 现有纠错本是**冷存储**：不注入主会话，只靠指针和按需检索；模型经常不去查。
3. 方案不是“每轮拉满思考”，而是：**think = 每轮从锦囊取 1–3 条情景/方法/经验卡，作为显式提示资源注入；复杂轮再升级全量 plan**。
4. 锦囊由复盘维护，不由主会话拍脑袋写；卡需要时间积累，系统和人要慢慢磨合。
5. 预期改善框架、来源选择、语域和修复行为；它不是银弹，未覆盖的新情况和模型自身的校准上限仍在。

## 1. 问题

### 1.1 失败类型

主会话的回复质量失败可以归为几类：

- **意图/框架错误**：答了另一个问题；把测试当玩笑；把分享当委托。
- **来源选择错误**：用最容易拿到的数据，而不是最直接的证据。
- **语域错误**：用户想被接住时讲分析；用户要一个决定时列选项。
- **未核实断言 / 过度承诺**：没查就说“确实有”；只补了末端就说“修好了”。
- **修复失败**：被质疑先辩解，而不是先验证；只承诺“我会改”，没有动作。
- **行动失败**：写完回复但没有从来源通道发出；没有回读结果。

### 1.2 为什么现有规则没拦住

纠错本里有很多硬教训，但是：

- 它不在主会话的注入记忆里；
- 只能通过顶层指令里的指针，或按需 grep 才能看到；
- 主会话系统提示已经很长，再加规则会稀释注意力；
- 模型经常在该用规则的时候不去检索。

所以系统有一个**冷存储问题**：规则存在，但在需要的时候没有被消费。

### 1.3 设计目标

在模型开口前，给它对的**约束**；不注入整库规则；不要求每轮都做全量思考。

## 2. 目标与约束

### 2.1 目标

- 提升框架/意图、证据来源、语域和修复行为的准确率。
- 让每天的纠正能被系统吸收。
- 质量可审计、可积累、成本可控。
- 不破坏现有 Loom 架构与稳定性。

### 2.2 硬约束（代码事实）

- 主会话的 `model` / `llmOptions` 在构造期冻结。不能按轮换模型；只能加 per-turn effort resolver，或用子智能体会话。
- 工具列表是静态的。按轮收窄必须用 `transformToolsBeforeLlm`（隐藏）+ `onPreToolUse`（硬拒）。
- session JSONL 的 entry kind 是封闭 union（message / compaction_boundary / terminal）。路由/方法卡不能写进 session 存储，只能进 trace。
- systemPrompt 是 prompt-cache 锚点。每轮模式/方法卡只能作为 transient `additionalContext` 注入尾部。
- flow / convergence 是终止机制，不适合承载 per-turn mode；mode 层应独立。

### 2.3 原则

1. 检索，不注入整库。
2. 默认 light，复杂才 full。
3. 推荐，不自由点菜：`primary + alternatives`。
4. 参数由 harness 应用，不由模型自己调。
5. Guard 验收，不相信模型自述。
6. 宪法常驻，锦囊管情境。
7. 纠错是真源，锦囊是投影。
8. scope 分家：chat / analysis / ops。
9. 自迭代有审核、有版本、有指标。

## 3. 外部研究

### 3.1 过度思考与测试时计算

- Snell et al. 2024（arXiv:2408.03314）：按题目难度分配测试时计算，效果可以超过“换更大模型”；简单题和难题的最优预算差很多。
- “When More Thinking Hurts”（arXiv:2604.10739）：前期每 500 token +3.2% 准确率；超过 12K 边际收益转负；简单题约 1.5K 达峰、难题约 8K；约 7K 后“把对的改错”多于“把错的改对”。
- ACL 2026 “Do LLMs Overthink Basic Math Reasoning?”：推理模型可生成约 18 倍 token，但有时更差；准确率-冗长关系非单调。
- 结论：**不要每轮拉满**；按难度和风险分配预算。

### 3.2 自我修正的局限

- Huang et al. ICLR 2024（arXiv:2310.01798）：没有外部反馈时，LLM 很难修正自己的推理，有时越改越差。
- 结论：**审计/反思不能替代外部证据**；critic 必须基于工具结果或原始数据。

### 3.3 CoVe（Chain-of-Verification）

- Dhuliawala et al. 2023（arXiv:2309.11495）：先草稿 → 生成验证问题 → 独立回答这些问题（不看成稿）→ 再改写。
- 列表任务上把幻觉实体从 2.95 降到 0.68；MultiSpanQA F1 +23%。
- 结论：**先查再答**比“再检查一遍”可靠。

### 3.4 生产模式

- Anthropic “Building Effective Agents”（2024）：routing、prompt chaining、orchestrator-workers、evaluator-optimizer。
- evaluator-optimizer 适合“评估标准明确、迭代能带来可测收益”的场景；每次迭代都增加成本。
- 结论：路由 + 生成 + 评估是成熟模式，但评估不能替代接地。

### 3.5 澄清

- ClarifyGPT（arXiv:2310.10996）：先检测需求是否歧义，再生成有针对性的澄清问题。
- 对“分享 vs 求助”这类模糊输入有效；对不喜欢被反问的用户，低风险时按最可能理解回答并说明假设，高风险时只问一个最小问题。

### 3.6 LLM-as-a-judge 偏差

- “Self-Preference Bias in LLM-as-a-Judge”（arXiv:2410.21819）：同模型裁判偏爱自己的风格；还有位置偏差、冗长偏差。
- 结论：critic 最好换模型，或用证据化 rubric。

### 3.7 模型特性

- 生产模型是成本/agentic 优化的模型，支持连续 reasoning effort；它面向 agentic 任务和成本，不一定面向深度判断。
- 其后训练使用自反馈；这有帮助，也可能带来自我确认。外部证据仍然必要。
- 对高风险判断，可能需要更强模型，或换模型做 critic。

## 4. 方案演化

### 4.1 分类器 / 路由

- 最初想法：每轮先分类（reply/lookup/act/research/deep），再执行。
- 发现：分类器可以用规则 + 小模型；但真实用户消息往往很短、强上下文依赖；单消息分类不可行，需要最近 2–4 条 + flow state。
- 发现：模型自己路由会在情绪/分享轮过度调用，在部分测试轮漏调。

### 4.2 全量 plan → 回填上下文

- 想法：跑一次全量上下文的 think 请求，把结果放回上下文，再回答。
- 实验：13 条代表性回合，全量上下文，只输出思考卡。
  - v1：10/13 框架正确；修复/情绪/行动/冲突证据表现好；短句测试仍被读成玩笑；“为什么”类问题仍漏掉最直接的音频来源。
  - v2 加显式框架规则、来源优先级、工具清单：13/13 框架基本正确；短句测试改判为 test；“为什么”类来源改为 audio/chatlog/GPS。
  - 成本：8.2K–28.1K 输入 token，716–1394 输出，7.1–13.8 秒/次。
- 结论：规则能修框架/来源，但每轮全量 plan 太贵。

### 4.3 think 作为工具

- 想法：给主会话一个 `think` 工具，在非简单场景使用。
- 工具调用意愿测试（18 条；软/硬两版提示）：
  - 软：该调召回 8/10；简单/情绪/分享轮误报 6/7；漏掉两个短句测试。
  - 硬：召回 9/10；误报 5/7；漏掉一个行动/修复类。
  - 关键：即使调用了，模型也可能在参数里写错框架或来源。
- 结论：工具解决“能不能想”，不解决“该不该想”和“想得对不对”；需要门禁和纠错层。

### 4.4 planner + replyer

- 参考 MaiBot 式双请求：planner 决定做什么，replyer 生成最终回复；replyer 可以驳回 planner。
- 教训：单向 plan → execute 会放大 planner 错误；执行方需要反馈/驳回通道；planner 最多改一次。
- 对 Loom：主会话模型/上下文冻结，不能照搬双模型；可借鉴“决策与表达分离”和“可驳回”。

### 4.5 锦囊 / 三卡

- 想法：think 可以是“锦囊”，提供回复方法、思考方法、执行方法，甚至设置思考参数；锦囊可以自迭代。
- 纠错本是现成原料：它已经有“坑 / 对 / 案例 / 触发场景 / 判据 / 血案”。
- 三种卡：
  - **情景卡（scenario）**：现在是什么局面（框架/线程/长度/来源）。
  - **方法卡（method）**：这一轮怎么做（do / dont / params）。
  - **经验卡（experience）**：为什么不能那样做（案例/教训）。
- 与 skill 的关系：skill 是任务能力包；think card 是回合行为卡。可共用格式/索引/版本，但不能共用触发方式。

### 4.6 light / full / off

- 修正：情绪发泄不应是 `no_think`；它需要一张“不要分析”的方法卡。
- 最终：
  - `light`：所有用户消息默认；检索 1–3 条卡；不跑 LLM。
  - `full`：复杂/高风险/被质疑/证据多；检索 + 全量 plan。
  - `off`：定时任务/系统消息/极短确认。

## 5. 最终 think v1

### 5.1 定义

> `think` 不是“让模型想更久”，而是“开口前从锦囊取当前最相关的 1–3 条方法，作为显式提示资源注入；复杂轮再升级为全量 plan”。

### 5.2 架构

```
用户消息
  → Depth Gate（规则，毫秒级）
      ├─ off：定时任务/系统消息/极短确认
      ├─ light：所有用户消息（默认）
      └─ full：复杂/高风险/被质疑/证据多
  → Playbook Retrieval（scope=chat）
      → 情景卡优先；再取方法卡/经验卡
  → Method Card（primary + alternatives + params）
      → transient system-reminder 注入
  → 主模型按 primary 执行
  → Guard 检查 do/dont/params
      → 违规：repair think 一次 / 重写
  → Trace
```

### 5.3 卡片 schema

```yaml
id: chat-test-no-hints
scope: chat                    # chat | analysis | ops（v0 只做 chat）
kind: method                   # scenario | method | experience
status: active                 # active | experimental | superseded | archived
version: 1
priority: 90
tags: [frame:test, intent:where, source:gps]
when: 用户使用短句测试，且问题指向可查事实
do:
  - 查最直接来源（GPS/perception/chatlog/audio）
  - 给具体时间/地点/原文
dont:
  - 要提示
  - 反问
  - 说“我猜”
  - 拿睡眠/心率数据顶替
params:
  effort: medium
  mode: lookup
  sources: [gps, chatlog, audio]
  max_tool_calls: 3
links:
  scenario: scenario-test-short-no-hints
  experience: exp-no-hints-10-30
source: 私有纠错本
created_at: ...
updated_at: ...
used_count: 0
success_count: 0
failure_count: 0
```

### 5.4 检索

- 输入：当前消息 + 最近 4 条 + flow state（subject/state/focus）+ 来源 + 最近纠正标记。
- 步骤：
  1. `scope=chat`，只取 active/experimental；
  2. 规则判 frame（test/play/ask/challenge/repair/vent/act/share）；
  3. 先匹配 scenario 卡（frame/线程/长度/来源/最近纠正），再取 links 的 method/experience；
  4. 无 scenario 时，按 tags + 关键词 + priority 取 1–3 条；
  5. `primary` = 第一条；`alternatives` = 后两条；无命中 → general 条目；
  6. 冲突 → 高 priority / 更具体 scope 赢，卡片标 conflict。
- v0 不做：向量库、embedding、LLM rerank。

### 5.5 深度门禁

| 档位 | 触发 | 行为 | 成本 |
|---|---|---|---|
| `off` | 定时任务/系统消息/极短确认 | 不检索 | 0 |
| `light` | 所有用户消息默认 | 检索 1–3 条，注入卡；不跑 LLM | 几乎 0 |
| `full` | 复杂/高风险/不可逆/被质疑/证据多/light 置信度低 | 检索 + 全量 plan；跑一次 LLM | 中高，按需 |

- light 由 harness 推送；full 可由门禁升级，也可由模型 `think(depth="full")`。
- 每轮 light/full 各最多 1 次；定时任务不触发。

### 5.6 方法卡

```
METHOD: chat-test-no-hints (primary, score .94)
FRAME: test
EFFORT: medium
MODE: lookup
SOURCES: gps, chatlog, audio
DO:
1) 查 GPS/perception 最新点
2) 给具体地点+时间
DONT: 要提示 / 反问 / 我猜 / 拿睡眠或心率顶替
ALT: chat-gps-first (.88), chat-no-hints (.81)
CONFIDENCE: .9
```

- transient `system-reminder`；不改 systemPrompt、不落历史。
- 不给用户看；light 卡 <300 token；full 卡追加一段 plan。

### 5.7 执行与 guard

- 模型按 primary 执行；多帧可组合一条 alternative。
- harness 应用 params：effort 走 per-turn resolver；mode/sources 走提示/工具选择；max_tool_calls 走执行上限。
- Guard 检查：违反 dont、漏掉关键 do、超过 max_tool_calls。
- 违规 → repair think 一次 / 重写；再违规 → 降级（说不知道/只报已知）。
- Guard v0 用规则，不用 LLM。

### 5.8 自迭代 / 磨合

```
纠错本（真源）
  → 02 复盘：写/改条目，生成 pending
  → 审核：用户/复盘/审计批准 → active
  → 锦囊（投影）：chat / analysis / ops
  → think 检索 → 方法卡 → 执行
  → 指标：used / success / failure
  → 修剪：失败高 → experimental/archived；14 天没用 → archived
```

- 主会话只能 `propose_playbook`，不能直接改 active。
- 每条带 `version / source / updated_at / source_hash`。
- 锦囊可热加载，不需要重启 Loom。
- 用户每天的意见路径：意见 → 纠错/复盘 → pending 卡 → active → 下一轮检索命中；不靠主会话记得。

### 5.9 主会话瘦身

保留“宪法”，其余移到锦囊：

| 保留（常驻） | 移到 chat 锦囊 |
|---|---|
| 身份、语气核心、边界 | 口吻细则、表情包、决策、修复、来源优先级 |
| 当前主线/任务/红线 | 通道细则、工具纪律、写操作 |
| 冲突优先级 | 具体案例、历史血案 |
| 通用方法（1–2 行） | 场景化 do/dont |

目标：6K token → 3–4K token + 200–300 token 方法卡。  
不缩身份/状态/安全红线；不把锦囊整库注入。

### 5.10 v0 范围

- 只做主会话；分析批次后续用同一个 `consult(scope="analysis")` 扩展。
- 先写 10–15 条 chat 卡，覆盖最痛的失败类型：
  - 情绪安抚
  - 短句测试、不许要提示
  - 个人动机类：先查音频
  - 日程类：不要用睡眠顶替
  - 修复类：先验证再认错
  - 过度承诺：说清哪半修了、哪半没修
  - 行动类：执行 + 回读
  - 来源通道：从哪来、回哪去
  - 玩 vs 解释
  - 决策类：给一个决定
  - 能力问题：先查再答
  - 不展示中间层
  - 不反复要许可
  - 早晨第一句不是任务
  - 写操作失败先查结果
- 先实现 light 检索 + 门禁 + 卡片注入；full 可后置。
- 用一组 held-out 真实回合测试：
  1. 检索 primary 是否命中正确情景/方法；
  2. 深度门禁是否选对 light/full/off；
  3. 答案是否遵守卡（dont 违反率、do 漏项）；
  4. 质量指标：意图、无据断言、过度承诺、语域、用户纠正。
- 对比：单请求 baseline / think light / think full。

### 5.11 暂不做

- 分析批次（后续；用 `consult(scope="analysis")`）。
- 工具白名单/强制钩子（先用卡 + params + guard）。
- 每轮全量 plan（只有 full 用）。
- 只靠模型自觉触发（harness push light）。
- 向量检索/embedding（标签 + 关键词优先）。
- 无审核自迭代（必须 pending → active）。

## 6. 实验与发现

### 6.1 全量 plan（13 条代表性回合）

- v1：10/13 框架正确；修复/情绪/行动/冲突证据表现好；短句测试仍被读成玩笑；“为什么”类漏掉最直接音频来源。
- v2 加显式规则：13/13 框架基本正确；短句测试改判 test；“为什么”类来源改为 audio/chatlog/GPS。
- 成本：8.2K–28.1K 输入 token，716–1394 输出，7.1–13.8 秒。
- 结论：规则能修框架/来源，但每轮全量 plan 太贵。

### 6.2 缩减上下文（10 条）

- flow note + 上一条 assistant：8/10；flow note 把旧结论/旧主题重新锚回来。
- 最近 4 条：9/10；一个行动/修复类被误判为情绪+修复，plan 空。
- 只当前消息：8/10；一个短追问丢失指代；一个行动类太泛。
- 结论：flow note 不是安全摘要；线程依赖的回合需要 recent4 或全量。

### 6.3 极短上下文（10 条）

- 一句系统提示 + 规则 + current/recent2/recent4；输入 906–1308 token，4.5–9.7 秒。
- 框架 10/10 正确；来源方向也对。
- 变差的是具体性：少了数据路径/工具细节/通道脚本；recent4 是甜点，recent2 有时 plan 空。
- 结论：规则能撑框架/来源；完整人设不是 plan 必需，但 answer 需要。

### 6.4 工具调用意愿（18 条）

- 软：该调召回 8/10；简单/情绪/分享误报 6/7。
- 硬：召回 9/10；误报 5/7。
- 即使调用，模型有时会在参数里写错框架/来源。
- 结论：模型愿意调，但会过度调用/漏调，也会把错误写进参数；需要门禁 + 纠错层。

### 6.5 真实消息分布

- 一组真实短消息样本：平均约 6.5 字，中位约 6 字；约 76% ≤8 字；全部 ≤15 字。
- 大量是追问、挑战、修复；单消息分类不可行。
- 结论：检索/门禁必须用最近消息 + flow state，不能只看当前一句。

### 6.6 关键结论

1. 全量上下文能改善社交/修复/情绪/冲突证据，但不是万能。
2. 模型容易“沿着可算的数据想”，而不是“沿着问题想”。
3. 规则能修框架/来源，但可能过拟合；需要 held-out 验证。
4. flow note 不是中性摘要，会锚定旧错误。
5. 极短规则 + recent4 可行；完整人设属于 answer，不属于 plan。
6. 工具意愿不是最大问题；过度调用和参数错误才是。
7. 纠错本是冷存储；需要一个消费入口。

## 7. 效果预想

### 7.1 主会话变化

- 每轮多一步“取卡”：harness 取，不是模型想。
- 首答前有显式方法卡：frame/do/dont/params。
- 工具选择被卡约束：GPS/audio/chatlog，不再靠“最容易的数据”。
- 语域被预设：情绪→安抚；测试→判断；修复→认错。
- 回答后 guard 检查；违规则 repair。
- 上下文变短：宪法 + 卡，而不是 6K 规则。
- 不再依赖模型记得去 grep 纠错本。

### 7.2 失败类型改善

| 失败类型 | 拦截方式 | 预期 |
|---|---|---|
| 意图/框架 | 情景卡 + 框架规则 | 高 |
| 来源选择 | 方法卡 `sources` + 来源优先级 | 高 |
| 语域/口吻 | register 预设 + params | 高 |
| 未核实断言 | 方法卡 + guard 扫绝对措辞 | 中高 |
| 过度承诺/辩解 | 修复卡 + guard | 中高 |
| 工具选择 | `params.sources` / `max_tool_calls` | 中高 |
| 未覆盖的新情况 | 无 | 低 |

### 7.3 不会改善

- 卡没覆盖的新问题；
- 检索错或卡错；
- 模型无视卡；
- 模型自身的校准/知识上限；
- 复杂多源仍需 full；
- 深度理解/关系不是卡能完全替代。

### 7.4 效果预估

- 框架/意图、来源、语域：高改善。
- 无据断言、过度承诺/辩解：中高，不会归零。
- 整体：特定失败类可能降一半左右；需要 shadow/A-B 验证。
- 成本：light 检索几乎免费；full 只在高风险轮；中位延迟基本不变。

## 8. 风险与未决问题

### 8.1 风险

1. 卡错/检索错，会把模型带到错的方法。
2. flow note / 旧结论锚定，可能 reintroduce 旧错误。
3. 模型无视卡，guard 只能抓显性违反。
4. 锦囊膨胀成第二个规则堆；需要标签/检索/修剪。
5. 自迭代漂移；需要 pending/审核/版本。
6. 过拟合单次事件；需要重复出现或 experimental 标记。
7. chat/analysis scope 混装；需要分开 store。
8. 托管决策模型可能带来隐私问题；个人数据优先自托管。
9. 卡的质量取决于复盘质量：垃圾进，垃圾出。

### 8.2 未决问题

- 情景卡/方法卡/经验卡是三个文件，还是一张卡三节？
- 检索用纯标签，还是标签 + 关键词 + 小模型 rerank？
- full 的触发阈值怎么定？
- guard 的规则清单怎么定？
- 锦囊热加载还是重启生效？
- 主会话宪法能缩到多短？
- think 是模型可调用工具，还是 harness 每轮注入，还是两者都有？当前倾向：harness push light；模型可 pull full。
- 分析批次何时引入 `consult(scope="analysis")`？
- 是否需要 `propose_playbook` 工具，还是只由复盘写？
- 卡片与 skill 是否共用目录/格式，还是两套 store？

## 9. 下一步（研究/验证，不排期）

1. 写 10–15 条 chat 情景/方法/经验卡，覆盖最痛的失败类型。
2. 用 held-out 真实回合测检索：primary 是否命中正确情景/方法。
3. 测 plan+answer：方法卡能否让实际回复变好。
4. 测 guard：能否抓住“要提示/分析情绪/未核实断言/过度承诺”。
5. 对比三组：baseline / think light / think full。
6. 先 shadow，不拦截；稳定后再 enforce。
7. 分析批次后续：用 `consult(scope="analysis")` 在一个数据源上试点。

## 10. 设计判断

以下是影响最终方案的关键判断：

- **测试不是玩。** 一句“猜”可能是有正确答案的测试，不是接梗；应该触发证据检索，而不是要提示。
- **上下文选择很关键。** planner 的上下文可能太少；要么从 flow 取紧凑状态，要么用全量上下文。短上下文不足以处理线程依赖的回合。
- **只作用于用户消息。** 定时任务、日程计划、检查点不触发。
- **至少思考一轮。** 思考结果要放回上下文，供下一个请求使用。
- **think 作为工具。** 模型可以在非简单场景调用；但工具本身不够。
- **锦囊是显式提示资源。** 不注入整本纠错；只注入当前相关的卡。
- **卡需要积累。** 锦囊随时间变好；系统和人共同磨合。
- **每天的意见要被采纳。** 路径是：意见 → 纠错/复盘 → pending 卡 → active → 下一轮检索。
- **情绪轮也需要方法。** 情绪发泄应拿到“不要分析”的卡，而不是 no_think。
- **主会话装不下所有规则。** 目标是“短宪法 + 检索卡”。

## 11. 参考

- Snell et al. 2024, Scaling LLM Test-Time Compute Optimally…, arXiv:2408.03314
- Zhou et al. 2026, When More Thinking Hurts: Overthinking in LLM Test-Time Compute Scaling, arXiv:2604.10739
- ACL 2026 Findings, Do LLMs Overthink Basic Math Reasoning?
- ACL 2026, The Evolution of Thought: Tracking LLM Overthinking…
- Huang et al. 2024, Large Language Models Cannot Self-Correct Reasoning Yet, arXiv:2310.01798
- Dhuliawala et al. 2023, Chain-of-Verification Reduces Hallucination…, arXiv:2309.11495
- Anthropic, Building Effective Agents, 2024
- Mu et al. 2024, ClarifyGPT, arXiv:2310.10996
- Wataoka et al. 2024, Self-Preference Bias in LLM-as-a-Judge, arXiv:2410.21819
- DeepSeek V4.1 Flash model card（HuggingFace）
- The Decoder, DeepSeek V4.1 Flash 1017…
- MaiBot issue #1808 / maibot-corpus-callosum（planner/replyer 反馈通道）
- Mem0 / MemGPT（长期记忆检索）
