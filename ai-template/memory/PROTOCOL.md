---
tags: [记忆, 协议, PhaseA]
type: memory/protocol
date: 2026-11-14
status: active
owner: human
---

# Memory Protocol · Phase A（2026-11-14）

> 本文件是 memory 的唯一规则源。`README.md` 只做导航；各 agent prompt 只引用本文件。
> Phase A 只做提示词与结构治理：不写 CLI、不建索引、不接 Stratum memory、不全量迁移历史旧档。
> 旧文件冻结，新内容走 `ledger/`、`notes/` 和生成的投影。

## 1. 分层

| 层 | 目录/文件 | 作用 | 是否注入 |
|---|---|---|---|
| 证据 | `{AI目录}/data/daily/`、`{AI目录}/data/reports/`、Stratum | 原始事实与复盘 | 否 |
| 内核 | `ledger/facts.md`、`rules.md`、`open.md` | 稳定事实、规则、未决问题 | 间接 |
| 便签 | `notes/observations.md`、`notes/{cases,persona,judgments,dossiers,topics,proposals}/` | 观察、案例、人格、判断、长尾、提案 | 否 |
| 投影 | `profile/core.md`、`profile/state.md`、`self/必读.md`、`self/身份.md`、`self/active-tasks.md`、`topics/INDEX.md`、`self/SELF-INDEX.md` | 给 agent 读的浓缩层 | 是 |
| 冷档 | `archive/`、`legacy/` | 旧档、退役文件 | 否 |

单向流：`evidence → 02 日复盘 → ledger/notes → projections`。主会话不反写 ledger；03/04 事后审阅/压缩。

## 2. Entry 模型

一条 entry 是一个语义单位，文件只是容器。entry 从 `## <ID> <title>` 开始。

```md
## FACT-{date}-{领域}-01 {一句话事实}
- status: active
- entity: {用户称呼}/{领域}
- attribute: {属性}
- value: {值：事实内容、截止日、口径}
- valid_from: {date}
- valid_to:
- confidence: high
- source: memory/{来源文件}#{锚点}
- owner: 02-daily-review
- review_due: {date}
```

类型与字段：

- `FACT-<domain>-NNN`：`entity / attribute / value / valid_from / valid_to / confidence / source`。
- `RULE-<YYYY-MM-DD>-<scope>-NN`：`scope / trigger / action / exceptions / evidence / confidence`。
- `OPEN-<YYYY-MM-DD>-<scope>-NN`：`question / blocking / evidence / owner`。
- `OBS-<domain>-NNN`：`verification / expires / evidence / confidence`，放在 `notes/observations.md`。
- `NOTE-<YYYY-MM-DD>-NN`：`date / tags / links / source`，放在 `notes/cases/` 或 `notes/topics/`。

> Phase B0：`EPI-...` 情景记忆设计在 `EPISODIC.md`；**B2 前不写 EPI entry**，当前只写 fact/rule/open/observation/note。

通用字段：`status / owner / review_due`。正文建议 ≤500 字；长案例放 `notes/cases/`，entry 只留结论和指针。

## 3. 状态

`active`（默认现行） / `draft`（待审） / `stale`（待复核） / `superseded`（被替代） / `refuted`（已证伪） / `archived`（归档）。

- 默认查询和投影只读 `active`。
- 新值替换旧值：新建 entry，旧 entry 标 `superseded` 并写 `superseded_by`。禁止静默覆盖。
- 到期未复核：`review_due` 过期后由 03/04 标 `stale`，不自动删除。
- 旧 entry 永远保留原文；归档只改 status，不搬文件。

## 4. 归属与读写

| 角色 | 读 | 写 | 约束 |
|---|---|---|---|
| main | `必读 / 身份 / state / core / topics-INDEX / active-tasks` | `notes/proposals/`、`notes/persona/`、`notes/judgments/` | 不写 ledger；不再 `cat >>` 旧文件 |
| 01 数据检查 | `AGENTS-lite / state / core / topics-INDEX / 规律` | 批次理解文件的 `## 关键观察`、`## 转达` | 不写长期记忆；02 从批次收割 |
| 02 日复盘 | `AGENTS-lite / 必读 / state / core / topics-INDEX / 规律` | `ledger/`、`notes/`、6 个投影 | 日更唯一写入者；写前查键/预算/来源；不追加旧文件 |
| 03 双周 | `AGENTS-lite / state / core / topics-INDEX`；旧 `semantic/` 只读 | `notes/observations` 升格、`ledger` 去重/复核、`notes/dossiers` | 事后审阅；不阻塞 02；不自我审批 |
| 04 周报 | `AGENTS-lite / state / core`；旧文件按需只读 | `notes/` 压缩、`archive/`、legacy 压缩记录 | 事后压缩；不改 active rule；不阻塞 02 |
| 05 审计 | 全部只读 | 审计报告 | 不改 memory |

