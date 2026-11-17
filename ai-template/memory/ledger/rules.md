---
memory_type: ledger
layer: ledger
owner: 02-daily-review
budget_bytes: 25600
freshness_slo_days: 30
projection: false
date: {date}
---
# Rules（耐久规则/偏好）

> 一条 rule = 一个 scope + trigger + action。新规则替换旧规则时新建 entry，旧 entry 标 superseded；默认只读 active。
> entry 写法与字段见 `../PROTOCOL.md` §2；本文件是空骨架，不预置任何 entry。首次写入用 `## RULE-<YYYY-MM-DD>-<scope>-NN <title>` 开头，写完核对 25KB 预算。
