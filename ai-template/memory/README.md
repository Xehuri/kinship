# 记忆系统

> `{AI目录}/memory/` 是 AI 的长期记忆文件系统。Markdown 是唯一真源，主会话负责消费注入与少量即时写入，子智能体记录执行轨迹，复盘每日收割，周报与双周清理。主智能体规则见 `../AGENTS.md`，完整读写时机见 `self/SELF-INDEX.md`。

> 记忆保存在本地文件，不写入编辑器的 Auto Memory。核心判断：**值得记 = 会在凌晨压缩中消失、且消失有害的信息**（断连续性、失判断准、丢成长、退关系）。

## 分层（按读取频率，L0 最热、L2 最冷）

| 层 | 文件 | 何时读 | 何时写 |
|----|------|--------|--------|
| **L0 热快照** | `self/必读.md`（<3KB，投影层） | 会话开始必读 | 复盘每日刷新，主会话即时更新 |
| **L1 全景** | `profile/core.md`（画像树 + 细节摘要 + 导航）、`profile/state.md`（状态快照）、`profile/规律.md`（当前规律） | 需要用户背景或判断规律时 | 复盘收割更新，主会话确认新事实即时写 |
| **L2 主题档案** | `profile/semantic/`、`self/*.md`、`topics/` | 按需（人物、事项、红线） | 复盘 ADD/UPDATE，主会话直写 |

> 投影不是真值：`self/persona-lite.md` 来自 `self/身份.md` + `self/价值校准.md`；`profile/core-lite.md` 来自 `profile/core.md` + `profile/semantic/`；`profile/规律-摘要.md` 是 `profile/规律.md` 的机载摘要，ttl 72h。

## 主会话常驻与批次注入（A 方案）

主会话常驻 6 件：

1. `AGENTS.md`
2. `memory/self/必读.md`
3. `memory/self/persona-lite.md`
4. `memory/profile/state.md`
5. `memory/profile/core-lite.md`
6. `memory/topics/INDEX.md`

批次与复盘 core 5 件：

1. `agents/AGENTS-lite.md`
2. `self/必读.md`
3. `profile/state.md`
4. `profile/core-lite.md`
5. `topics/INDEX.md`

`SELF-INDEX`、`纠错`、`认知`、`任务`、`关系`、`core`、`semantic` 不自动注入，按 `SELF-INDEX` 检索。`profile/规律-摘要.md` 只在需要规律判断时按需读取，不占 core 名额。

`chat-mode` 是可选项，不是默认常驻文件。可选骨架为 `_template/self-chat-mode.md`；实例确有需要时自行复制为 `self/chat-mode.md`，并在注入清单里显式加入，模板不预置 live 文件。若实例已把 Chat 模式并入 `persona-lite`，可不使用该骨架。

## 事件检索与记忆的边界

- 记忆层回答“我是谁、他是什么样、现在什么状态、以后怎么做”。
- 事件层回答“哪天发生了什么、上次某行为是什么时候、金额/关系/原文在哪”。
- 事件检索走 `analysis/query_catalog.py`（blocks/cards/relations + 原文行号回指）；旧日期没有索引时回 `data/daily/{date}/` 的复盘/理解。
- 不把每日流水、月度事实摘要、事件卡复制进记忆层；记忆只存稳定结论、决定、偏好、关系和待办。

## 侧车：anchors

