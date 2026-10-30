"""
音频补跑脚本：对指定日期的 WAV 文件重新进行全分析（ASR + 情绪 + 场景 + 声纹），
生成 perception.jsonl 增量条目。时间戳从文件名（HHMMSS）中提取。

用于：
1. 历史音频数据补跑（之前未成功分析的音频）
2. 模型升级后重新处理旧音频
3. 手动触发某个日期的增量数据生成

用法:
    cd backend && python ../scripts/backfill_audio.py --date 2026-07-01
    cd backend && python ../scripts/backfill_audio.py --start 2026-06-01 --end 2026-06-30
    cd backend && python ../scripts/backfill_audio.py --date 2026-07-01 --force   # 强制重新分析已有条目
    cd backend && python ../scripts/backfill_audio.py --date 2026-07-01 --dry-run # 只列出不执行
"""

import sys
import os
os.environ['PYTHONUNBUFFERED'] = '1'
os.environ['TQDM_DISABLE'] = '1'           # 禁用 funasr/tqdm 进度条
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
os.environ['MODELSCOPE_LOG_LEVEL'] = 'ERROR'
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
os.environ['PYTHONWARNINGS'] = 'ignore'
import json
import time
import re
import argparse
import logging
import warnings

logging.getLogger('funasr').setLevel(logging.ERROR)
logging.getLogger('modelscope').setLevel(logging.ERROR)
logging.getLogger('torchaudio').setLevel(logging.ERROR)
logging.getLogger('huggingface_hub').setLevel(logging.ERROR)
logging.getLogger('torch').setLevel(logging.ERROR)
logging.getLogger('urllib3').setLevel(logging.ERROR)
warnings.filterwarnings('ignore', category=DeprecationWarning)
warnings.filterwarnings('ignore', category=UserWarning)
warnings.filterwarnings('ignore', message='.*trust_remote_code.*')
warnings.filterwarnings('ignore', message='.*ffmpeg is not installed.*')
warnings.filterwarnings('ignore', message='.*doesn\'t match a supported version.*')
warnings.filterwarnings('ignore', message='.*should be passed as.*')
from datetime import datetime, timezone, timedelta

# 添加 backend 到 sys.path
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.normpath(os.path.join(_SCRIPT_DIR, '..'))
_BACKEND_DIR = os.path.join(_PROJECT_ROOT, 'backend')
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
os.environ['CI'] = 'true'

_CST = timezone(timedelta(hours=8))

# ── 日志 ──────────────────────────────────────────────────────
_log_lines = []

def log(msg: str):
    _log_lines.append(msg)
    print(msg, flush=True)


def parse_ts_from_filename(fname: str) -> str:
    """从文件名提取时间戳，格式 HHMMSS → HH:MM:SS"""
    m = re.match(r'^(\d{2})(\d{2})(\d{2})', fname)
    if m:
        return f"{m[1]}:{m[2]}:{m[3]}"
    return ""


