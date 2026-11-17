---
tags: [记忆, legacy, 冻结]
type: memory/legacy
date: 2026-11-14
---
# Legacy 冻结清单（Phase A）

> 从 2026-11-14 起，下列文件只读，不再追加。新内容写 `ledger/` 或 `notes/`。
> 旧内容仍可按需读；04 可压缩/归档，但必须记「删了什么、去哪」。

## 冻结文件

- `self/纠错.md` → 新规则 `ledger/rules.md`，案例 `notes/cases/`
- `self/认知.md` → 新观察 `notes/observations.md`
- `self/任务.md` → 当前任务 `self/active-tasks.md`，历史 archive
- `self/价值校准.md` → 新规则 `ledger/rules.md`（values scope）
- `self/关系.md` → 新判断 `notes/judgments/`，事实 `ledger/facts.md`
- `profile/semantic/**` → 新长尾 `notes/dossiers/`，稳定事实 `ledger/facts.md`
- `topics/*.md`（`INDEX.md` 除外）→ 新讨论 `notes/topics/`
- `self/人格方案-{date}.md` → 副本在 `notes/persona/`，原件冻结备查
- `self/人物判断-{主题}.md` → 副本在 `notes/judgments/`，原件冻结备查

## 不冻结

- `self/tasks/*.md`：业务操作手册，不是长期记忆；按原角色使用。
- `profile/规律.md`：当前规律摘要，02/03 继续维护；后续可改为 `notes/observations` 投影。
- `topics/INDEX.md`：投影，02 维护。
- `archive/`：冷档，04 可写；按 `{年}` 分档保留历史。

## 为什么冻结

旧文件太大、职责混合，继续追加只会让 02 每次改多个文件、预算持续超。先止血，再在 Phase B 做迁移/压缩。主会话/01 遇到旧内容只读，不 append；需要更新时写新 entry + 旧文件指针。
