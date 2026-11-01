# 分析脚本目录

> 位置：`{AI目录}/analysis/`。Markdown 与 JSONL 是唯一数据接口，脚本只读源数据、把产物写回 `{AI目录}/data/`。除 `health_source.py`、`memory_index_lib.py` 等库模块外，其余脚本都带 CLI；带日期的脚本统一用 `YYYY-MM-DD`。

## 数据管道

| 脚本 | 功能 |
|------|------|
| `fact_extractor.py {date} [--hours A~B] [--update-summary]` | 原始 `perception.jsonl` → `事实-全天.md`；命中 `audio_deepdive.jsonl` 时追加 `└ MOSS:` 交叉子行；`--hours` 输出时段行号；`--update-summary` 更新当日摘要、批次索引与健康清单 |
| `health_source.py` | 共享模块，无 CLI。读取后端 HealthStore 分片并合成健康视图，分片不可用时回退派生 `health.json` |
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
| `query_chatlog.py` | 按时间窗查询会话记录；带 `--list-sessions`，会话缓存写 `{AI目录}/memory/self/chatlog_sessions.json`，原始输出归档到 `data/cache/chatlog_tmp/` |
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

## 记忆工具

> 核心流水线只依赖 `memory_write` / `memory_retrieve` / `memory_audit` / `memory_consolidate` / `memory_finalize`；`memory_index*` 是可选实验侧车，默认不参与注入，不应视为当前生产主链。

| 脚本 | 功能 |
|------|------|
| `memory_write.py` | 记忆唯一写入入口：原子写、目录锁、去重、superseded 标记与快照 |
| `memory_retrieve.py --query <词> [--budget 6000]` | 只读词法检索，返回带行号片段；辅助定位，命中后必须回读验证 |
| `memory_audit.py <scan\|report\|check>` | 只读体检：注入清单、预算、禁注入项、投影新鲜度与标签 |
| `memory_consolidate.py [--apply]` | 离线巩固，默认 dry-run；daily 清理已收割草稿，weekly 只做体检 |
| `memory_index.py [--dry-run] [--out 目录] [--dates 日期1,日期2]` | 构建只读记忆索引，产物为 `entities.jsonl` / `links.jsonl` / `manifest.json` / `status.json` |
| `memory_index_lib.py` | 记忆索引构建库，无 CLI |
| `memory_index_query.py --index 目录 [--queries YAML] [--out 目录] [--top-k N]` | 在冻结查询集上评估索引排序，输出 `query-report.json` 与 `query-report.md` |
| `memory_index_queries.yaml` | 冻结查询样例；模板只带通用示例查询，`expected_paths` 需按实例改写 |
| `memory_finalize.py [files...] [--root .] [--changed-from git] [--projection-status 路径] [--json]` | 记忆收尾门：断链、日期、PII、投影新鲜度等硬检查加软警告，只写 `memory/MEMORY-STATUS.json` |

> `memory_index_queries.yaml` 随模板提供的只是通用样例查询；正式评估前把 `expected_paths` 换成实例内真实存在的文件。

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
- 音频脚本与 `health_source.py` 会按脚本相对路径加载项目 `backend/` 模块，因此 AI 目录应与 `backend/` 同级。
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
