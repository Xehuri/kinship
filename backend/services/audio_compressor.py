"""
音频压缩归档服务

每天凌晨自动执行（V13 起为调度器内建任务 builtin_audio_compressor_daily）：
1. 找出所有超过 keep_days 天且仍有未归档原件的音频目录——**两个桶**:
   daily/{date}/audio（上传支）与 stream/{date}/audio（流式支，V18 起纳入，
   终结 stream/ 单向堆积；两支同一段扫描/合并/校验实现，无复制逻辑）
2. 将一天的所有 WAV/FLAC 文件合并为单个 AAC/M4A 文件
3. 生成 JSON 索引（含每个片段的时间戳/时长/位置）
4. 验证压缩文件完整性后，删除原始 WAV 文件

压缩后目录结构（以 daily 支为例，stream 支同构）:
ai/data/daily/{YYYY-MM-DD}/
├── audio_archive.m4a             # 合并压缩后的音频 (AAC, 48kbps)
├── audio_archive_index.json      # 片段索引
├── perception.jsonl              # 不变（指针改写为纯函数 rewrite_archived_pointers，
│                                 #   V18 交付但未接线——启用决策留用户）
└── profile.json                  # 不变

依赖:
- ffmpeg (backend/bin/ffmpeg.exe 或系统 PATH)
- 无需额外 Python 依赖（WAV 头部解析自行实现）
"""

import os
import sys
import json
import asyncio
import logging
import shutil
import struct
import subprocess
import time
from datetime import datetime, timezone, timedelta, date
from typing import List, Optional

from services.audio_codec import ffmpeg_path

logger = logging.getLogger(__name__)

_CST = timezone(timedelta(hours=8))

# WAV fmt 子块结构: audio_format(2) + channels(2) + sample_rate(4) +
#                    byte_rate(4) + block_align(2) + bits_per_sample(2) = 16
WAV_FMT_LAYOUT = '<H H I I H H'

# 压缩输出格式
ARCHIVE_FORMAT = "aac"
ARCHIVE_CODEC = "aac"
ARCHIVE_BITRATE = "48k"
ARCHIVE_CONTAINER = "m4a"
ARCHIVE_FILENAME = f"audio_archive.{ARCHIVE_CONTAINER}"


def _build_ffmpeg_archive_cmd(
    ffmpeg: str, concat_file: str, archive_path: str, *,
    threads: int, nice: int,
) -> List[str]:
    """构建归档 ffmpeg argv（纯函数，不执行）。

    ``threads=0`` 且 ``nice=0`` 时与改造前 argv 逐项相同；``threads>0`` 在输出
    路径前追加 ``-threads N`` 限制编码线程；POSIX 且 ``nice!=0`` 时以
    ``nice -n N`` 前缀降低子进程优先级（Windows 无 nice 命令，跳过）。
    """
    cmd = [
        ffmpeg, '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concat_file,
        '-c:a', ARCHIVE_CODEC,
        '-b:a', ARCHIVE_BITRATE,
        '-ac', '1',
        '-ar', '16000',
        '-movflags', '+faststart',  # M4A 优化：头部前置
        archive_path,
    ]
    if threads > 0:
        cmd[-1:-1] = ['-threads', str(threads)]
    if nice != 0 and sys.platform != 'win32':
        cmd = ['nice', '-n', str(nice)] + cmd
    return cmd


