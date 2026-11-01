# 索引层目录

状态：Phase 0-2 已实现。提示词接入、多日运行和历史回填暂未包含。

## 这是什么

索引层在 AI 记忆和每日记录之上增加一层目录，用来回答“过去某天发生了什么”这类问题，而不是每次现场做关键词搜索。

整体是一套小型图书馆目录：

- 概念类型是分类法；
- 文本块是原文切片；
- 卡片是事件、观察、发现、状态、决定的目录记录；
- 卡片关系用来连接证据和结论。

不引入数据库，也不引入 embedding，存储格式为 JSONL。

## 数据模型

### 概念类型

`concept_types.jsonl` 定义四层命名空间：

```text
CONCEPT（命名空间）
  -> kind
     -> domain
        -> leaf
```

`kind` 是以下五类之一：

- `event`：某个时间点或时段发生的事；
- `observation`：一段时间内观察到的模式；
- `finding`：从事件或观察推导出的结论；
- `state`：持续一段时间的状态；
- `decision`：做出的决定或计划。

只有叶子类型可以贴到卡片上。父类型只用于汇总，不允许直接标注。

### 文本块

`blocks.jsonl` 存原文块。每个块包含：

- `block_id`
- `source_type`：`batch` 或 `review`
- `source_kind`：`daily`、`weekly` 或 `biweekly`
- `file`、`line_start`、`line_end`
- `heading`
- `text`
- `text_sha256`
- `status`

块文本从源文件原样复制。源文件仍然是唯一真源。`text_sha256` 用于发现源文本变化；行号只是显示指针，不是身份。

### 卡片

`cards.jsonl` 存目录卡片。每张卡有一个主概念，以及一个或多个证据块。

卡片类型与概念类型一致：

- `event`
- `observation`
- `finding`
- `state`
- `decision`

卡片不是原文副本，而是带简短陈述和可选槽位的规范化记录。

常见槽位：

- `date`、`time`、`end_time`
- `period_start`、`period_end`
- `who`、`from`、`to`、`place`
- `object`
- `amount`、`currency`

### 关系

- `card_concepts.jsonl`：卡片到概念。
- `card_blocks.jsonl`：卡片到证据块。
- `card_relations.jsonl`：卡片到卡片。

支持的卡片关系：

```text
derived_from
supported_by
precedes
state_of
triggered_by
same_day
supersedes
contradicts
```

`card_blocks.quote_sha` 保存建立关系时的块哈希。源块变化后，校验会报告 stale 链接。

## 工具

所有工具位于 `{AI目录}/analysis/`，只使用 Python 标准库。

### `build_blocks.py`

读取 `data/daily/{date}/理解-{date}-批次-*.md`，也可读取 `data/reports/` 下的周报和双周报。

```bash
python3 analysis/build_blocks.py --date 2026-10-31 --dry-run
python3 analysis/build_blocks.py --date 2026-10-31 --out /tmp/index-smoke
```

批次默认只把时间窗 H2（`## HH:MM~HH:MM`）切成块；可用性、缺陷、链接等元信息段默认跳过，需要时用 `--include-meta`。源文件不会被修改。

### `card_admin.py`

校验并写入卡片、概念关系、块关系和卡片关系。

```bash
python3 analysis/card_admin.py add-card \
  --index-dir data/index \
  --json /tmp/card.json
```

写入是全有或全无。概念不存在、概念不是叶子、块不存在、卡片 ID 重复、必填槽位缺失，都会让整次写入失败。

### `query_catalog.py`

只读查询。

```bash
python3 analysis/query_catalog.py \
  --concept EVENT.REPAIR.LAPTOP \
  --order desc --limit 1 --resolve
```

支持：

- 概念查询，父概念自动展开到叶子；
- 类型、日期、周期过滤；
- 槽位过滤；
- `--grep` 文本兜底；
- `--order`、`--limit`；
- `--sum FIELD` 对数值槽位求和；
- `--resolve` 读取原文片段；
- `--follow` 显示卡片关系。

### `validate_catalog.py`

校验表引用、叶子标注、卡片类型、源行范围、文本哈希、引用哈希、关系端点和重复 ID。

```bash
python3 analysis/validate_catalog.py --index-dir data/index
```

退出码：`0` 通过，`1` 校验失败，`2` 参数或环境错误。

## 写入职责

- 批次分析只写原文，不写目录；
- 每日复盘和周报/双周报创建卡片并分类；
- 主会话只读卡片、解析块，不写目录；
- 审计只读取和报告，不写卡片。

## 真源优先级

```text
原文 > 卡片陈述 > 索引摘要
```

卡片结论必须能解析到真实块，再回到源文件。没有有效块链接的卡片视为无效。

## 变更规则

- 原文变化：重建受影响块；依赖卡片标为 `stale`。
- 标签错误：只改 `card_concepts`，不改原文。
- 父概念错误：修改 `concept_types` 并升版本；卡片引用叶子，自动继承新汇总。
- 卡片失效：标为 `superseded`，不删除历史卡片。
- 不允许随手造概念：新叶子必须有定义、正例、反例、必填槽位和证据。
- 只有叶子可标注，父概念不可标注。

## 当前范围

已实现：

- 六张 JSONL 表和 schema 元数据；
- 28 个种子概念；
- 块生成器、卡片写入器、查询工具、校验器；
- 02/03/04 编目步骤和主会话查询入口；
- 模板代码与空表同步。

暂未实现：

- 多日增量运行；
- 历史回填；
- `fact/` 生成视图；
- 数据库或 embedding 检索。
