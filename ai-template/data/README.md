---
tags: [指南, 配置]
---

# 定时任务

> 任务定义见 `tasks/` 独立 YAML 文件 + 常驻脚本（如 `data_check_scheduler.py`）；保存后热加载，无需重启。

## 核心文件

| 位置 | 说明 |
|------|------|
| `tasks/` | 独立任务 YAML 文件 + Python 自定义脚本（每个任务一个 `.yaml`） |
| `tasks_state.json` | 运行时状态（调度器自动管理） |
| `task_executions.yaml` | 任务执行历史记录（调度器自动写） |
| `validate_tasks.py` | 旧版任务定义/执行记录检查工具；只认 `tasks.json`，当前目录模式不产出该文件，运行会报"文件不存在" |
| `gps_cache.json` | 顶层 GPS 逆地理编码缓存（辅助脚本用；`cache/` 内另有一份） |
| `plan/coverage.yaml` | 覆盖契约真源：默认 `merged_7` 七个检查点，`merged_6` 为可选合并档；Loom 主计划与 coverage 唤醒按它生成检查点 |
| `plan/master.json` | Loom 主计划真源（运行期生成，gitignored）；首版由 `analysis/master_plan_seed.py --root {AI目录}/data` 播种 |
| `users/{用户}/health/{日期}/cloud.json` | 健康真源：`HealthStore` 的 cloud 分片（小米云拉取写入）；读取统一走 `read_health_view` |
| `daily/` | 按日期的感知数据。每个 `daily/{date}/` 含：`perception.jsonl`（后端写的原始感知，只读）、`audio_deepdive.jsonl` / `audio_deepdive_merged.jsonl`（MOSS 影子旁路产物，watcher/merge 写、只读消费，观察期与 perception 并存的独立文件）、`health.json`（历史派生视图，仅作回落；新数据见 `users/{用户}/health/{日期}/cloud.json`）、`audio/`（该日音频分片）、`事实-全天.md`（`fact_extractor.py` 生成，分时段合并）、`理解-{date}-批次-{HH}.md`（子智能体写，每批次独立）、`当日摘要-{date}.md`（脚本生成，≤24KB）/ `批次索引-{date}.md`（脚本生成，每批一行判断+观察+文件行号，≤4KB）/ `健康清单-{date}.md`（脚本生成）、`复盘-{date}.md`（复盘报告）。**注意：用户与 AI 的对话记录已不再写入日志文件**（已取消 `日志-{date}.md`），查主会话内容用 `query_chatlog.py` |
| `reports/` | 周报（每周总结-*）和深度回顾报告 |
| `cache/` | 缓存与中间产物：`gps_cache.json`（逆地理编码）、`voiceprints.json`、`usersessions.json`、`music_playlist.json`；声纹流水线 `cohort_*` / `unknown_*` 簇与审计 jsonl、`vaudit_tmp/` / `preview_tmp/` / `chatlog_tmp/` 临时目录、`maps/`（地图缓存）、`mimo_audio/`（MiMo 音频分析产物） |
| `voice/` | 语音音频文件 |
| `uploads/` | 用户上传文件 |
| `circuitjs-examples/` | CircuitJS1 官方示例电路（供 ```circuitjs 输出参考）；`CircuitJS1-格式规范.md` 为**电路文本格式权威参考**（画前先查）。体积大，模板不分发，按需自行准备 |

## 默认固定时间任务清单

> 模板默认使用固定时间任务（12-15 + `data_check_scheduler.py`）。若采用 Loom 主计划（推荐生产模式），先按下方「Loom 主计划接管」停用 12-15 与 `data_check_scheduler.py`，避免两套调度同时触发。

| 时间 | 任务 | 说明 |
|------|------|------|
| 00:00 / 06:00 / 08:00 / 12:00 / 16:00 / 20:00 / 22:00 | 数据检查 | 由 `data_check_scheduler.py` 生成 prompt 触发（7 窗口）；00 点覆盖前一天 22:00~00:00，06 点覆盖 00:00~06:00；领域任务由 `{AI目录}/memory/self/tasks/` 声明、子智能体按触发条件自动挂载 |
| 00:40 | 今日复盘 | `12-daily-review.yaml`（复盘昨天） |
| 每月 1/15 18:30 | 双周回顾 | `13-biweekly-review.yaml` |
| 每周一 03:00 | 周报总结 | `14-weekly-summary.yaml` |
| 每天 02:00 | 夜间审计 | `15-night-audit.yaml`（默认 `enabled: false`；审昨天，跑 `audit_collector.py`，结果写复盘审计小节） |
| 每天 05:00 | 日计划（Loom Plan mode 示例） | `05-plan-wake.yaml`（默认 `enabled: false`；只读 + plan commit，不执行 care，不发用户通知） |
| 每天 07:30 | 计划复核（Loom Plan mode 示例） | `07-plan-review.yaml`（默认 `enabled: false`；只读 + plan revise，不执行 care，不发用户通知） |

> 数据检查批次内联反馈转达（01 步骤 7）；领域任务由 `{AI目录}/memory/self/tasks/` 挂载（01 步骤 8）。复盘前会自动补齐数据缺口。
>
> 复盘/审计 YAML（12-15）不写 `model` / `provider`，统一使用后端全局默认。
>
> 夜间审计依赖 `{AI目录}/analysis/audit_collector.py` 与 `{AI目录}/agents/05-audit.md`；两者随模板提供，15 默认关闭。
>
> `05-plan-wake.yaml` / `07-plan-review.yaml` 是 Loom 主计划的 Plan mode 示例，默认关闭；主计划接管后由计划锚点驱动，固定时间 YAML 仅留作示范与回滚。
>
> **Loom 主计划接管（推荐生产模式，可选）**：先用 `{Python解释器路径} {AI目录}/analysis/master_plan_seed.py --root {AI目录}/data` 播种 `plan/master.json`，再停用 12-15 与 `data_check_scheduler.py`；固定时间任务与 Loom 主计划不得同时运行。
>
> **可选 QQ 集成**：模板不随附 QQ 网关与 QQ 任务，需要时自行添加；QQ 号与 token 只写本地 gitignored 配置。

> 常驻脚本任务（Python 自定义脚本，FileWatcher 自动管理）：
> - **数据检查调度器**（`data_check_scheduler.py`）：每天 7 个窗口（00:00/06:00/08:00/12:00/16:00/20:00/22:00）触发数据检查流水线；00 点目标前一天。
> - **会话压缩器**（`session_compactor.py`）：每天 04:00 向主会话发送一次"整理信息"提醒；可以压缩会话，也可以不压缩，不自动调用压缩接口。
> - **DeepSeek余额告警器**（`deepseek_balance_monitor.py`）：默认关。每 30 分钟查一次余额，低于阈值发 App 通知；余额每累计消耗一定金额写入一条 perception 数据（`type=balance`）。阈值、密钥路径、状态路径可用环境变量覆盖；API key 存 `deepseek_key.txt`（同目录，gitignored）。
> - **前台时长监控**（`foreground_watch.py`）：默认关。每 60 秒回放当日 `perception.jsonl`，按设备×应用累计「前台且亮屏」时长，超过阈值（默认 60 分钟）且不在黑名单时提醒；阈值、黑名单、状态文件路径可配置，状态存 `.foreground_watch_state.json`。
> - **小米云健康拉取**（`xiaomi_cloud_health.py`）：默认关。按水位增量拉小米云健康数据直写 `HealthStore` 的 `cloud` 分片；凭据走 `config.yaml` 的 `health.cloud.*`；接入见 `docs/数据源-小米健康云.md`。

## 子智能体

| 智能体 | 文件 | 职责 |
|--------|------|------|
| 数据检查 | `{AI目录}/agents/01-data-check.md` | 逐段分析感知数据 -> 理解文件（步骤 7 反馈转达；步骤 8 挂载 `self/tasks/` 领域任务） |
| 复盘 | `{AI目录}/agents/02-daily-review.md` | 梳理+纠错+收割记忆 -> 复盘报告 |
| 双周回顾 | `{AI目录}/agents/03-biweekly-review.md` | 双周深度回顾 |
| 周报 | `{AI目录}/agents/04-weekly-review.md` | 每周总结 |
| 夜间审计 | `{AI目录}/agents/05-audit.md` | 夜间审计（模板已提供；`15-night-audit.yaml` 默认关闭） |
| 领域任务 | 定义在 `{AI目录}/memory/self/tasks/{领域}.md` | 由 01 步骤 8 按触发条件挂载（学习/健身等自定义领域） |

> 模板默认提供 01~04 四个子智能体；05 审计与领域任务为可选扩展，按需自行增删 `agents/` 下的 prompt。

## 辅助脚本（非任务调度）

位置均在 `{AI目录}/analysis/`。

| 脚本 | 用途 |
|------|------|
| `fact_extractor.py {date} [--hours A~B] [--update-summary]` | 提取感知数据 → 事实-全天.md（分时段合并，环境音按标签合并为单行；支持 `type=balance` 余额记录渲染为余额行；命中 `audio_deepdive.jsonl` 时为语音时间线行追加 `└ MOSS:` 交叉子行——归因/场景/叙事三字段，缺文件时输出逐字节不变）。`--hours` 输出该时段在事实文件中的行号范围，供子智能体 read 精读；`--update-summary` 更新当日摘要 v2（≤24KB，按 `##`/`#### 段N` 双层抽取）+ 批次索引（每批一行，≤4KB）+ 健康清单 |
| `check_coverage.py {date}` | 验证理解文件覆盖完整性（支持多批次文件 `理解-{date}-批次-*.md`） |
| `check_voiceprint.py {date}` | 声纹质量检查（独立工具，复盘已不调用） |
| `segment_generator.py {date} --hours A~B` | 生成 5 分钟分段格式的理解文件（示例工具） |
| `health_extractor.py <start_date> <end_date>` | 为双周深度回顾提取健康视图摘要（cloud 分片优先，历史 `health.json` 回落） |
| `sensor_coverage.py {date}` | 单日传感器数据覆盖度分析 |
| `all_coords.py <日期> [日期...]` | 汇总多日全部唯一 GPS 坐标及出现次数 |
| `geocode_tool.py <lat,lng> [..]` / `--batch <file.json>` | GPS 逆地理编码（百度地图；并发限 2 请求/秒，超出会触发 API 告警） |
| `query_chatlog.py` | 按时间段查询 AI 与用户的对话日志（后端 `/api/screen/session/chatlog`） |
| `query_session_stats.py <session_id> [--json]` | 查询会话统计：请求数 / token / 花费估算 / 工具调用类型数量 |
| `listen_audio.py` | 音频内容理解（供 agent 审计任意音频；基于 MiMo 多模态，复用项目安全链路） |
| `audio_mimo_analyzer.py {date} --time HH:MM 或 --hours A~B [--json] [--output]` | MiMo 音频理解：`--time` 精确单段(60s WAV)，`--hours` 合并时段。音频经后端专用端点暴露给分析服务拉取，分析后自动清理。输出说话人/主题/时间线 Markdown |
| `audit_collector.py {date} [--out 文件]` | 夜间审计机械采集器（05 子智能体步骤 1 调用）：分域检查项注册表，输出 PASS/FAIL/WARN/SKIP 文本；模板已提供 |

