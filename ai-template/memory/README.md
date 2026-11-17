---
tags: [记忆, 导航, PhaseA]
type: memory/readme
date: 2026-11-14
---
# 记忆系统（Phase A，2026-11-14）

> 唯一规则源：`memory/PROTOCOL.md`。本文件只做导航，不重复 schema/预算/归属。
> 当前阶段：提示词 + 结构治理。CLI、索引、Stratum memory 统一放到 Phase B。
> 真源：`ledger/`、`notes/` 和旧文件（冻结备查）；投影是生成/提炼层，不是真源。

## 快速导航

| 要什么 | 去哪 |
|---|---|
| 规则/事实/未决 | `ledger/rules.md`、`ledger/facts.md`、`ledger/open.md` |
| 观察/案例/人格/判断/长尾 | `notes/observations.md`、`notes/cases/`、`notes/persona/`、`notes/judgments/`、`notes/dossiers/` |
| 主会话热投影 | `self/必读.md`、`self/身份.md`、`profile/state.md`、`profile/core.md`、`topics/INDEX.md`、`self/active-tasks.md` |
| 旧文件为什么还在 | `legacy/FROZEN.md`；旧文件只读，不再追加 |
| 写入规则 | `PROTOCOL.md` §2–§8 |
| 当前状态/检查 | `MEMORY-STATUS.json`（运行期生成）、`self/SELF-INDEX.md` |
| 话题与提案 | `topics/INDEX.md`、`notes/topics/`、`notes/proposals/` |

## Phase B0（设计，未启用）

- **EPI 情景记忆设计**：`EPISODIC.md`（12 字段、准入闸门、wake digest、cue recall、遗忘/巩固）。
- **30 cue gold set 模板**：`eval/EPI-GOLDSET-TEMPLATE.md`。
- **状态**：B2 前不写 `EPI-` entry；当前 02 只写 `ledger/`、`notes/`、6 个投影。

## 分层

| 层 | 内容 | 是否注入 | 写入者 |
|---|---|---|---|
| 证据 | `{AI目录}/data/daily/`、`{AI目录}/data/reports/`、Stratum | 否 | 01/02/03/04 |
| 内核 | `ledger/facts.md`、`rules.md`、`open.md` | 间接 | 02 日更；03 复核 |
| 便签 | `notes/observations.md`、`notes/{cases,persona,judgments,dossiers,topics,proposals}/` | 否 | 02/03/04/main（仅 notes/proposals） |
| 投影 | `profile/core.md`、`state.md`、`self/必读.md`、`身份.md`、`active-tasks.md`、`topics/INDEX.md`、`SELF-INDEX.md` | 是 | 02 主写；03/04 校正 |
| ↑ 其中 `self/必读.md` 的「**硬事实（不许压缩）**」节 | 项目名/人/截止日/住址这类不可丢的硬事实 | 是 | **重写时逐字保留**；缺节或少于 3 条即投影失败 |
| 冷档 | `archive/`、`legacy/` | 否 | 04/迁移 |

## 角色

- **主会话**：读 6 个投影；写 `notes/proposals/`、`notes/persona/`、`notes/judgments/`；不写 ledger，不追加旧文件。
- **01 数据检查**：读 `AGENTS-lite / state / core / topics-INDEX / 规律`；不写长期记忆，观察写批次文件。
- **02 日复盘**：日更唯一写入者；写 `ledger/`、`notes/`、6 个投影；结束后 commit，次日主会话直接可读。
- **03 双周**：事后审阅；观察升格、去重、过期标记；不阻塞 02，不自我审批。
- **04 周报**：事后压缩；notes/legacy/archive；不改 active rule，不阻塞 02。
- **05 审计**：只读；核对预算/新鲜度/旧文件是否增长；只报不改。

## 预算

`core` 8KB、`必读` 3KB、`state` 3KB、`身份` 5KB、`active-tasks` 3KB、`topics/INDEX` 2KB、`SELF-INDEX` 4KB；`ledger` 合计 ≤60KB；`notes` 热数据 ≤200KB；`archive` 不限。超预算不净增长。

