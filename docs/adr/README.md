# 架构决策记录（ADR）

> 本目录保存现行架构决策。每份 ADR 一个文件，状态与日期以文内为准。新增决策时按四位序号递增命名。
> 返回文档总入口：[docs/README.md](../README.md)。

| ADR | 决策 | 状态 | 日期 |
| --- | --- | --- | --- |
| [0001](0001-single-parent-process.md) | 后端是唯一父进程，父死子清 | 已实施 | 2026-10-29 |
| [0002](0002-config-draft-apply.md) | 配置两阶段，apply 是唯一执行入口 | 已实施 | 2026-10-29 |
| [0003](0003-remove-bootstrap-mode.md) | 删除 bootstrap 模式，用 blocked 服务取代延迟服务面 | 已实施 | 2026-10-29 |
| [0004](0004-single-port.md) | 单一 `server.port`，`ssl.enabled` 只决定协议 | 已实施 | 2026-10-29 |
| [0006](0006-ffmpeg-via-pypi.md) | ffmpeg 经 imageio-ffmpeg wheel 落地，不托管二进制 | 已实施 | 2026-10-29 |
