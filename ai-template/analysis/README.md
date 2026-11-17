# 分析脚本目录

> 位置：`{AI目录}/analysis/`。Markdown 与 JSONL 是唯一数据接口，脚本只读源数据、把产物写回 `{AI目录}/data/`。除 `health_source.py`、`memory_index_lib.py` 等库模块外，其余脚本都带 CLI；带日期的脚本统一用 `YYYY-MM-DD`。

## 数据管道

| 脚本 | 功能 |
|------|------|
| `fact_extractor.py {date} [--hours A~B] [--update-summary]` | 原始 `perception.jsonl` → `事实-全天.md`；命中 `audio_deepdive.jsonl` 时追加 `└ MOSS:` 交叉子行；`--hours` 输出时段行号（结束点开区间，跨日窗口不吃次日 00:00）；增量合并按时段区间去重；`--update-summary` 更新当日摘要、批次索引与健康清单（保留健康清单里的手写「修正／主会话追加」段） |
| `health_source.py` | 共享模块，无 CLI。读取后端 HealthStore 分片并合成健康视图，分片不可用时回退派生 `health.json`；backend 目录按 `AXEUH_BACKEND_DIR` 环境变量或 AI 根位置的候选路径解析（见「依赖」） |
| `check_coverage.py {date}` | 校验理解文件覆盖原始数据全时段，含跨午夜溢出、未来 600 秒宽限与声纹流水线检查 |
| `check_voiceprint.py {date}` | 声纹质量检查：说话人分布、低置信占比、名称截断 |
| `segment_generator.py {date} --hours A~B` | 生成 5 分钟分段格式的理解文件，示例工具 |

## 健康与位置

| 脚本 | 功能 |
|------|------|
| `health_extractor.py <start> <end>` | 为复盘提取健康数据摘要，优先走 `health_source` |
| `sensor_coverage.py {date}` | 单日传感器覆盖度分析 |
| `all_coords.py <date> [date...]` | 汇总多日唯一 GPS 坐标及出现次数 |
| `geocode_tool.py <lat,lng> [..]` 或 `--batch <file.json>` | GPS 逆地理编码，需要百度地图 AK |
| `mi_fitness_fetch.py <start> <end> [--keys ...] [--qr]` | 云端健康取数，凭据读项目根 `config.yaml` 的 `health.cloud.*` |

## 查询、审计与轨迹

| 脚本 | 功能 |
|------|------|
| `query_chatlog.py` | 按时间窗查询会话记录；带 `--list-sessions`，会话缓存写 `{AI目录}/memory/self/chatlog-cache.json`，原始输出归档到 `data/cache/chatlog_tmp/` |
| `query_session_stats.py <session_id> [--json]` | 会话请求数、token、花费估算与工具调用统计；价格表可用 `--price-file` 覆盖 |
| `session_context.py --list` 或 `--session-id` | 只读 OpenCode 数据库，列子会话、导出处理时间线、抽取已发通知 |
| `audit_collector.py {date} [--out 文件]` | 夜间审计机械采集器，按域输出 PASS/FAIL/WARN/SKIP，退出码 0/1/2 |
| `watch_opencode_session.py <session_id>` | 轮询 OpenCode 会话直到安静，适合长任务收尾 |
| `twin_slice.py <date> [--window A~B]` | 从 `事实-全天.md` 切窗口，供本地孪生轨对照 |

## 音频

| 脚本 | 功能 |
|------|------|
| `listen_audio.py <file> [..]` | 单文件或批量音频理解，复用后端 MiMo 安全链路 |
| `audio_mimo_analyzer.py {date} --time HH:MM` 或 `--hours A~B` / `--ranges` | 按时间窗选段并调用 MiMo，输出说话人、主题与时间线 |
| `mimo_audio_sweep.py [--dry-run]` | 清理 `data/cache/mimo_audio/`：保留 Markdown 结果，保护在途任务，按天数与总量双约束 |

## 索引工具（已弃用）

> 以下脚本只保留给旧索引一次性迁移前检查和导入；02/03/04 默认流程不再调用，也不再写 `data/index/*.jsonl`。旧的关系生成器 `build_relations.py` 已归档到 `analysis/legacy-index-archive/`；活动流程改用 `stratum add relation`。
>
> `data/index/` 若带 `DEPRECATED` 标记文件，`query.py` / `query_catalog.py` / `query_reports.py` 会拒绝读取并提示改用 `stratum query`（`query.py` 的 memory、chat scope 不读索引，仍然可用）。搬一份私有副本并显式传 `--index-dir` 才能读冻结导出。

