---
memory_type: ledger
layer: ledger
owner: 02-daily-review
budget_bytes: 10240
freshness_slo_days: 14
projection: false
date: {date}
---
# Open（未决问题）

> 只放还没解决的问题/待拍板项。blocking=true 的才进 `必读`；解决后标 archived 或升格为 fact/rule。
> entry 写法与字段见 `../PROTOCOL.md` §2；本文件是空骨架，不预置任何 entry。首次写入用 `## OPEN-<YYYY-MM-DD>-<scope>-NN <title>` 开头，写明 `question` 与 `blocking`，写完核对 10KB 预算。
