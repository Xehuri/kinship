---
memory_type: ledger
layer: ledger
owner: 02-daily-review
budget_bytes: 25600
freshness_slo_days: 30
projection: false
date: {date}
---
# Facts（稳定事实）

> 一条 fact = 一个 entity + attribute + scope。`value` 变化时新建 entry，旧 entry 标 superseded；不要覆盖。
> entry 写法与字段见 `../PROTOCOL.md` §2；本文件是空骨架，不预置任何 entry。首次写入用 `## FACT-<domain>-NNN <title>` 开头，写完核对 25KB 预算。
