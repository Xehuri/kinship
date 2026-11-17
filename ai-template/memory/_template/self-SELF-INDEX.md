---
tags: [模板, 记忆, 索引, 投影]
type: template
projection: true
budget_bytes: 4096
---
# self/SELF-INDEX.md（关键词 → 文件导航）

> 02 日复盘每次收割后按实际读写重写；主会话只读。只放导航，不复制规则或正文。

## 先看哪里（按问题类型）

| 要找 | 去哪 |
|---|---|
| 规则 / 事实 / 未决 | `ledger/rules.md`、`ledger/facts.md`、`ledger/open.md` |
| 观察 / 案例 / 判断 / 长尾 | `notes/observations.md`、`notes/cases/`、`notes/judgments/`、`notes/dossiers/` |
| 主会话热投影 | `self/必读.md`、`self/身份.md`、`profile/state.md`、`profile/core.md`、`topics/INDEX.md`、`self/active-tasks.md` |
| 当前任务 | `self/active-tasks.md`（投影） |
| 人格草稿 / 提案 | `notes/persona/`、`notes/proposals/` |
| 话题讨论 | `notes/topics/`、`topics/INDEX.md` |
| 事件 / 报告 / 证据 | `analysis/query.py`、`analysis/query_chatlog.py`、Stratum |
| 领域业务 | `self/tasks/{领域}.md` |
| 身份 / 语气 | `self/身份.md`（定义以 `agents/main.md` 为准） |

## 何时读 / 何时写

| 文件 | 何时读 | 何时写 |
|---|---|---|
| `memory/self/身份.md` | 对外说话前参考署名/语气 | 用户确认后由 02 更新 |
| `memory/self/必读.md` | 会话开始必读（投影） | 02 每日刷新 |
| `memory/profile/state.md` | 需要当前状态 | 02 整文件覆盖 |
| `memory/profile/core.md` | 需要长期背景 | 02/03 更新，≤8KB |
| `memory/self/active-tasks.md` | 需要当前待办 | 02 更新，完成即销 |
| `memory/topics/INDEX.md` | 需要话题索引 | 02 一行一话题维护 |
| `memory/ledger/` | 需要规则/事实依据 | 02 日更；03 复核 |
| `memory/notes/` | 需要观察/案例/判断 | 02/03/04；主会话只写 proposals/persona/judgments |
| `memory/self/tasks/{领域}.md` | 数据检查步骤 8 挂载 | 新增/修改领域职责时写 |

## 已退役（不要重建）

`persona-lite` / `core-lite` / `规律-摘要` / `self/scratch/` / `self/执行日志/`；旧 `self/纠错.md`、`self/认知.md`、`self/任务.md`、`self/价值校准.md`、`self/关系.md`、`profile/semantic/**`、`topics/*.md` 只读备查，不再追加。新内容写 `ledger/` 或 `notes/`。

## 记忆原则

- 记忆是本地文件系统，不是外部 Auto Memory；无增量零写入。
- **值得记 = 会在凌晨压缩中消失且消失有害的信息**（断连续性 / 失判断准 / 丢成长 / 退关系）。
- 写前查键与预算，写后跑 `analysis/memory_finalize.py` 收尾。
