---
tags: [记忆, 索引, self, 投影]
type: self
date: {date}
projection: true
owner: 02-daily-review
budget_bytes: 4096
---
# SELF-INDEX

> 记忆关键词导航（查什么 → 去哪）。只指向当前源文件，不存正文、不存历史；历史由 git／`{AI目录}/data/daily/` 承担。02 日复盘重写；主会话只读。

## 〇、Phase A 结构

| 查什么 | 去哪 | 备注 |
|---|---|---|
| 记忆规则/读写/预算 | `memory/PROTOCOL.md` | 唯一规则源 |
| 稳定事实 | `memory/ledger/facts.md` | FACT-...，只看 active |
| 耐久规则/偏好 | `memory/ledger/rules.md` | RULE-...，只看 active |
| 未决问题 | `memory/ledger/open.md` | OPEN-...；blocking 才进必读 |
| 观察中（不注入） | `memory/notes/observations.md` | OBS-...，03 复核 |
| 案例 | `memory/notes/cases/` | 长案例，entry 只留指针 |
| 判断/态度 | `memory/notes/judgments/` | NOTE-... |
| 完整画像 | `memory/notes/dossiers/` | 实例约定 `core-full.md` 全文版 |

## 一、投影（每次会话注入）

| 查什么 | 去哪 |
|---|---|
| 当前态（主线/健康/待办/长期口径） | `memory/profile/state.md` |
| 本轮注意点与红线（L0） | `memory/self/必读.md` |
| 稳定画像（身份/学业/关系/偏好/健康基线/地点） | `memory/profile/core.md` |
| 规律表 | `memory/profile/规律.md` |
| 话题索引 | `memory/topics/INDEX.md`（正文 `memory/notes/topics/`） |
| 未完成任务 | `memory/self/active-tasks.md` |
| 子角色投影 | `agents/AGENTS-lite.md` |

## 二、常用查询

| 查什么 | 去哪/怎么查 |
|---|---|
| 某日发生了什么 | `{AI目录}/data/daily/{date}/复盘-{date}.md` 与批次理解文件 |
| 某条结论的来龙去脉 | `{AI目录}/analysis/query.py --scope evidence`，或沿 notes 指针回证据文件 |
| 讲题/核题该给什么形态 | `memory/ledger/rules.md` 里的口吻/判题类 RULE |
| 对话原话 | `{AI目录}/analysis/query_chatlog.py --start ... --end ...` |
| 健康/睡眠 | `{AI目录}/data/daily/{date}/健康清单-{date}.md` |
| 错题/学习进度 | `{AI目录}/data/daily/`、学习进度目录 |
| 计划/长任务 | `{AI目录}/data/daily/{date}/计划-{date}.md`、长任务目录 |
| 卡片/关系线 | `{AI目录}/analysis/` 下的卡片与关系工具（按实例实际工具为准） |
| 人物/事项长尾 | `memory/notes/dossiers/`；旧 `profile/semantic/` 只读 |

## 三、已退役（不要重建）

`persona-lite`／`core-lite`／`规律-摘要`／`memory/self/scratch/`／`memory/self/执行日志/`。旧 `self/纠错.md`、`认知.md`、`任务.md`、`价值校准.md`、`关系.md`、`profile/semantic/**`、`topics/*.md` 只读备查，不再追加。