## 冻结

`self/纠错.md`、`self/认知.md`、`self/任务.md`、`self/价值校准.md`、`self/关系.md`、`profile/semantic/**`、`topics/*.md`（`topics/INDEX.md` 除外）、`self/人格方案-{date}.md`、`self/人物判断-{主题}.md` 从 2026-11-14 起只读。新规则/观察/任务/长尾写 `ledger/` 或 `notes/`。详见 `legacy/FROZEN.md`。

## 退役

`persona-lite.md`、`core-lite.md`、`规律-摘要.md`、`self/执行日志/`、`self/scratch/` 已退役，不重建。`memory_write.py` 不使用。

一切按需，无增量零写入。写前查键，写后核预算，commit 前跑 `memory_finalize.py`。

## 目录结构

```text
memory/
├── PROTOCOL.md          ← 唯一规则源
├── README.md            ← 本文件（导航）
├── EPISODIC.md          ← EPI B0 设计（未启用）
├── MEMORY-STATUS.json   ← 收尾状态（运行期生成，模板不预置）
├── eval/                ← EPI gold set 模板
├── ledger/              ← facts / rules / open
├── notes/               ← observations + cases/persona/judgments/dossiers/topics/proposals
├── legacy/              ← 冻结清单
├── profile/             ← core / state / 规律
├── self/                ← 必读 / 身份 / active-tasks / SELF-INDEX / tasks
├── topics/              ← INDEX（投影）
├── anchors/             ← 锚点侧车目录（运行时生成，不注入）
├── archive/             ← 冷档
└── _template/           ← 文件骨架库（不参与注入）
```

## 工具

- `{AI目录}/analysis/memory_audit.py`：旧检查器，保留参考；Phase A 验收用 `memory_finalize.py`，不要依赖它的 lite 注入检查。
- `{AI目录}/analysis/memory_finalize.py`：收尾门，写 `MEMORY-STATUS.json`，核对改动/投影状态。
- `{AI目录}/analysis/query.py`：统一只读检索入口（事件/观察/报告/证据/记忆/对话）。
- `{AI目录}/analysis/query_chatlog.py`：按时间窗检索过去对话。
- 脚本统一用 `{Python解释器路径}` 执行；`analysis/` 内其余工具见各脚本头部说明。

> 未替换 `{date}` 占位符时，`memory_audit.py check` 会报 `projection.missing_updated`，属预期；替换并刷新投影后应为 0 errors。`daily.no_dates` 在还没有数据目录时也是预期 warning。

## 模板使用（新实例）

1. **替换占位符**：`{主智能体名称}`、`{用户称呼}`、`{项目名称}`、`{AI目录}`、`{date}`、`{月}`、`{年}`、`{领域}`、`{人物}`、`{事项}`、`{Python解释器路径}` 换成实际值。
2. **骨架库**：`_template/` 只存写法骨架，不被注入；实例需要哪个文件就从这里复制并填占位符。
3. **按 PROTOCOL 建首条 entry**：先写 `ledger/facts.md`、`ledger/rules.md`、`notes/observations.md`，再由 02 生成 6 个投影。
4. **运行期产物**：`MEMORY-STATUS.json`、`anchors/*.jsonl` 由脚本生成/覆盖，模板不预置。

## 管理原则

- **只写本地文件**，不写入编辑器的 Auto Memory。
- **每条记录标注时间与来源**：`[{date} 来源]`，来源可以是理解文件、会话、复盘。
- **条目 = 浓缩事实 + 日期 + 指针**，不复制正文，细节留在当日复盘。
- **一事一议**：人物、事项各建长尾档（`notes/dossiers/`），稳定事实抽到 `ledger/facts.md`。
- **按需增删，无增量零写入**：不值得记的不写。
- **归档而非删除**：旧内容移入 `archive/`，保留历史可追溯；按 `{年}` 分档。
- **防膨胀**：新收集类文件先定分片键、单文件上限、索引位置。
