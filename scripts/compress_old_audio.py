"""
一次性音频压缩脚本：压缩所有超过 keep_days 天的旧音频文件。

用于：
1. 首次部署压缩服务时，压缩已有的历史数据
2. 手动触发立即压缩

用法:
    python scripts/compress_old_audio.py                          # 默认保留最近2天
    python scripts/compress_old_audio.py --keep-days 7            # 保留最近7天
    python scripts/compress_old_audio.py --dry-run                # 只列出不执行
    python scripts/compress_old_audio.py --keep-wavs              # 压缩但保留原始WAV（测试用）
    python scripts/compress_old_audio.py --date 2026-06-01        # 只压缩指定日期
"""

import os
import sys
import argparse
import asyncio
import logging

# 添加 backend 目录到 Python path
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.normpath(os.path.join(_SCRIPT_DIR, '..'))
_BACKEND_DIR = os.path.join(_PROJECT_ROOT, 'backend')
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
logger = logging.getLogger('compress_old_audio')


async def main():
    parser = argparse.ArgumentParser(description='压缩旧音频文件')
    parser.add_argument(
        '--keep-days', type=int, default=2,
        help='保留最近 N 天的原始 WAV 文件（默认: 2）'
    )
    parser.add_argument(
        '--dry-run', action='store_true',
        help='只列出需要压缩的日期，不实际执行'
    )
    parser.add_argument(
        '--date', type=str, default=None,
        help='只压缩指定日期（YYYY-MM-DD 格式）'
    )
    parser.add_argument(
        '--keep-wavs', action='store_true',
        help='压缩后保留原始 WAV 文件（用于测试验证）'
    )
    parser.add_argument(
        '--verbose', action='store_true',
        help='输出详细日志'
    )
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # 导入配置和压缩器
    from config.config import get_config
    from services.audio_compressor import AudioCompressor

    cfg = get_config()
    data_dir = cfg.DATA_DIR

    compressor = AudioCompressor(
        data_dir=data_dir,
        keep_days=args.keep_days,
        keep_wavs=args.keep_wavs,
    )

    print("=" * 60)
    print(f"  音频压缩工具")
    print(f"  数据目录: {data_dir}")
    print(f"  保留天数: {args.keep_days} 天")
    print(f"  执行模式: {'只列出（dry-run）' if args.dry_run else '立即压缩'}")
    print(f"  保留WAV: {'是（测试模式）' if args.keep_wavs else '否（压缩后删除）'}")
    if args.date:
        print(f"  指定日期: {args.date}")
    print("=" * 60)

    if args.date:
        # 压缩指定日期
        date_path = os.path.join(data_dir, args.date, "audio")
        if not os.path.isdir(date_path):
            print(f"\n[!] 日期 {args.date} 的音频目录不存在: {date_path}")
            return

        wav_count = len([
            f for f in os.listdir(date_path)
            if f.endswith('.wav') and os.path.isfile(os.path.join(date_path, f))
        ])
        print(f"\n  日期 {args.date}: {wav_count} 个 WAV 文件")

        if args.dry_run:
            print(f"  [dry-run] 跳过执行")
        else:
            if wav_count == 0:
                print(f"  无需压缩")
            else:
                ok = await compressor._compress_single_date(args.date)
                print(f"  {'[OK] 压缩完成' if ok else '[FAIL] 压缩失败'}")
    else:
        # 自动查找所有需要压缩的日期
        dates = compressor._get_dates_to_compress()
        if not dates:
            print("\n  没有需要压缩的日期（所有数据均在保留期内或无音频文件）")
            return

        print(f"\n  待压缩日期 ({len(dates)} 个):")
        total_wavs = 0
        total_size = 0
        for d in dates:
            audio_dir = os.path.join(data_dir, d, "audio")
            wavs = [
                f for f in os.listdir(audio_dir)
                if f.endswith('.wav') and os.path.isfile(os.path.join(audio_dir, f))
            ]
            size = sum(
                os.path.getsize(os.path.join(audio_dir, f)) for f in wavs
            )
            total_wavs += len(wavs)
            total_size += size
            print(
                f"    {d}: {len(wavs):>5} 个文件, "
                f"{size/1048576:.1f} MB"
            )

        print(f"  {'─' * 40}")
        print(
            f"    合计: {total_wavs} 个文件, "
            f"{total_size/1048576:.1f} MB"
        )

        if args.dry_run:
            print(f"\n  [dry-run] 跳过执行")
            print(f"  运行时不带 --dry-run 来实际执行压缩")
        else:
            print(f"\n  开始压缩...")
            completed = await compressor.compress_all()
            print(f"\n  [完成] {len(completed)}/{len(dates)} 个日期压缩成功")
            if len(completed) < len(dates):
                failed = set(dates) - set(completed)
                print(f"  [失败] {len(failed)} 个: {', '.join(sorted(failed))}")
                print(f"  请检查日志了解详细错误信息")


if __name__ == '__main__':
    asyncio.run(main())
