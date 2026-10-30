# 每日数据

按日期存放的感知数据、理解文件与脚本产物。

## 目录结构

```text
daily/{date}/
├── perception.jsonl              ← 原始感知数据（由后端写入，只读）
├── audio_deepdive.jsonl          ← MOSS 影子旁路产物（观察期，按 chunk 深读）
├── audio_deepdive_merged.jsonl   ← MOSS 合并视图（merge.py 生成）
├── health.json                   ← 健康数据（由后端写入，只读）
├── audio/                        ← 该日音频分片
├── 事实-全天.md                   ← 脚本生成（fact_extractor.py，分时段合并）
├── 理解-{date}-批次-{HH}.md        ← 子智能体写（每批次独立）
├── 当日摘要-{date}.md             ← 脚本生成（fact_extractor.py --update-summary，≤24KB）
├── 批次索引-{date}.md             ← 脚本生成（每批一行判断+观察+文件行号，≤4KB）
├── 健康清单-{date}.md             ← 脚本生成
├── 复盘-{date}.md                ← 复盘报告
└── audit-{date}.txt              ← 夜间审计采集结果（15-night-audit 启用时）
```

## 说明

- `audio_deepdive*.jsonl` 是 MOSS 深度音频理解影子管线的旁路产物；`perception.jsonl` 与主链不受影响。`fact_extractor.py` 命中该文件时会在语音时间线行追加 `└ MOSS:` 交叉子行，缺文件时输出逐字节不变。
- `事实-全天.md` 按 `{date}` 分日写入并分时段合并；`--hours A~B` 会输出该时段在文件中的行号范围，供子智能体精读。
- `理解-{date}-批次-{HH}.md` 每批次一个文件；`批次索引-{date}.md` 汇总每批一行（判断 + 观察 + 文件行号），供复盘快速定位。
- 数据检查每天 7 个窗口写入批次文件（00/06/08/12/16/20/22 点）；00 点批次覆盖前一天 22:00~00:00，06 点批次覆盖 00:00~06:00。
- 复盘在每天 00:40 读取昨天的目录；夜间审计（默认关闭）在 02:00 读取昨天，产物为 `audit-{date}.txt` 与复盘文件中的审计小节。
- 用户与 AI 的对话记录不写入日志文件（已取消 `日志-{date}.md`），查主会话内容用 `query_chatlog.py`。
