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

## 卡片与概念准入

本节是 02/03/04 编目的唯一真源，其他 prompt 只引用、不重述。

- **真值与证据**：`blocks` 是源证据，卡片 `statement` 只是摘要。每张卡必须引用 >=1 个块，并填齐该概念的 `required_slots`。
- **事件卡**：一个完整事件段才建卡，需同时具备行动者 + 动作 + 对象/地点，且有用户可见后果。相邻块描述同一活动时合并；禁止按原始 5 分钟块逐块建卡。
  - P0：明确决定/承诺、外出出行、维修/就医/考试/申请、大额消费。
  - P1：吃饭/点单、运动、上课/训练、工作/项目里程碑、家务/跑腿。
  - P2：娱乐、常规社交闲聊、常规自学。
  - P3（不得单独建卡）：被动传感器、纯 App/手机使用、睡眠传感器分段、可用性/元信息。
- **每日上限**：每天最多 3 张新事件卡；显式 `major_event`（旅行/维修/考试/就医/申请）可放宽到 5 张。当天没有 P0~P2 事件时 cards=0 允许，但必须写一行原因。
- **状态卡**：只收带起点与证据的持续状态，不收瞬时片段。
- **决定卡**：只收明确的未来计划/承诺，尽量带行动者与 `plan_date`。
- **观察卡**：必须有 `period_start`/`period_end`，且至少跨 2 天或聚合 >=3 个事件；单个事件不建观察卡。
- **发现卡**：只收因果/趋势结论，需 >=2 张 `derived_from` 卡或 >=2 个独立块支撑；不得是单个事件的重述。
- **拒收门**（命中任一即拒）：缺行动者+动作+对象/地点；重复（同日+同概念+同对象且时间重叠在 30 分钟内，或 `statement` 归一化 Jaccard >=0.85）；所有引用块都不含所断言的行动；事件时间落在所有引用块时段之外；只有复盘/元信息/可用性块；引用块已支撑 2 张卡且本次无新种类或新解释；`confidence` 为低。拒收候选连同块 ID 与原因记入 `data/cache/index-backfill-reject-<range>.json`。
- **概念准入**：只有叶子概念可贴卡。新增叶子须同一批改动里有 >=2 个不同实例需要且现有叶子都不合适；新增 L2 须 >=2 个叶子同域，或有 >=3 张卡的规划批次；新增 L1 只在新卡种引入且校验器同步更新时。先登记后使用，ID 永不复用，废弃只改 `status`；改完运行 `validate_catalog.py`。
- **重复与总结**：重复发生的事件默认逐次建事件卡；只有跨 >=2 天或聚合 >=3 个事件且能提供趋势含义时，才建聚合观察卡；禁止新增与报告重复的纯总结卡。

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
