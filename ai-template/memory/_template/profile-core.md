---
tags: [模板, 记忆, 用户画像]
type: template
projection: true
budget_bytes: 8192
---
# profile/core.md（画像树：L1 全景 + 导航，≤8KB）

> 需要用户背景时读。树状结构：从「他是谁」向下分叉；节点=一句话概要 + 日期，叶子=长尾档案或 ledger 指针。
> **不复制正文**：细节在 `notes/dossiers/` 与 `ledger/facts.md`；动态状态在 `profile/state.md`，热快照在 `self/必读.md`。02 收割后更新对应行。

## 他是谁（根）

- 名字 / 称呼 / 时代与城市（一行一条，带 {date} 与来源）

## 学业 / 工作 / 主线

- 当前阶段与目标概要 → `notes/dossiers/{事项}.md`、`ledger/facts.md`

## 关系

- 伴侣 / 家人 / 核心人物一行概要 → `notes/dossiers/{人物}.md`

## 偏好与禁忌

- 明确偏好 / 雷区 / 消费观概要 → `notes/dossiers/`、`ledger/rules.md`

## 健康

- 长期健康关注项概要 → `notes/dossiers/`、`ledger/facts.md`

## 行为规律

- 可复用真模式概要 → `notes/observations.md`、`profile/规律.md`

## 活跃事项

- 项目 / 学习 / 开发线一行概要 → `notes/dossiers/{事项}.md`

## 常去地点与生活半径

- 概要 → `notes/dossiers/`、`ledger/facts.md`

## 写作口径

- 只写稳定结论与指针；不写日常流水；每条带日期或来源。
- 事实变化时新建 ledger entry 并标 supersede，不在这里静默覆盖历史。