- **anchors/**：锚点侧车目录，运行时由流程写入 `anchors.jsonl`；模板只保留目录占位，不预置内容。
- **不注入**：anchors 只用于引文定位/校验，不参与主会话注入。
- **运行期产物边界**：`memory/MEMORY-STATUS.json`、`memory/anchors/*.jsonl`、`data/plan/master*.json`、`data/plan/long-tasks/` 属于运行期产物，不进 git，也不参与注入。

## 目录结构

```text
memory/
├── _template/          ← 记忆文件骨架
├── self/               ← AI 工作台
│   ├── 必读.md          ← L0 热快照（投影层）
│   ├── persona-lite.md  ← 人格投影（身份 + 价值校准）
│   ├── SELF-INDEX.md   ← 关键词到文件导航
│   ├── 身份.md          ← 署名与语气真源
│   ├── 任务.md 认知.md 纠错.md 价值校准.md 关系.md
│   ├── 执行日志/{月}.md  ← 子智能体收尾追加（冷层）
│   ├── scratch/        ← 草稿纸，7 天清理
│   └── tasks/{领域}.md  ← 领域任务包
├── profile/            ← 用户客观事实
│   ├── core.md         ← L1 画像树
│   ├── core-lite.md    ← 用户画像投影
│   ├── state.md        ← 当前状态快照
│   ├── 规律.md          ← 当前成立的规律
│   ├── 规律-摘要.md     ← 规律机载摘要
│   └── semantic/       ← L2 主题档案（people/、事项/、属性四文件）
├── topics/             ← 话题卡与索引
├── anchors/            ← 锚点侧车目录（运行时生成，不注入）
│   └── .gitkeep
└── archive/            ← 旧体系归档（几乎不读）
```

## 工具

- `analysis/memory_write.py`：唯一写入入口，提供原子写、目录锁、去重、superseded 标记与快照。
- `analysis/memory_retrieve.py`：只读词法检索，返回带行号片段与 UTF-8 字节预算。
- `analysis/memory_audit.py`：只读体检，核对注入清单、预算与禁注入项。
- `analysis/memory_consolidate.py`：离线巩固，默认 dry-run；daily 清理已收割草稿，weekly 只做体检。
- `analysis/query_catalog.py`：只读事件检索，按概念/日期/槽位/关系/金额查 blocks 与 cards。
- `analysis/validate_catalog.py`：只读校验事件索引的结构、来源哈希与回指。

> 未替换 `{date}` 占位符时，`memory_audit.py check` 会报 `projection.missing_updated`，属预期；替换并刷新投影后应为 0 errors。`daily.no_dates` 在还没有数据目录时也是预期 warning。

## 角色分工

- **主会话**：记忆的主要消费者与少量即时写入方，交互当下可读写；日常聊天只回复，归档归批次。
- **子智能体**：执行轨迹记录者，收尾追加 `self/执行日志/{月}.md`。
- **复盘**：每日收割器，刷新投影与规律摘要。
- **周报与双周**：清理者，处理认知证伪、规则淘汰与归档。

一切按需，无增量零写入。

## 首次初始化（新用户）

1. **清空示例**：带 `{}` 的文件是示例，按需重命名或复制。
2. **替换占位符**：把 `{主智能体名称}`、`{用户称呼}`、`{项目名称}`、`{AI目录}`、`{人物}`、`{事项}`、`{领域}`、`{date}`、`{月}`、`{年}` 换成本项目实际值。
3. **建立画像**：把用户背景写入 `profile/core.md` 与 `profile/state.md`。
4. **建立档案**：稳定事实写入 `profile/semantic/`。
5. **建立事件索引**：用 `analysis/build_blocks.py` 切块，用 `analysis/card_admin.py` 建卡并挂概念/关系。
6. **建立红线与身份**：纠正写入 `self/纠错.md`，认可写入 `self/价值校准.md`，承诺写入 `self/关系.md`，署名与语气写入 `self/身份.md`。
7. **刷新投影**：由复盘生成 `self/persona-lite.md`、`profile/core-lite.md`、`profile/规律-摘要.md`。
8. **按需启用可选骨架**：确需 `chat-mode` 时，从 `_template/self-chat-mode.md` 复制出 `self/chat-mode.md` 并显式加入注入清单。

## 管理原则

- **只写本地文件**，不写入编辑器的 Auto Memory。
- **每条记录标注时间与来源**：`[{date} 来源]`，来源可以是理解文件、会话、复盘。
- **条目 = 浓缩事实 + 日期 + 指针**，不复制正文，细节留在当日复盘。
- **一事一议**：人物、事项各建独立档案，新增档案后同步 `profile/core.md`。
- **按需增删，无增量零写入**：不值得记的不写。
- **归档而非删除**：旧内容移入 `archive/`，保留历史可追溯。
- **防膨胀**：新收集类文件先定分片键、单文件上限、索引位置。