| 脚本 | 功能 |
|------|------|
| `build_blocks.py [--date YYYY-MM-DD] [--source batch|legacy|review|all]` | 从批次/早期单体理解/周期报告切出 blocks；默认只收时间窗标题 |
| `build_reports.py` | 扫描日报、周报、双周报、全程总结，生成 `reports.jsonl`；日报按观测层（`layer=observation`）记录，报告块可挂卡片作说明/佐证 |
| `build_report_relations.py` | 生成报告→卡片、周报→日报、双周→周报、全程→报告的 `report_relations.jsonl` |
| `card_admin.py add-card --text <txt\|->` / `add-relation` / `deprecate-card` | 写入卡片与卡片关系；`add-card` 使用纯文本草稿，`--json` 仅保留旧兼容 |
| `query.py [--scope ...] [--from/--to] [--grep ...]` | 规范化多角度检索入口：event/observation/report/evidence/memory/chat/all 单层或复合查询，自动分组、排序、去重；证据层默认随卡片折叠，`--include-linked-evidence` 才展开；索引层只读冻结导出，带 `DEPRECATED` 标记的目录直接拒绝，记忆/对话检索不受影响。`query_catalog.py` / `query_reports.py` 保留为专用回退 |
| `query_catalog.py` | 按概念/日期/时段/文本/金额查询卡片，可回指块 |
| `query_reports.py [--type ...] [--layer ...] [--follow]` | 查询报告索引与报告关系 |
| `validate_catalog.py` | 校验八张表、源文件、哈希、报告层和关系引用 |

## 统一检索输出

`query.py` 的排序与整理规则：

- 分组：多 scope 默认 `--group-by layer`，层序固定 event → observation → report → evidence → memory → chat；`--group-by date` 按日期倒序分组；`--group-by none` 扁平输出。
- 排序：默认有 `--grep` 用 relevance（标题命中 > 摘要命中 > 元数据命中，再按层优先级/日期/ID），否则按时间倒序；`--order chrono` 可强制时间序，`--asc` 反向。
- 去重：卡片按 card_id，报告按 report_id，块按 block_id 与 file:line:sha，记忆按 path:line:sha，对话按 session:message；跨层文本哈希重复保留高层并记 related_ids。
- 限制：先 `--limit-per-scope`，再按层轮转取 `--limit`，最后按 `--budget` 字节截断；JSON 返回 groups/items/counts，table 按组打印。
- `--scope all` 默认不返回 evidence；证据被卡片引用时折叠，`--include-linked-evidence` 才展开。

## 记忆工具（Phase A）

> 记忆规则唯一真源是 `{AI目录}/memory/PROTOCOL.md`。Phase A 只做提示词与结构治理：不建 CLI、不建索引、不接 Stratum memory；单向流是 证据 → 02 日复盘 → `ledger/`、`notes/` → 投影，02 日复盘是唯一日更写入者，主会话只写 `notes/proposals` 等提案。

| 脚本 | 功能 |
|------|------|
| `memory_finalize.py [files...] [--root .] [--changed-from git] [--projection-status 路径] [--json]` | **Phase A 主入口**（记忆收尾门）：断链、文件名日期、PII、投影新鲜度等硬检查加软警告；另跑语义层硬检查——`self/必读.md` 的「硬事实」节必须存在且不少于 3 条、同实体同属性不得有多条 active 且值不同（该走 supersede）、fact 缺 `source`/`evidence` 与 rule 缺 `evidence` 都报错/警告。只写 `memory/MEMORY-STATUS.json`，不调用 LLM |
| `query.py --scope memory [--grep ...] [--from/--to ...]` | **记忆检索统一入口**：按 `path:line:sha` 去重、带行号片段输出，替代“全文 grep 记忆目录”的习惯；与事件/报告检索同一个排序与预算口径 |
| `memory_retrieve.py --query <词> [--budget 6000]` | 只读词法检索辅助：返回带行号片段与 UTF-8 字节预算；命中后必须回读验证。需要结构化结果时优先 `query.py --scope memory` |
| `memory_audit.py <scan\|report\|check>` | 旧检查器，保留可用但不是主链：注入清单、预算、禁注入项、投影新鲜度、state.md 新鲜度/体积与标签 |
| `memory_consolidate.py [--apply]` | 旧检查器，保留可用但不是主链：离线巩固，默认 dry-run；daily 清理已收割草稿，weekly 只做体检 |
| `memory_write.py` | **已退役**：Phase A 起记忆写入由 02 日复盘写 `ledger/`、`notes/` 与投影完成，不再调用本脚本；文件保留只为读旧快照或回滚，不要当写入入口 |
| `memory_index.py [--dry-run] [--out 目录] [--dates 日期1,日期2]` / `memory_index_lib.py` / `memory_index_query.py --index 目录 [--queries YAML]` | 旧记忆索引实验（侧车）：Phase A 不建索引、不参与注入与检索主链，默认不跑；只有复现旧评测时才用，产物为 `entities.jsonl` / `links.jsonl` / `manifest.json` / `status.json` 与 `query-report.*` |
| `memory_index_queries.yaml` | 旧索引实验的查询样例；模板只带通用示例，`expected_paths` 需按实例改写后再跑 |