def load_existing_perception_entries(date_dir: str) -> set:
    """加载当天已有 perception.jsonl 中的 audio 路径集合，用于去重"""
    pfile = os.path.join(date_dir, "perception.jsonl")
    existing = set()
    if not os.path.exists(pfile):
        return existing
    with open(pfile, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get("type") == "voice" and entry.get("audio"):
                    existing.add(entry["audio"])
            except json.JSONDecodeError:
                continue
    return existing


def build_voice_entry(segments, audio_events, scene, audio_rel_path: str,
                      ts_val: str, asr_text: str, duration: float,
                      device_name: str = "") -> dict:
    """构建 voice 类型的 perception 条目（与 perception.py voice_summary 逻辑一致）"""
    if not segments:
        return {"type": "voice", "t": ts_val, "dur": 0, "tag": "other",
                "text": "", "audio": audio_rel_path}

    dur = round(duration or max(s.get("end", 0) for s in segments), 0)

    # 场景标签
    scene_label = ""
    if isinstance(scene, dict):
        primary = scene.get("scene_primary", {})
        scene_label = primary.get("label_cn", "") or primary.get("label", "")
    elif isinstance(scene, str):
        scene_label = scene

    # 顶层 ASR 总文本
    top_text = ""
    if asr_text and "<|nospeech|>" not in str(asr_text):
        top_text = asr_text[:1000]
    else:
        combined = " ".join(
            s.get("text", "").strip() for s in segments
            if s.get("text", "").strip() and "<|nospeech|>" not in str(s.get("text", ""))
        )
        if combined:
            top_text = combined[:1000]

    # 情绪
    all_emotions = []
    for seg in segments:
        et = seg.get("emotion_tag", "")
        ep = seg.get("emotion_prob", 0)
        if et:
            all_emotions.append((et, float(ep)))
    emo_val = None
    if all_emotions:
        best = max(all_emotions, key=lambda x: x[1])
        emo_val = {"t": best[0], "p": round(best[1], 2)}

    # 环境音 top-5
    env_val = None
    if audio_events:
        env_labels = [
            e.get("label_cn", e.get("label", ""))
            for e in audio_events[:5]
            if e.get("label_cn") or e.get("label")
        ]
        if env_labels:
            env_val = env_labels

    # 构建 segs 数组
    seg_entries = []
    all_window_scores = []

    for seg in segments:
        text = seg.get("text", "").strip()
        if not text or "<|nospeech|>" in str(text):
            continue

        se = {
            "start": round(float(seg.get("start", 0)), 1),
            "end": round(float(seg.get("end", 0)), 1),
            "text": text[:500],
        }

        windows = seg.get("voiceprint_windows", [])
        sim = seg.get("voiceprint_sim")

        if windows and sim is not None:
            scores = [w["score"] for w in windows]
            total = len(scores)
            pct = sum(1 for s in scores if s > 0.0) / total if total > 0 else 0
            ws_flat = []
            for w in windows:
                ws_flat.append(round(w["start_ms"]))
                ws_flat.append(round(w["score"], 4))
            se["vp"] = {
                "spk": seg.get("voiceprint_speaker", ""),
                "sim": round(float(sim), 4),
                "max": round(max(scores), 4) if scores else 0,
                "pct": round(pct, 4),
                "ws": ws_flat,
            }
            if text and scores:
                n_char = len(text)
                n_sc = len(scores)
                se["tokens"] = [
                    {"c": ch, "v": round(scores[min(int(i * n_sc / n_char), n_sc - 1)], 4)}
                    for i, ch in enumerate(text)
                ]
            all_window_scores.extend(scores)
        elif sim is not None:
            se["vp"] = {
                "spk": seg.get("voiceprint_speaker", ""),
                "sim": round(float(sim), 4),
            }
            if text:
                se["tokens"] = [{"c": ch, "v": round(float(sim), 4)} for ch in text]

        # 段情绪
        et = seg.get("emotion_tag", "")
        ep = seg.get("emotion_prob", 0)
        if et:
            se["emo"] = {"t": et, "p": round(float(ep), 2)}

        seg_entries.append(se)

    # 整体 tag
    if all_window_scores:
        overall_pct = sum(1 for s in all_window_scores if s > 0.0) / len(all_window_scores)
        if overall_pct >= 0.90:
            tag_val = "self"
        elif overall_pct >= 0.20:
            tag_val = "mixed"
        else:
            tag_val = "other"
    else:
        tag_val = "other"

    if not seg_entries:
        top_text = ""

    # 声学特征
    ac_val = None
    avg_dbs = [s.get("avg_db", 0) for s in segments if s.get("avg_db", 0) != 0]
    speech_pcts = [(s.get("voice_ratio", 0) or s.get("speech_prob", 0)) for s in segments]
    if avg_dbs or any(speech_pcts):
        ac_val = {
            "db": round(float(sum(avg_dbs) / len(avg_dbs)), 1) if avg_dbs else 0,
            "spk": round(float(sum(speech_pcts) / len(speech_pcts)) * 100, 1) if speech_pcts else 0,
        }

    result = {
        "type": "voice",
        "t": ts_val,
        "dur": dur,
        "tag": tag_val,
        "text": top_text,
        "audio": audio_rel_path,
    }
    if scene_label:
        result["scene"] = scene_label
    if seg_entries:
        result["segs"] = seg_entries
    if ac_val:
        result["ac"] = ac_val
    if env_val:
        result["env"] = env_val
    if emo_val:
        result["emo"] = emo_val
    if device_name:
        result["device_name"] = device_name

    return result


def main():
    parser = argparse.ArgumentParser(
        description="音频补跑：重新分析 WAV 文件并生成 perception.jsonl 增量条目"
    )
    parser.add_argument("--date", type=str, default=None,
                        help="处理指定日期 (YYYY-MM-DD)")
    parser.add_argument("--start", type=str, default=None,
                        help="起始日期 (YYYY-MM-DD)，与 --end 配合")
    parser.add_argument("--end", type=str, default=None,
                        help="结束日期 (YYYY-MM-DD)，与 --start 配合")
    parser.add_argument("--force", action="store_true",
                        help="强制重新分析已有 perception 条目的音频")
    parser.add_argument("--dry-run", action="store_true",
                        help="只列出待处理的文件，不执行分析")
    parser.add_argument("--max-files", type=int, default=0,
                        help="最多处理的文件数（0=不限）")
    parser.add_argument("--device-name", type=str, default="",
                        help="条目中的设备名称（可选）")
    parser.add_argument("--skip-panns", action="store_true",
                        help="跳过 PANNs 环境音分析（更快，但条目无 scene/env 字段）")
    parser.add_argument("--workers", type=int, default=1,
                        help="并行处理线程数（默认 1，建议 2-4 提升速度）")
    args = parser.parse_args()

    # ── 日期解析 ──────────────────────────────────────────────
    if args.date:
        dates = [args.date]
    elif args.start and args.end:
        start_dt = datetime.strptime(args.start, "%Y-%m-%d")
        end_dt = datetime.strptime(args.end, "%Y-%m-%d")
        dates = []
        cur = start_dt
        while cur <= end_dt:
            dates.append(cur.strftime("%Y-%m-%d"))
            cur += timedelta(days=1)
    else:
        log("错误: 请指定 --date 或 --start/--end")
        sys.exit(1)

    # ── 导入服务 ──────────────────────────────────────────────
    log("正在加载服务模块...")
    # 抑制第三方库日志
    for _log_name in ['funasr', 'modelscope', 'torch', 'torchaudio', 'huggingface_hub', 'urllib3', 'root']:
        _lg = logging.getLogger(_log_name)
        _lg.setLevel(logging.ERROR)
        _lg.handlers.clear()
    try:
        from services.multimodal_audio_manager import get_multimodal_audio_manager
        from services.perception_store import _DATA_BASE
        from services.voiceprint_service import get_voiceprint_service
        from config.config import get_config
    except ImportError as e:
        log(f"导入失败: {e}")
        log("请确保在 backend/ 目录中运行此脚本")
        sys.exit(1)

    def _write_perception(entry, target_date):
        """直接写入指定日期的 perception.jsonl（绕过 append_perception 的当天日期限制）"""
        target_dir = os.path.join(_DATA_BASE, target_date)
        os.makedirs(target_dir, exist_ok=True)
        target_path = os.path.join(target_dir, "perception.jsonl")
        if "type" not in entry:
            entry["type"] = "sample"
        with open(target_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return True

    cfg = get_config()
    mgr = get_multimodal_audio_manager()
    vp = get_voiceprint_service()
    data_dir = cfg.DATA_DIR
    # perception 数据存储在 DATA_DIR/daily/ 子目录下
    daily_base = os.path.join(data_dir, "daily")

    log(f"  数据目录: {data_dir}")
    log(f"  daily 基路径: {daily_base}")
    log(f"  注册声纹数: {vp.get_speaker_count()}")
    if vp.get_speaker_count() > 0 and not args.dry_run:
        for spk in vp.list_speakers():
            log(f"    说话人: {spk['name']}")

    # 加载模型（首次调用会耗时）
    log("正在加载音频模型...")
    t0 = time.time()
    if not args.dry_run:
        mgr.load_models()
    log(f"  模型加载耗时: {time.time() - t0:.1f}s")

    # ── 扫描所有日期的音频 ───────────────────────────────────
    total_processed = 0
    total_skipped = 0
    total_errors = 0
    total_per_date = {}

    for date_str in dates:
        audio_dir = os.path.join(daily_base, date_str, "audio")
        date_dir = os.path.join(daily_base, date_str)

        if not os.path.isdir(audio_dir):
            log(f"\n[跳过] {date_str}: 音频目录不存在")
            continue

        # 列出 WAV 文件，按文件名排序
        wav_files = sorted([
            f for f in os.listdir(audio_dir)
            if f.endswith('.wav') and os.path.isfile(os.path.join(audio_dir, f))
        ])

        if not wav_files:
            log(f"\n[跳过] {date_str}: 没有 WAV 文件")
            continue

        # 加载已有条目用于去重
        existing = set()
        if not args.force:
            existing = load_existing_perception_entries(date_dir)
            log(f"\n[{date_str}] 共 {len(wav_files)} 个 WAV，已有 {len(existing)} 个 perception 条目")

        # 过滤出需要处理的文件
        to_process = []
        for fname in wav_files:
            rel_path = f"daily/{date_str}/audio/{fname}"
            if rel_path in existing and not args.force:
                total_skipped += 1
                continue
            to_process.append(fname)

        if not to_process:
            log(f"  所有文件已处理完成，无需补跑")
            total_per_date[date_str] = {"total": len(wav_files), "processed": 0,
                                         "skipped": len(wav_files), "errors": 0}
            continue

        # 限制最大文件数
        if args.max_files > 0:
            to_process = to_process[:args.max_files]

        log(f"  待处理: {len(to_process)} 个文件{' (限数)' if args.max_files and len(to_process) < len([f for f in wav_files if f not in existing]) else ''}")
        total_per_date[date_str] = {"total": len(wav_files), "processed": 0,
                                     "skipped": len(wav_files) - len(to_process),
                                     "errors": 0}

        if args.dry_run:
            for fname in to_process:
                ts = parse_ts_from_filename(fname)
                log(f"  [DRY-RUN] {fname} (t={ts})")
            total_processed += len(to_process)
            continue

        # ── 可选：跳过 PANNs 环境分析 ───────────────────────
        _saved_scene_analyzer = None
        if args.skip_panns and mgr._processor is not None:
            _saved_scene_analyzer = getattr(mgr._processor, 'scene_analyzer', None)
            mgr._processor.scene_analyzer = None
            log("  [PANNs 已跳过] 不分析环境音")

        # ── 对每个 WAV 执行分析 ──────────────────────────────
        date_processed = 0
        date_errors = 0

        if args.workers > 1:
            # ── 多线程模式：每个 worker 加载独立的 SenseVoice 模型 ──
            import threading
            import concurrent.futures
            import queue
            import soundfile as sf
            from funasr import AutoModel
            from config.config import get_config as _cfg2

            _lock = threading.Lock()
            _counter = [0]
            _local_ok = [0]
            _local_err = [0]

            # 预加载 N 个独立 SenseVoice 模型实例（每个 worker 一个）
            _modelscope_root = os.path.join(os.path.expanduser("~"), ".cache", "modelscope", "hub", "models", "iic")
            _cache_dir = os.path.join(_modelscope_root, "SenseVoiceSmall")
            _device = getattr(mgr._processor, 'device', 'cuda:0') if mgr._processor else 'cuda:0'
            log(f"  预加载 {args.workers} 个 SenseVoice 模型实例 (device={_device})...")
            _model_queue = queue.Queue()
            for wi in range(args.workers):
                m = AutoModel(
                    model="SenseVoiceSmall",
                    model_path=_cache_dir,
                    disable_update=True,
                    device=_device,
                )
                _model_queue.put(m)
                log(f"    模型 [{wi+1}/{args.workers}] 加载完成")

            def _run_asr(model, audio_path: str) -> dict:
                """用指定模型单次 ASR 推理"""
                raw = model.generate(
                    input=audio_path,
                    language="auto",
                    use_itn=True,
                    ban_emo_unk=True,
                )
                # 解析结果（同 audio_processor._parse_sensevoice_result）
                segments = []
                texts = []
                if isinstance(raw, list):
                    for item in raw:
                        if isinstance(item, dict):
                            text = item.get("text", "").strip()
                            if text:
                                texts.append(text)
                            segs_raw = item.get("segments")
                            if segs_raw and isinstance(segs_raw, list):
                                for s in segs_raw:
                                    if isinstance(s, dict):
                                        st = s.get("text", "").strip()
                                        if st:
                                            segments.append({
                                                "start": float(s.get("start", 0)),
                                                "end": float(s.get("end", 0)),
                                                "text": st,
                                            })
                if not segments and texts:
                    segments.append({"start": 0, "end": 0, "text": "".join(texts)})
                return {"segments": segments, "text": "".join(texts)}

            def _process_one_parallel(fname):
                """worker 线程：获取独立模型 → ASR → 结果处理"""
                model = _model_queue.get()
                try:
                    fpath = os.path.join(audio_dir, fname)
                    ts = parse_ts_from_filename(fname)
                    rel_path = f"daily/{date_str}/audio/{fname}"

                    # ASR
                    result = _run_asr(model, fpath)
                    segments = result.get("segments", [])
                    asr_text = result.get("text", "")

                    # 音频时长
                    try:
                        info = sf.info(fpath)
                        duration = round(info.duration, 1)
                    except Exception:
                        duration = 0

                    # 声纹
                    if vp.get_speaker_count() > 0 and segments:
                        try:
                            spk_result = vp.identify(fpath, top_k=1)
                            if spk_result:
                                best_spk = spk_result[0]
                                for seg in segments:
                                    if not seg.get("voiceprint_sim"):
                                        seg["voiceprint_sim"] = best_spk.get("similarity", 0)
                                        seg["voiceprint_speaker"] = best_spk.get("name", "")
                        except Exception:
                            pass

                    entry = build_voice_entry(
                        segments=segments, audio_events=[], scene={},
                        audio_rel_path=rel_path, ts_val=ts, asr_text=asr_text,
                        duration=duration, device_name=args.device_name,
                    )
                    ok = _write_perception(entry, date_str)
                    with _lock:
                        if ok:
                            _local_ok[0] += 1
                        else:
                            _local_err[0] += 1
                        _counter[0] += 1
                        c = _counter[0]
                    text_preview = (entry.get("text", "") or "")[:50]
                    if c % 50 == 0 or c == len(to_process):
                        log(f"  [{c}/{len(to_process)}] {fname} {'OK' if ok else 'FAIL'} tag={entry.get('tag','?')} text={text_preview or '(空)'}")
                except Exception as e:
                    with _lock:
                        _local_err[0] += 1
                        _counter[0] += 1
                    log(f"  [ERROR] {fname}: {e}")
                finally:
                    _model_queue.put(model)

            log(f"  启动 {args.workers} 线程并行处理 ({len(to_process)} 个文件)...")
            t_start_parallel = time.time()
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
                list(executor.map(_process_one_parallel, to_process))
            elapsed = time.time() - t_start_parallel
            log(f"  并行完成: {elapsed:.0f}s ({elapsed/max(len(to_process),1):.1f}s/文件)")

            date_processed = _local_ok[0]
            date_errors = _local_err[0]

        else:
            # ── 单线程模式（原逻辑） ──
            for idx, fname in enumerate(to_process):
                fpath = os.path.join(audio_dir, fname)
                ts = parse_ts_from_filename(fname)
                rel_path = f"daily/{date_str}/audio/{fname}"
                size_kb = os.path.getsize(fpath) // 1024

                log(f"  [{idx + 1}/{len(to_process)}] {fname} ({size_kb}KB, t={ts})")

                try:
                    # 全分析
                    result = mgr.analyze(fpath)

                    if not result.get("success"):
                        log(f"    [FAIL] 分析失败: {result.get('error', 'unknown')}")
                        date_errors += 1
                        continue

                    # 提取分析结果
                    segments = result.get("segments", [])
                    duration = result.get("duration", 0)
                    scene = result.get("scene", {})
                    audio_events = result.get("audio_events", [])

                    texts = [s.get("text", "") for s in segments if s.get("text")]
                    asr_text = "".join(texts)

                    # 声纹识别（如果已有声纹库）
                    if vp.get_speaker_count() > 0 and segments:
                        try:
                            spk_result = vp.identify(fpath, top_k=1)
                            if spk_result:
                                best_spk = spk_result[0]
                                for seg in segments:
                                    if not seg.get("voiceprint_sim"):
                                        seg["voiceprint_sim"] = best_spk.get("similarity", 0)
                                        seg["voiceprint_speaker"] = best_spk.get("name", "")
                        except Exception as e:
                            log(f"    [WARN] 声纹识别失败: {e}")

                    # 构建 voice 条目
                    entry = build_voice_entry(
                        segments=segments,
                        audio_events=audio_events,
                        scene=scene,
                        audio_rel_path=rel_path,
                        ts_val=ts,
                        asr_text=asr_text,
                        duration=duration,
                        device_name=args.device_name,
                    )

                    # 写入 perception.jsonl（直接写 target 日期，绕过 append_perception 的当天日期限制）
                    ok = _write_perception(entry, date_str)
                    if ok:
                        date_processed += 1
                        text_preview = (entry.get("text", "") or "")[:50]
                        log(f"    [OK] tag={entry.get('tag', '?')} text={text_preview or '(空)'}")
                    else:
                        log(f"    [FAIL] perception 写入失败")
                        date_errors += 1

                except Exception as e:
                    log(f"    [ERROR] {e}")
                    date_errors += 1

        total_processed += date_processed
        total_errors += date_errors
        total_per_date[date_str]["processed"] = date_processed
        total_per_date[date_str]["errors"] = date_errors

        # 恢复 PANNs（如在 --skip-panns 模式下禁用过）
        if args.skip_panns and _saved_scene_analyzer is not None and mgr._processor is not None:
            mgr._processor.scene_analyzer = _saved_scene_analyzer
            log("  [PANNs 已恢复]")

        # 每处理完一个日期后打印小计
        log(f"  [{date_str}] 完成: {date_processed} 成功, {date_errors} 失败")

    # ── 汇总 ──────────────────────────────────────────────────
    total_time = time.time() - t0 if not args.dry_run else 0
    log("=" * 60)
    log("  回填汇总")
    log("=" * 60)
    if args.dry_run:
        log(f"  [DRY-RUN] 共扫描 {total_processed} 个待处理文件")
    else:
        log(f"  处理日期数: {len([d for d in dates if d in total_per_date])}")
        log(f"  成功写入:   {total_processed} 条")
        log(f"  跳过(已有): {total_skipped} 条")
        log(f"  失败:       {total_errors} 条")
        if total_time > 0:
            log(f"  总耗时:     {total_time:.1f}s")
        log(f"  每文件平均: {total_time / total_processed:.1f}s" if total_processed > 0 else "")

    # 打印每个日期的小结
    for d, stats in sorted(total_per_date.items()):
        log(f"    {d}: {stats['processed']} 条写入 / {stats['errors']} 条失败 / {stats['skipped']} 条跳过(共{stats['total']})")


if __name__ == "__main__":
    main()
