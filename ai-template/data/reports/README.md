# 周期报告

周报、双周深度回顾等周期性报告。

## 文件命名

- `每周总结-{start}~{end}.md` — 周报（每周一 03:00 由 `14-weekly-summary.yaml` 生成，覆盖上周一~上周日）
- `深度回顾-{start}~{end}.md` — 双周深度回顾（每月 1 日/15 日 18:30 由 `13-biweekly-review.yaml` 生成）

## 其他产物

- 每日复盘写入 `daily/{date}/复盘-{date}.md`。
- 夜间审计（`15-night-audit.yaml`，默认关闭）写入 `daily/{date}/audit-{date}.txt` 与复盘文件中的审计小节，不落在本目录。