> 记忆正文的写入与投影刷新由 02 日复盘的提示词执行，不靠脚本；脚本只做只读检查与检索。旧 `self/*.md`、`profile/semantic/**` 等文件在 Phase A 冻结只读，新内容写 `ledger/` 或 `notes/`。

## 计划、唤醒与锚点

| 脚本 | 功能 |
|------|------|
| `master_plan_seed.py --root {AI目录}/data [--dry-run]` | 从 `data/plan/coverage.yaml`、任务 YAML 与 long-tasks 播种首版 `master.json` 与 `master.md`；已存在 master 时需 `--force --expected-version N` 才能重写 |
| `plan_wake.py --kind plan\|review [--dry-run]` | 构建并投递 05:00 日计划 / 07:30 晨间复核的 Loom 内部消息，静默，不发用户手机通知 |
| `plan_anchor.py --anchor "05:00"\|"07:30" [--dry-run]` | 先 POST `/plan/reconcile`，仅在失败时回退旧唤醒消息 |
| `message_anchor.py derive` 或 `verify --root .` | 从聊天记录派生 `memory/anchors/anchors.jsonl`，或校验锚点与源消息 |
| `weather_brief.py [--date YYYY-MM-DD] [--out-dir 目录]` | 07:00 天气简报，open-meteo 免 key；地点与坐标走环境变量 |
| `anchor_targets*.yaml` | 实例运行期数据，模板不随附；`message_anchor.py` 按实例填写后再用 |

## 依赖

- 标准库为主；`fact_extractor.py` / `geocode_tool.py` / `listen_audio.py` / `audio_mimo_analyzer.py` 使用 `requests`。
- 音频脚本与 `health_source.py` 会加载项目 `backend/` 模块：优先用环境变量 `AXEUH_BACKEND_DIR` 指定，否则按 AI 根位置尝试 `<AI根>/../backend`、`<AI根>/../../backend`；AI 根放在独立数据目录时建议显式设置。
- 健康视图依赖后端配置：跑 `fact_extractor.py` 前把 `CONFIG_PATH` 指向项目根 `config.yaml`，否则 DATA_DIR／HEALTH_PRIMARY_USER 读不到，脚本会逐项报原因并以非零码退出（不会静默产出没有心率的“事实”文件）。
- 第三方密钥不写进脚本：百度地图 AK 用占位符或配置，MiMo 与 DashScope 从项目根 `config.yaml` 读取。

## 编写规范

- Python 3.10+，CLI 用 `argparse`，日期作第一个位置参数。
- 路径必须从 `__file__` 推导，不写死 `ai/` 或当前工作目录；临时产物写 `data/cache/`。
- 退出码有意义：0 成功，1 业务失败，2 参数或环境错误。
- 支持 `--json` 的脚本保持 stdout 可解析，日志走 stderr。
- 不修改 `perception.jsonl`、音频原文件与后端数据库。

## 最小结构

```python
#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""脚本说明

用法:
    python analysis/脚本名.py <日期> [参数]
"""

import argparse
import os

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.normpath(os.path.join(_SCRIPT_DIR, '..', 'data'))


def main() -> int:
    parser = argparse.ArgumentParser(description='脚本说明')
    parser.add_argument('date', help='日期 YYYY-MM-DD')
    args = parser.parse_args()
    # 读取 -> 处理 -> 写回 data/
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
```