def _parse_wav_duration(path: str) -> float:
    """
    快速解析 WAV 文件时长（不依赖外部库）。

    从 WAV 头部提取采样率和 data 块大小计算时长:
        duration = data_chunk_size / (sample_rate * channels * bits_per_sample / 8)

    适用于 AudioRecord 生成的 16kHz/16bit/mono PCM WAV。
    """
    try:
        with open(path, 'rb') as f:
            riff = f.read(12)
            if len(riff) < 12 or riff[:4] != b'RIFF' or riff[8:12] != b'WAVE':
                return 0.0

            sample_rate = 16000
            channels = 1
            bits_per_sample = 16

            while True:
                chunk_id = f.read(4)
                if len(chunk_id) < 4:
                    break
                chunk_size_bytes = f.read(4)
                if len(chunk_size_bytes) < 4:
                    break
                chunk_size = struct.unpack('<I', chunk_size_bytes)[0]

                if chunk_id == b'fmt ':
                    raw = f.read(min(chunk_size, 16))
                    if len(raw) >= 16:
                        (audio_format, channels, sample_rate,
                         _byte_rate, _block_align, bits_per_sample) = \
                            struct.unpack(WAV_FMT_LAYOUT, raw[:16])
                        if audio_format != 1:
                            return 0.0
                    else:
                        f.seek(chunk_size, 1)

                elif chunk_id == b'data':
                    data_size = chunk_size
                    if sample_rate > 0 and channels > 0 and bits_per_sample > 0:
                        bytes_per_sec = sample_rate * channels * (bits_per_sample // 8)
                        if bytes_per_sec > 0:
                            return data_size / bytes_per_sec
                    break

                else:
                    f.seek(chunk_size, 1)

        return 0.0
    except Exception as e:
        logger.warning(f"解析 WAV 时长失败 {path}: {e}")
        return 0.0


def _parse_duration(path: str) -> float:
    """通用音频时长（秒）: WAV 走 RIFF 快解析, 其余（FLAC 等）soundfile 兜底。

    - ``.wav``: 先用 `_parse_wav_duration` 解析头部（零依赖、最快）;
    - 解析失败或非 WAV: soundfile ``info`` 读帧数/采样率（生产依赖已在，
      支持 FLAC/OGG/WAV）; 再失败回退 ffprobe（可能不存在, 返回 0）。
    """
    if path.lower().endswith('.wav'):
        d = _parse_wav_duration(path)
        if d > 0:
            return d
    try:
        import soundfile as sf
        info = sf.info(path)
        if info.frames > 0 and info.samplerate > 0:
            return float(info.frames) / float(info.samplerate)
    except Exception as e:
        logger.debug(f"soundfile 解析时长失败 {path}: {e}")
    return _get_archive_duration(path)


def _get_archive_duration(path: str) -> float:
    """
    获取 M4A 文件时长（用于压缩完整性验证）。

    优先用 ffprobe（快速，但可能未安装）。
    如果 ffprobe 不存在，跳过验证（ffmpeg 返回码 0 即表示编码完整）。
    """
    ffmpeg = ffmpeg_path()
    # Linux 迁移(2026-10-07)：非 win32 用 PATH 上的 ffprobe；win32 保留同目录 ffprobe.exe
    if sys.platform != "win32":
        import shutil
        ffprobe = shutil.which("ffprobe") or "ffprobe"
    else:
        ffprobe = os.path.join(os.path.dirname(ffmpeg), 'ffprobe.exe')

    if not os.path.exists(ffprobe):
        logger.debug(f"ffprobe 未找到，跳过压缩文件时长验证")
        return 0.0

    try:
        result = subprocess.run(
            [ffprobe, '-v', 'error',
             '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1',
             path],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0 and result.stdout.strip():
            return float(result.stdout.strip())
    except Exception as e:
        logger.warning(f"获取音频时长失败 {path}: {e}")
    return 0.0


class AudioCompressor:
    """
    音频压缩归档引擎

    定时语义 V13 起归 TaskScheduler 内建回调任务（builtin_audio_compressor_daily,
    daily 00:05）：本类不再自带后台循环/start/stop，由 main.py lifespan 注册，
    回调即 compress_all()。保留最近 keep_days 天的原始 WAV，其余压缩为 AAC/M4A，
    压缩后先验证完整性再删除原始文件。V18 起扫描桶扩为 daily+stream 两支
    （stream/{date}/audio 单向堆积终结），两支共用同一段扫描/合并/校验实现。
    """

    def __init__(self, data_dir: str, keep_days: int = 2,
                 keep_wavs: bool = False, ffmpeg_threads: int = 0,
                 nice: int = 0):
        """
        Args:
            data_dir: 数据根目录 (config.DATA_DIR)
            keep_days: 保留原始 WAV 的天数（默认 2 天）
            keep_wavs: 压缩后保留原始 WAV（默认 False，用于测试/手动模式）
            ffmpeg_threads: ffmpeg 编码线程上限（0 = ffmpeg 自选，默认 0）
            nice: ffmpeg 子进程 nice 优先级（0 = 不调整；仅 POSIX 生效）
        """
        self.data_dir = data_dir
        self.keep_days = keep_days
        self.keep_wavs = keep_wavs
        self.ffmpeg_threads = ffmpeg_threads
        self.nice = nice

    # ─── 公开 API ────────────────────────────────────────

    async def compress_all(self) -> List[str]:
        """
        压缩 daily 与 stream 两桶中所有需要处理的日期。

        Returns:
            成功压缩项列表，元素为 ``"{bucket}/{date}"``（V18 起含桶名，
            与调度器执行记录/日志对账一致；原返回裸日期无消费方，确认
            仅 main.py 内建任务忽略返回值）。
        """
        items = [("daily", d) for d in self._scan_bucket_dates("daily")]
        items += [("stream", d) for d in self._scan_bucket_dates("stream")]
        if not items:
            logger.info("[AudioCompressor] 没有需要压缩的音频文件")
            return []

        logger.info(
            f"[AudioCompressor] 找到 {len(items)} 个待压缩项: "
            f"{[f'{b}/{d}' for b, d in items]}"
        )
        completed = []
        for bucket, date_str in items:
            try:
                ok = await self._compress_bucket_date(bucket, date_str)
                if ok:
                    completed.append(f"{bucket}/{date_str}")
            except Exception as e:
                logger.error(
                    f"[AudioCompressor] 压缩 {bucket}/{date_str} 失败: {e}",
                    exc_info=True,
                )
        if completed:
            logger.info(
                f"[AudioCompressor] 压缩完成: {len(completed)}/{len(items)} 项"
            )
        return completed

    # ─── 日期检测 ────────────────────────────────────────

    def _scan_bucket_dates(self, bucket: str) -> List[str]:
        """某桶（daily/stream）下超过 keep_days 天且仍有未归档原件的日期清单。

        判定 = 目录名是 ISO 日期 + 超 keep_days + ``{bucket}/{date}/audio`` 内
        有清单口径音频文件（_list_audio_files，wav/flac 双后缀、排除 .analysis）。
        已归档日（audio/ 已删、只剩 archive）因无 audio 目录自然不入选（幂等）。
        """
        today = datetime.now(_CST).date()
        dates = []
        bucket_dir = os.path.join(self.data_dir, bucket)
        if not os.path.isdir(bucket_dir):
            return dates

        for entry in sorted(os.listdir(bucket_dir)):
            entry_path = os.path.join(bucket_dir, entry)
            if not os.path.isdir(entry_path):
                continue
            try:
                d = date.fromisoformat(entry)
            except ValueError:
                continue

            diff = (today - d).days
            if diff < self.keep_days:
                continue

            audio_dir = os.path.join(entry_path, "audio")
            if not os.path.isdir(audio_dir):
                continue

            if self._list_audio_files(audio_dir):
                dates.append(entry)

        return sorted(dates)

    @staticmethod
    def _list_audio_files(audio_dir: str) -> List[str]:
        """归档清单口径：audio/ 目录内可归档音频文件（wav/flac，排除 .analysis.wav）。"""
        return [
            f for f in os.listdir(audio_dir)
            if f.lower().endswith(('.wav', '.flac'))
            and not f.lower().endswith('.analysis.wav')
            and os.path.isfile(os.path.join(audio_dir, f))
        ]

    # ─── 核心压缩 ────────────────────────────────────────

    async def _compress_bucket_date(self, bucket: str, date_str: str) -> bool:
        """
        压缩某桶单日到期的音频（在线程中执行同步 ffmpeg，避免阻塞事件循环）。

        流程:
        1. 构建 WAV/FLAC 文件列表（按文件名排序 = 时间顺序）
        2. 用 ffmpeg concat demuxer 合并所有原件 + 编码为 AAC/M4A
        3. 用 ffprobe 验证输出时长与预期一致
        4. 生成 audio_archive_index.json（含所有片段时间戳）
        5. 删除原始音频文件及 audio/ 目录（除非 keep_wavs=True）
        """
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, self._compress_bucket_date_sync, bucket, date_str
        )

    def _compress_bucket_date_sync(self, bucket: str, date_str: str) -> bool:
        """
        同步版压缩某桶单日音频（在后台线程中执行）。daily/stream 两支共用
        本体，仅 date_dir 前缀不同（V18：不复制逻辑）。
        """
        date_dir = os.path.join(self.data_dir, bucket, date_str)
        audio_dir = os.path.join(date_dir, "audio")

        audio_files = sorted(self._list_audio_files(audio_dir))
        if not audio_files:
            return False

        total_files = len(audio_files)
        logger.info(
            f"[AudioCompressor] 压缩 {bucket}/{date_str}: {total_files} 个音频文件(wav/flac), "
            f"路径={audio_dir}"
        )

        # 检查是否已存在压缩文件（避免重复压缩）
        archive_path = os.path.join(date_dir, ARCHIVE_FILENAME)
        if os.path.exists(archive_path):
            logger.info(
                f"[AudioCompressor] {bucket}/{date_str}: 压缩文件已存在，跳过"
            )
            return True

        concat_file = os.path.join(date_dir, f"_concat_{date_str}.txt")
        segments = []
        total_original_size = 0
        expected_duration = 0.0

        try:
            # ── 1. 构建 ffmpeg concat 列表 + 分段索引 ──
            # concat demuxer 已实测支持 wav+flac 混列（2026-09-23 rc=0），
            # 每个文件独立解码后按序拼接，无需先统一转格式。
            with open(concat_file, 'w', encoding='utf-8') as f:
                for wav in audio_files:
                    wav_path = os.path.join(audio_dir, wav)
                    abs_path = os.path.abspath(wav_path)
                    escaped_path = abs_path.replace('\\', '/').replace("'", "'\\''")
                    f.write(f"file '{escaped_path}'\n")

                    duration = _parse_duration(wav_path)
                    file_size = os.path.getsize(wav_path)
                    total_original_size += file_size
                    expected_duration += duration

                    # 时间字段只取起始 HHMMSS(前 6 位):
                    #   旧格式 {HHMMSS}_{user}.wav            -> "HHMMSS"
                    #   新格式 {起HHMMSS}-{止HHMMSS}_{device}_{startms}.wav -> "起HHMMSS"
                    # 若不截断, 新格式会退化成 "HHMMSS-HHMMSS"
                    base = wav.split('_')[0] if '_' in wav else wav.replace('.wav', '')
                    time_str = base[:6]

                    segments.append({
                        "time": time_str,
                        "filename": wav,
                        "start": round(expected_duration - duration, 2)
                            if segments else 0.0,
                        "end": round(expected_duration, 2),
                        "duration": round(duration, 2),
                        "size": file_size,
                    })

            if expected_duration <= 0:
                logger.error(
                    f"[AudioCompressor] {bucket}/{date_str}: 所有音频时长解析失败，无法压缩"
                )
                if os.path.exists(concat_file):
                    os.remove(concat_file)
                return False

            # ── 2. ffmpeg 合并 + 编码 AAC ──
            ffmpeg = ffmpeg_path()

            cmd = _build_ffmpeg_archive_cmd(
                ffmpeg, concat_file, archive_path,
                threads=self.ffmpeg_threads, nice=self.nice,
            )

            expected_hours = expected_duration / 3600
            logger.info(
                f"[AudioCompressor] {bucket}/{date_str}: 运行 ffmpeg "
                f"(预期时长={expected_hours:.1f}小时)..."
            )
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=7200
            )

            if result.returncode != 0:
                stderr_text = result.stderr[:1000]
                logger.error(
                    f"[AudioCompressor] {bucket}/{date_str}: ffmpeg 失败 "
                    f"(code={result.returncode}): {stderr_text}"
                )
                return False

            if not os.path.exists(archive_path):
                logger.error(
                    f"[AudioCompressor] {bucket}/{date_str}: 输出文件 {ARCHIVE_FILENAME} 未生成"
                )
                return False

            compressed_size = os.path.getsize(archive_path)

            # ── 3. 验证压缩文件完整性 ──
            actual_duration = _get_archive_duration(archive_path)
            if actual_duration > 0:
                diff_ratio = abs(actual_duration - expected_duration) / expected_duration
                if diff_ratio > 0.05:  # 允许 5% 误差
                    logger.warning(
                        f"[AudioCompressor] {bucket}/{date_str}: 时长不匹配! "
                        f"预期={expected_duration:.0f}s, "
                        f"实际={actual_duration:.0f}s "
                        f"(差异={diff_ratio*100:.1f}%)"
                    )
                else:
                    logger.info(
                        f"[AudioCompressor] {bucket}/{date_str}: 完整性验证通过 "
                        f"({actual_duration:.0f}s)"
                    )
            else:
                logger.warning(
                    f"[AudioCompressor] {bucket}/{date_str}: 无法获取压缩文件时长，跳过验证"
                )

            logger.info(
                f"[AudioCompressor] {bucket}/{date_str}: ffmpeg 完成, "
                f"压缩文件={compressed_size} bytes"
            )

            # ── 4. 保存索引 JSON ──
            compression_ratio = 0
            if total_original_size > 0:
                compression_ratio = round(
                    compressed_size / total_original_size * 100, 1
                )

            total_seconds = round(expected_duration, 2)
            index = {
                "date": date_str,
                "format": ARCHIVE_FORMAT,
                "container": ARCHIVE_CONTAINER,
                "sample_rate": 16000,
                "channels": 1,
                "codec": ARCHIVE_CODEC,
                "bitrate": ARCHIVE_BITRATE,
                "original_files": total_files,
                "original_size": total_original_size,
                "compressed_size": compressed_size,
                "compression_ratio": compression_ratio,
                "duration": total_seconds,
                "duration_str": (
                    f"{int(total_seconds // 60)}分{int(total_seconds % 60)}秒"
                ),
                "segments": segments,
            }

            index_path = os.path.join(date_dir, "audio_archive_index.json")
            with open(index_path, 'w', encoding='utf-8') as f:
                json.dump(index, f, ensure_ascii=False, indent=2)

            # ── 5. 删除原始音频文件及目录 ──
            # 安全删除: 清单外无残留音频才整目录 rmtree; 有残留只删清单内,
            # 防止竞态新文件/清单遗漏被整树删除(B 类防丢)。
            if not self.keep_wavs:
                self._safe_purge_audio_dir(audio_dir, set(audio_files))

            # ── 6. 清理临时 concat 文件 ──
            if os.path.exists(concat_file):
                try:
                    os.remove(concat_file)
                except OSError:
                    pass

            size_mb = total_original_size / 1048576
            compressed_mb = compressed_size / 1048576
            logger.info(
                f"[AudioCompressor] {bucket}/{date_str} 压缩完成: "
                f"{total_files} 个文件 -> 1 个 {ARCHIVE_FILENAME}, "
                f"{size_mb:.1f}MB -> {compressed_mb:.1f}MB "
                f"({compression_ratio}%), "
                f"时长 {expected_hours:.1f}小时, "
                f"原始音频已删除={not self.keep_wavs}"
            )
            return True

        except subprocess.TimeoutExpired:
            logger.error(f"[AudioCompressor] {bucket}/{date_str}: ffmpeg 超时 (>2小时)")
            if os.path.exists(archive_path):
                try:
                    os.remove(archive_path)
                except OSError:
                    pass
            return False
        except Exception:
            if os.path.exists(concat_file):
                try:
                    os.remove(concat_file)
                except OSError:
                    pass
            raise

    def _safe_purge_audio_dir(self, audio_dir: str, archived: set) -> None:
        """
        安全删除归档后的原始音频目录（B 类防丢）。

        - 目录内清单外无残留 wav/flac -> 整目录 rmtree（原行为）;
        - 有残留（竞态新文件/清单遗漏）-> 只删清单内文件，残留保留并告警，
          绝不整树删除未归档音频。
        """
        try:
            residue = [
                f for f in os.listdir(audio_dir)
                if f.lower().endswith(('.wav', '.flac'))
                and not f.lower().endswith('.analysis.wav')
                and f not in archived
                and os.path.isfile(os.path.join(audio_dir, f))
            ]
        except OSError as e:
            logger.warning(f"[AudioCompressor] 列目录失败，跳过删除 {audio_dir}: {e}")
            return
        if residue:
            logger.warning(
                f"[AudioCompressor] {audio_dir}: 检测到清单外残留音频 {residue}，"
                f"只删除已归档 {len(archived)} 个文件，保留残留"
            )
            for f in archived:
                fp = os.path.join(audio_dir, f)
                if os.path.isfile(fp):
                    try:
                        os.remove(fp)
                    except OSError as e:
                        logger.warning(f"[AudioCompressor] 删除失败 {fp}: {e}")
            return
        self._rmtree_retry(audio_dir, max_retries=10, delay=3)

    @staticmethod
    def _rmtree_retry(path: str, max_retries: int = 10, delay: int = 3) -> None:
        """
        删除目录及其内容，遇到文件被占用时等待重试。
        """
        for attempt in range(max_retries):
            try:
                shutil.rmtree(path)
                return
            except PermissionError as e:
                if attempt < max_retries - 1:
                    logger.warning(
                        f"[AudioCompressor] 文件被占用，{delay}秒后重试 "
                        f"({attempt + 1}/{max_retries}): {e}"
                    )
                    time.sleep(delay)
                else:
                    logger.error(
                        f"[AudioCompressor] 重试 {max_retries} 次后仍无法删除: {path}"
                    )
                    raise


