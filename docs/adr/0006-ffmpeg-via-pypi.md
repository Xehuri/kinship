# ADR 0006：ffmpeg 经 imageio-ffmpeg wheel 落地，不托管二进制

- 状态：已实施
- 日期：2026-10-29
- 相关任务：22、24

## Context

后端多处需要 ffmpeg：音频裁剪、TTS 试听、压缩归档、声纹审计。改造前 Windows 依赖 `backend/bin/ffmpeg.exe`，Linux 依赖 PATH；仓库与发行资产要单独托管一个几十 MB 的 ffmpeg 二进制，并处理平台、版本、校验和与许可证。这带来四个问题：

1. 发行包多一个平台相关大文件，Windows 与 Linux 各一份。
2. 用户机器上 ffmpeg 版本不可控，PATH 里的版本可能缺编码器。
3. 二进制入库会触发 git 大文件与公开镜像同步问题。
4. 安装步骤要求用户手工放 ffmpeg，与双击即用的目标冲突。

## Decision

1. 依赖 wheel，不托管二进制。`pyproject.toml:46-48` 与 `backend/requirements.txt:45` 声明 `imageio-ffmpeg>=0.6.0`；wheel 自带对应平台的 ffmpeg 可执行文件。

2. 惰性落地。`backend/services/ffmpeg_bootstrap.py` 的 `ensure_ffmpeg()` 先看目标路径是否已存在且可执行；缺失时才 import `imageio_ffmpeg`、取 `get_ffmpeg_exe()`、复制到临时名、POSIX 设 0755、再 `os.replace` 原子落地（`backend/services/ffmpeg_bootstrap.py:64-106`）。落地目录默认 `backend/bin/`，可用 `AXEUH_FFMPEG_BIN_DIR` 覆盖（`backend/services/ffmpeg_bootstrap.py:36-43`）。

3. 统一入口。`audio_codec.ffmpeg_path()` 首位调用 `ensure_ffmpeg()`；bootstrap 失败只记 WARN 并回退 PATH 解析，不阻断启动（`backend/services/audio_codec.py:24-40`）。

4. 失败可读。缺 wheel、wheel 指向不存在、复制或设权限失败都抛 `FFmpegMissing`，消息以 `ffmpeg_missing:` 开头（`backend/services/ffmpeg_bootstrap.py:20-23`、`backend/services/ffmpeg_bootstrap.py:57-96`）。

5. 不提交落地物。`.gitignore` 覆盖 `/backend/bin/ffmpeg*`（`.gitignore:46-47`）。

6. 实测。Linux wheel 为 `imageio_ffmpeg-0.7.0-py3-none-manylinux2014_x86_64.whl`，29.5 MB；wheel 内二进制 `ffmpeg-linux-x86_64-v7.0.2`，79,826,272 字节，版本输出为 `ffmpeg version 7.0.2-static`。Windows wheel 为 31,247,004 字节，内含 `ffmpeg-win-x86_64-v7.1.exe`，87,638,016 字节。首次复制 0.0461 秒，第二次不复制且 mtime 不变，删除后重建 0.0327 秒（`.omo/evidence/process-orchestrator-refactor/task-22.log:67-87`、同文件 `:98-115`）。

7. 平台事实。同一 wheel 版本在不同平台内置不同 ffmpeg：Linux 是 7.0.2，Windows 是 7.1（`.omo/evidence/process-orchestrator-refactor/task-22.log:84-87`）。文档与验收不能只看 `imageio-ffmpeg` 版本号推断 ffmpeg 版本。

## Consequences

正面：

- 安装只需 pip 依赖，不再要求用户手工放 ffmpeg，发行资产少一个平台相关大文件。
- 首次使用自动落地，之后命中缓存，不重复复制。
- 平台差异由 wheel 选择，代码只按当前平台取对应文件名（`backend/services/ffmpeg_bootstrap.py:45-47`）。
- 缺 wheel 时降级 PATH，已有系统 ffmpeg 的部署仍能工作。

代价与边界：

- wheel 体积约 29.5 MB（Linux）与 31.2 MB（Windows），安装包总体积增加；落地后还要占 79.8 MB 或 87.6 MB。
- 版本随 wheel 变化。`>=0.6.0` 允许后续版本更换内置 ffmpeg，锁定 7.1 需收紧到具体版本。
- Linux 与 Windows 的 ffmpeg 版本不同，分别为 7.0.2 与 7.1，跨平台回归不能假设行为完全一致。
- 首次调用发生在 import 或首次裁剪时，冷启动多约 0.05 秒；落地目录只读时需要 `AXEUH_FFMPEG_BIN_DIR`，否则只能走 PATH 降级。
- wheel 内 ffmpeg 的许可证与再分发义务要随发行物一并满足。本 ADR 只记录技术落地，不替代许可证审查。

## Alternatives

1. 继续在发行资产托管 ffmpeg 二进制。否决：平台矩阵、校验和、镜像同步与公开镜像清洗都要多维护一份大文件。
2. 要求系统 PATH 提供 ffmpeg。否决：Windows 新机通常没有，版本不可控，直接破坏解压即用的目标。
3. 从源码编译 ffmpeg。否决：编译链与依赖过重，安装时间从秒级变成分钟级，且需要各平台工具链。
4. 把二进制提交进仓库。否决：大文件入库，公开镜像同步与 git 历史都会膨胀。