主会话的合法写入口只有 `notes/proposals/`（事实/规则/未决）、`notes/persona/`（人格草稿）、`notes/judgments/`（判断）。用户当场确认的身份/红线，写 `notes/proposals/` 并标 `immediate: true`，由 02 下一次日复盘优先落 ledger/身份；主会话不直接改 `身份.md`。

## 5. 预算

| 文件 | 上限 | 写入者 |
|---|---:|---|
| `profile/core.md` | 8KB | 02/03 |
| `self/必读.md` | 3KB | 02 |
| `profile/state.md` | 3KB | 02 |
| `self/身份.md` | 5KB | 02（用户确认后） |
| `self/active-tasks.md` | 3KB | 02 |
| `topics/INDEX.md` | 2KB | 02 |
| `self/SELF-INDEX.md` | 4KB | 02 |
| `ledger/facts.md` | 25KB | 02/03 |
| `ledger/rules.md` | 25KB | 02/03 |
| `ledger/open.md` | 10KB | 02 |
| `notes/` 热数据 | 200KB | 02/03/04 |
| `archive/` | 不限 | 04 |

超预算：新增必须等量删/压，或改入 `notes/archive`；禁止净增长。投影必须只含 active 内容；`generated: true` 或 `projection: true`。

## 6. 去重

- fact 键：`entity + attribute + scope`。
- rule 键：`scope + trigger + action`（规范化空白/标点后比较）。
- open 键：规范化后的问题文本。
- 同键同值 → NOOP；同键新值 → 新建 entry + supersede 旧 entry；同键同时间冲突 → `OPEN` 或 `notes/proposals` 标冲突，不覆盖。
- 不做行级去重；语义重复由 03 复核。投影每行必须有来源 entry ID 或来源指针，禁止手写复制 daily。

## 7. Legacy 冻结（Phase A）

以下文件从 2026-11-14 起只读，不再追加；新内容写 `ledger/` 或 `notes/`：

- `self/纠错.md`、`self/认知.md`、`self/任务.md`、`self/价值校准.md`、`self/关系.md`
- `profile/semantic/**`
- `topics/*.md`（`topics/INDEX.md` 例外，它是投影）
- `self/人格方案-{date}.md`、`self/人物判断-{主题}.md`（已复制到 `notes/persona/`、`notes/judgments/`，原件冻结备查）
- `self/tasks/*.md` 是业务操作手册，不是长期记忆；按原角色使用，不迁入 ledger。

04 可以压缩/归档 legacy，但必须记录「删了什么、去哪」；01/02/main 不得追加。旧文件仍在，主会话/01 可按需只读。

## 8. 投影规则

- `state.md`：只写当前态，整文件覆盖；不追加按日快照；来源是最近日复盘/批次。
- `必读.md`：只写本轮动作、注意点、关系锚点、active 红线；不复制 state 的日常数据。
- `core.md`：稳定画像摘要 + 指针；不复制 semantic 时间线；≤8KB。
- `identity.md`：身份/不变量/语气；只在用户确认后由 02 更新；≤5KB。
- `active-tasks.md`：只留未完成任务；完整历史进 archive/任务系统；≤3KB。
- `topics/INDEX.md`：一行一话题，链到 `notes/topics` 或 legacy topics。
- `SELF-INDEX.md`：关键词→文件；02 日复盘重写；主会话只读。

## 9. Phase A 非目标

不建 CLI、不建索引、不接 Stratum memory、不全量迁移历史旧档、不重写历史旧档、不改 `memory_audit.py` 的 lite 检查。`memory_audit.py` 的已知漂移在 Phase B 与 CLI/索引一起修；Phase A 用 `MEMORY-STATUS` + 手工预算/键检查验收。

## 10. 验收

- 02 一次日复盘后：ledger/notes 有新 entry，6 个投影立即更新并 commit。
- 次日主会话读到新 `必读/state/core/active-tasks`，不需要读历史旧档。
- 旧文件零增长；新 entry 有 ID/status/owner/source/review_due。
- 同键只有一个 active；无 net growth；投影在预算内。
- 01 只读；main 只写 notes/proposals；03/04 不阻塞次日。