> `listen_audio.py` / `audio_mimo_analyzer.py` 依赖后端音频理解链路；`geocode_tool.py` 需配置百度地图 AK（见占位符字典）。

## 修改任务

直接编辑 `tasks/` 下对应的 `.yaml` 文件（每个任务一个文件），保存后热加载自动生效。字段与 schedule 语法见 `tasks/AGENTS.md` 与现有任务文件。

## 系统架构（怎么工作）

```
后端 Scheduler (Python)
  ├─ 扫描 tasks/*.yaml 任务定义
  ├─ 按 schedule 到时间触发
  ├─ 生成带 prompt 的 {项目名称} 消息
  └─ 发送到 AI 会话 (port {OpenCode端口} 或 Loom)
         │
         └─ 主智能体收到消息
              ├─ 运行前置脚本 (fact_extractor.py 等)
              ├─ 启动子智能体 (task() 调用)
              ├─ 验收结果 + git commit
              └─ (可选) 按 `## 转达` 决定是否通知/发TTS
```

**热加载**：在 `tasks/` 下新增或修改任一 `.yaml`（或 `.py`）后保存，调度器会**自动重新读取**，不需要重启服务。

## 如何添加新任务

在 `tasks/` 下新建 `.yaml` 文件（命名建议 `{序号}-{名称}.yaml`，现有 `12-daily-review.yaml` / `13-biweekly-review.yaml` / `14-weekly-summary.yaml` / `15-night-audit.yaml`）。最少写三个字段：

| 字段 | 说明 |
|------|------|
| `name` | 任务显示名称 |
| `schedule` | 触发计划，如 `daily: "00:40"`、`weekly: {days: mon, at: "03:00"}`、`monthly: {1: "18:30", 15: "18:30"}` |
| `prompt` | 发给主智能体的执行指令 |

可选字段：`enabled: false` 暂不启用、`model` 覆盖全局默认模型、`provider` 覆盖全局默认提供商（全局默认见后端 `config.yaml` 的 `opencode.default_model` / `opencode.default_provider`）。模板随附任务不写这两个字段，统一走全局默认。

prompt 中用 `{日期}` `{昨天日期}` 等占位符，完整字段、schedule 简写与 Python 脚本规范见 `tasks/AGENTS.md`。

## 如何暂停/恢复任务

改 `enabled: false` 即可暂停，改回 `true` 恢复。热加载立即生效。

## 添加自定义Python脚本

放在 `{AI目录}/data/tasks/` 下，文件名以 `.py` 结尾即可。FileWatcher 自动检测、AST 安全审查后启动，无需配置。

脚本运行日志输出到 `{AI目录}/data/tasks/logs/{脚本名}/{日期}.log`。
