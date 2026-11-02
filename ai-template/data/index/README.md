# 索引层目录（data/index）

本目录是可查询的派生卡片层。源文本永远是真值；这里只保存指针、哈希和卡片，不复制业务正文。

## 八张表

| 文件 | 一行是什么 | 关键字段 |
|---|---|---|
| `concept_types.jsonl` | 概念注册表 | `concept_id`, `name`, `kind`, `parent_id`, `level`, `definition`, `includes`, `excludes`, `required_slots`, `aliases`, `status`, `version`, `owner` |
| `blocks.jsonl` | 源文本的时段段；批次默认只收 `## HH:MM~HH:MM`，`--include-meta` 才收可用性/缺陷段；无批次文件的早期日期走单体 `理解-{date}.md` | `block_id`, `source_type`, `source_kind`, `file`, `date`, `heading`, `line_start`, `line_end`, `text`, `text_sha256`, `status` |
| `cards.jsonl` | 一条事件/观察/发现/状态/决定 | `card_id`, `kind`, `title`, `statement`, `date`+`time` 或 `period_start`+`period_end`, `slots`, `confidence`, `status`, `version` |
| `card_concepts.jsonl` | 卡片与概念的主关系 | `card_id`, `concept_id`, `role` |
| `card_blocks.jsonl` | 卡片与证据块的关系 | `card_id`, `block_id`, `role`, `quote_sha` |
| `card_relations.jsonl` | 卡片之间的关系 | `from_card`, `to_card`, `relation`, `note` |
| `reports.jsonl` | 一份日报 / 周报 / 双周报 / 全程总结 | `report_id`, `report_type`, `layer`, `period_start`, `period_end`, `title`, `file`, `line_count`, `text_sha256`, `block_ids`, `card_ids`, `status`, `version` |
| `report_relations.jsonl` | 报告到卡片、报告到报告的关系 | `from_report`, `to_card` 或 `to_report`, `relation`, `note` |

## 契约

- `block.file` 相对 AI 根目录，例如 `data/daily/2026-10-31/理解-2026-10-31-批次-16.md`。
- `block.block_id` 前缀：`B-` 批次块，`L-` 早期单体理解块，`R-` 周报/双周报块；`source_type` 对应 `batch` / `legacy` / `review`。
- `blocks.text` 必须与源文件 `line_start..line_end`（从 1 开始，含两端）逐字一致；`text_sha256` 是该段文本的 SHA-256。
- `card_blocks.quote_sha` 必须等于对应 `blocks.text_sha256`。
- 只有叶子概念可以被卡片引用。父概念只用于查询时递归展开。
- 一张卡片只有一个主概念；需要多概念解释时用关系表，不新增第二个主概念。
- 关系的允许值：`derived_from`, `supported_by`, `precedes`, `state_of`, `triggered_by`, `same_day`, `supersedes`, `contradicts`。
- `reports.layer`：日报=`event`；周报、双周报、全程总结=`observation`。
- `report_relations.relation`：`reports_event`（日报到当天卡）、`observes`（周报/双周到周期内卡）、`covers`（报告的覆盖层级）。
- `reports.card_ids` 是报告到卡片的直接引用；`reports.block_ids` 是该报告源文件的块（日报当前为空，周报/双周为 review 块）。

## 源优先级

1. `data/daily/<date>/理解-*.md` 批次正文是事件级第一证据；无批次文件的早期日期用单体 `理解-<date>.md`。
2. `data/daily/<date>/复盘-<date>.md` 是日报（事件层报告）。
3. `data/reports/每周总结-*.md` 与 `深度回顾-*.md` 是观察层报告；`reports.jsonl` 记录报告与卡片/块的引用。
4. 卡片 `statement` 是摘要，不是真值；追证据一律走 `card_blocks` 到 `blocks` 再到源文件。

## 写入归属

- `analysis/build_blocks.py` 只写 `blocks.jsonl`，不写卡片。
- `analysis/build_reports.py` 写 `reports.jsonl`。
- `analysis/build_report_relations.py` 写 `report_relations.jsonl`。
- `analysis/build_relations.py` 写 `card_relations.jsonl`，保留人工关系并重建自动关系。
- `analysis/card_admin.py` 只写 `cards.jsonl`, `card_concepts.jsonl`, `card_blocks.jsonl`, `card_relations.jsonl`。
- `analysis/query_catalog.py` 与 `analysis/validate_catalog.py` 只读。
- `analysis/query_reports.py` 只读查询报告索引。
- `concept_types.jsonl` 只在评审后人工增改；新概念先登记再使用。
- 写入使用临时文件加原子替换，并在 `.catalog.lock` 上持有排他锁。

## 状态与废弃

- `active` 正常；`deprecated` 不再新增引用；`superseded` 已被新卡替代。
- 不删除行，不复用 `card_id` / `block_id` / `concept_id`。废弃只改 `status`，旧指针保留。
- 源文本改写后，重建块并重新校验；校验失败的红灯优先于补数据。

## 边界

- 纯 JSONL，只用 Python 标准库。
- 不引入数据库、不引入向量库、不做 embedding。
- 不做 61 天回填；本目录先建表，再按日增量。