# ─── 归档指针改写（V18 纯函数，未接线） ─────────────────

def rewrite_archived_pointers(
    entries: List[dict], archive_index: dict, date_str: str
) -> List[dict]:
    """daily 归档删原件后，把 perception 条目的悬空源文件指针改写到归档定位。

    契约（纯函数：无 IO、可证伪、输入不被变异）：
      入参 entries = perception.jsonl 已解析 dict 列表（按单日），
      archive_index = 该日 audio_archive_index.json 解析 dict。
      对每个条目：指针键 ``audio``（相对路径 daily/{date}/audio/{name}）或
      ``src_file``（裸文件名）命中 archive_index["segments"].filename 时——
        audio    -> "daily/{date_str}/audio_archive.m4a"
        src_file -> "audio_archive.m4a"
      并补三键：``archive_start``/``archive_end``（该片段在归档 m4a 内秒位）、
      ``orig_file``（原裸文件名，保溯源）。不命中/非本日期路径的条目原样
      返回（同值对象放入新列表）。跨日期引用不改写（每份 index 只对本日
      负责，日期段必须等于 date_str 才命中）。

    V18 裁定：本函数**不接线**进默认写链——生产 audio_compressor.enabled=
    false，启用与读方（perception_reader 等）解释方式属独立决策；stream 支
    无指针改写需求（origin=stream 默认不写 perception，
    audio_analysis_pipeline L398-430 隔离已证），故仅 daily 支有此函数。
    """
    segments = archive_index.get("segments") or []
    by_name = {
        seg["filename"]: seg for seg in segments
        if isinstance(seg, dict) and seg.get("filename")
    }
    if not by_name:
        return list(entries)

    daily_audio_prefix = f"daily/{date_str}/audio/"
    archive_rel = f"daily/{date_str}/{ARCHIVE_FILENAME}"

    out: List[dict] = []
    for entry in entries:
        orig_name = None
        if isinstance(entry, dict):
            audio_val = entry.get("audio")
            if isinstance(audio_val, str) and audio_val.startswith(daily_audio_prefix):
                orig_name = audio_val[len(daily_audio_prefix):]
            else:
                src_val = entry.get("src_file")
                if isinstance(src_val, str) and src_val in by_name:
                    orig_name = src_val
        seg = by_name.get(orig_name) if orig_name else None
        if seg is None:
            out.append(entry)
            continue

        new_entry = dict(entry)
        if "audio" in new_entry and isinstance(new_entry["audio"], str) \
                and new_entry["audio"].startswith(daily_audio_prefix):
            new_entry["audio"] = archive_rel
        if "src_file" in new_entry:
            new_entry["src_file"] = ARCHIVE_FILENAME
        new_entry["archive_start"] = seg.get("start")
        new_entry["archive_end"] = seg.get("end")
        new_entry["orig_file"] = orig_name
        out.append(new_entry)
    return out


# ─── 单例管理 ────────────────────────────────────────

_compressor_instance: Optional[AudioCompressor] = None


def get_compressor(
    data_dir: Optional[str] = None, keep_days: int = 2,
    ffmpeg_threads: int = 0, nice: int = 0,
) -> AudioCompressor:
    """获取或创建 AudioCompressor 单例（V13 起为调度器内建任务的回调宿主，
    init_compressor/get_started_compressor 随自扫循环删除）。"""
    global _compressor_instance
    if _compressor_instance is None:
        if data_dir is None:
            from config.config import get_config
            data_dir = get_config().DATA_DIR
        _compressor_instance = AudioCompressor(
            data_dir=data_dir, keep_days=keep_days,
            ffmpeg_threads=ffmpeg_threads, nice=nice,
        )
    return _compressor_instance


def reset_compressor() -> None:
    """清空压缩器单例（幂等）；下次 get_compressor 用新参数重建。"""
    global _compressor_instance
    _compressor_instance = None
