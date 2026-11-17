---
tags: [记忆, EPI, B0, 设计]
type: memory/episodic
date: 2026-11-14
status: design
phase: B0
owner: human
---
# Episodic Memory（EPI）· B0 设计

> 状态：B0 设计稿，**未启用**。当前 02 只写 `ledger/`、`notes/`；`EPI-` entry 到 B2 才允许写入。
> 目标：让主会话能说“我记得你上个月……”，而不是“我查到你上个月……”。
> 规则唯一源仍是 `memory/PROTOCOL.md`；本文件只定义情景记忆（EPI）这一层。

## 1. 为什么单独一层

- **原始情景**：daily、批次、报告、对话记录、Stratum blocks/claims。全保留，但不等于“想得起来”。
- **EPI**：从原始情景巩固出来的“情景记忆痕迹”，带时间、人、意义、salience、证据指针。
- **语义记忆**：`ledger/` 的 fact/rule/open，是当前结论。
- **工作记忆**：`state/必读/active-tasks`，是这一轮的当前态。

EPI 不复制 raw 正文，只留“我记得的那一版” + 证据指针；raw 永远留在 Stratum/数据目录。

## 2. 最小字段

### 12 个内容字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | `EPI-YYYY-MM-DD-NN`，稳定身份 |
| `period` | 是 | `time_start` / `time_end`；单点事件可相同 |
| `title` | 是 | 一句话标题，像人回忆时的标题 |
| `people` | 是 | 涉及的人/实体，用稳定 ID（{用户称呼}/{人物}…） |
| `event` | 是 | 发生了什么，1~3 句 |
| `meaning` | 是 | 为什么值得记；对关系/决策意味着什么 |
| `salience` | 是 | `high / medium / low` |
| `salience_reason` | 是 | 高/中必须写理由；写不出=低，不写 EPI |
| `confidence` | 是 | `high / medium / low` |
| `evidence` | 是 | 至少一条：claim/report/block/chatlog/source + quote |
| `links` | 否 | 关联的 FACT/RULE/OPEN/其他 EPI |
| `recall_cues` | 是 | 3~8 个词/短语，用户可能怎么提起它 |

### 系统字段（不手写）

- `status`: `active / archived / merged`；不删除。
- `last_recalled`: 上次被真正用于回复的日期。
- `recall_count`: 被召回并使用的次数。
- `merged_into`: 合并到哪条 EPI。
- `created_at` / `updated_at`：由写入事务/脚本维护。

## 3. 示例

```md
## EPI-{date}-01 {情景标题}
- status: active
- period: {date}
- title: {一句话标题：那天发生了什么，像人回忆时的一句话}
- people: {用户称呼}
- event: {发生了什么，1~3 句}
- meaning: {为什么值得记；对关系/决策意味着什么}
- salience: high
- salience_reason: {关系情绪 + 目标卡点 + 后续入口改变}
- confidence: high
- evidence: report:RPT-{date}; block:BLK-{...}; quote:“{用户原话}”
- links: FACT-{date}-{领域}-01; OPEN-{date}-{领域}-01
- recall_cues: [{人物}, {事项}, {情绪}, {时间}, {地点}]
- last_recalled:
- recall_count: 0
```

## 4. 准入闸门

**每天最多 0~3 条；没有就 NOOP。**

满足至少一条才写：

- 承诺/约定/失约；
- 冲突/冷战/道歉/和解；
- 第一次/转折点/重大决定；
- 反复出现的模式（≥3 次）；
- 未完成、卡住、悬着的事；
- 关系里程碑/纪念日；
- 强烈情绪，且事后有行为变化。

不写：

- 日常吃饭、睡眠、步数、普通交易；
- 一天内的普通流水；
- 没有 `meaning` 的事件；
- 已有 FACT/RULE 完全覆盖、且没有情景价值的事；
- 没有 evidence 的事件。

## 5. 存储与写入（B0 设计，不启用）

