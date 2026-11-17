---
tags: [记忆, proposals, main]
type: memory/proposals
date: 2026-11-14
---
# Proposals（主会话/批次的候选入口）

> 主会话和 01 不直接写 ledger。候选写这里，02 日复盘审阅：同键同值 NOOP，新值 supersede，冲突进 open。

文件名：`{date}-{source}-{slug}.md`，例：`{date}-main-{slug}.md`。

每条候选至少写：

```md
## CANDIDATE-{date}-{source}-01 {标题}
- type: fact | rule | open | observation
- status: draft
- owner: main
- source: {用户消息/复盘/批次}
- confidence: high | medium | low
- body: {一句话结论}
- evidence: {文件/时刻}
- immediate: true | false
```

`immediate: true` 只给用户当场确认的身份/红线；02 下一次日复盘优先处理。