- 目标路径（B2 再建）：`memory/episodes/{YYYY-MM}.md`，一条 `## EPI-...`。
- 02 日复盘每天最多写 0~3 条；03 双周合并同族；04 月度归档低 salience。
- 写入前查 `id`/`title`/`period` 是否重复；同族用 `merged_into`，不删除。
- 原始证据留在 daily/Stratum；EPI 只存摘要和指针。
- B2 由 `stratum memory episode add` 写入；B0/B1 不接生产。

## 6. wake digest 选取规则

digest 是启动时 harness 预加载的“记忆碎片”，不是查询结果。

### 必须出现（must）

- `open.blocking = true`；
- 7 天内到期/承诺/未完成；
- 7 天内的关系纪念日/关键日期；
- “去年今天/上个月今天”的 high salience EPI（如果存在）。

### 应该出现（should）

- 最近 7 天 high salience、且未被召回的 EPI；
- 14 天以上未被想起的 high salience EPI；
- 与当前目标（{事项}/健康）直接相关的 recurring pattern。

### 补位（fill）

- 按 `cue_match × salience × recency` 选 1~2 条 medium；
- 不为了凑数硬塞。

### 永不出现（never）

- raw daily/流水；
- 已在 `state/必读/core` 的同一事实；
- 低 salience 例行事件；
- 没有 evidence 的 EPI；
- `stale/superseded/refuted/archived`；
- 会让 digest 变成报告的整段叙事。

### 预算与形态

- 3~5 条 EPI + 2~3 条 active fact/rule + 1 条关系提醒；
- 总长 **≤3KB / 约 1,500 token**；
- 每条 EPI 只给 1~2 句，第一人称，不列表格/不报来源；
- 没命中就空着，沉默优于硬回忆。

示例：

```text
我记得 {date} 那天你说{事项}一天没动，晚上说“今天什么都没做成”。
后来发现卡点不是不会，是不想做{具体动作}。

上个月你第一次{里程碑}，是 {date}。

还有一件没落地：{事项} {date} 截止，入口还没验证。
```

## 7. cue recall 规则

对话中出现 cue 时，harness 在回复前自动召回；不是主会话现场调工具。

- **cue 类型**：人物、话题、时间、情绪、地点、任务名。
- **候选**：`recall_cues`/`people`/`links` 命中 + FTS/关键词。
- **重排**：salience 优先 → 时间接近 → `last_recalled` 更久远 → 与当前 state/open 相关。
- **top 3**；置信度低/无命中 → 不注入。
- **更新**：只有真正用于回复才更新 `last_recalled/recall_count`；检索本身不算“想起”。
- **表达**：高置信“我记得”；中“我印象里”；低/冲突“我记得好像是……但不确定”；不露数据库腔。

## 8. 遗忘与巩固

- “遗忘”= 召回权重下降，不是删除。
- 02 每日编码 0~3 条；03 双周合并同族、补 links；04 月度归档低 salience。
- 旧 raw 数据永远保留；EPI 可 `archived/merged`，不 `rm`。
- 高 salience：承诺、冲突、转折、反复模式、未完成、关系里程碑。
- 中 salience：有意义但非关系核心。
- 低 salience：例行事件，不写 EPI。

## 9. 与证据/语义记忆的边

- EPI `evidence` 只存 typed refs + quote，不复制 raw。
- EPI `links` 指向 FACT/RULE/OPEN/其他 EPI；语义记忆不反向依赖 EPI。
- 新证据可让 EPI 标 `archived`/`merged`，但不删除；语义结论另走 `superseded`。
- 证据优先挂 report/claim > card > block > source path；block 有 stale 风险，存 quote 兜底。

## 10. B0 非目标

- 不写 CLI、不建索引、不接生产、不生成 EPI entry、不改 02/03/04 prompt。
- 不迁移旧 daily、不把 raw 数据复制进 EPI。
- B1 只做 30 条 EPI + 30 cue 的只读原型；B2 才上 `stratum memory`。

## 11. B1 验收

- 30 条 EPI 的 12 个字段齐全；无 evidence 的为 0。
- 30 个 cue 的 digest/recall top 3 命中记录完整。
- 指标：hit@3、时间准确、salience 精度、误召回、声音、token。
- 先跑 wake digest，再跑 cue recall；显式 query 最后。
