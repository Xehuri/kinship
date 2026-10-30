# -*- coding: utf-8 -*-
"""
音频分析流水线（同步执行）

本模块由 routers/perception.py 中 _trigger_audio_analysis 的内联 _run（约 600 行）
抽取而来，供单 worker 音频分析队列直接同步调用。

设计要点（B2 起，外层零算法残留）：
  1. analyze_audio_file 为同步函数，绝不 spawn 线程；并发控制（GPU 锁、队列串行）
     由调用方负责。
  2. 算法唯一路径 = 内核：主链四 kind(vad/asr/scene/diarize) + 残留两件
     (aed/breath) 经 kernel_job_client 作业取回并适配；段级声纹评分与
     滑窗趋势经 kernel_client.score_all_v2 单请求(detail+sliding+collect)；
     陌生人链经 POST /v1/unknown/track 一次产出。原文件存在性检查、
     _ensure_wav 格式转码（旁路 {stem}.analysis.wav，原文件字节不变）、段落富化
     与 append_perception 等业务编排原样保留。
  3. 内核不可达/主链作业失败 → 延迟重投（retry-with-backoff，见 _schedule_retry），
     绝不回退本地模型；重投超限丢弃必记 ERROR 日志（原件留存 daily/，可回填重放，
     绝不静默丢音频）。
  4. 所有重服务导入保持惰性（函数内导入），避免拖慢后端启动。
"""

import logging
import os
import sys
from datetime import datetime, timedelta, timezone

from services.audio_config import get_audio_config
# K2: 声纹评分经内核（断连自动降级为空结果，只记一次日志，绝不外抛）
# B2: 评分垫片新增 sliding/collect 透传（整段一次请求出分数+滑窗+采集）
from services.kernel_client import score_all_v2 as kernel_score

logger = logging.getLogger(__name__)

# 东八区
_CST = timezone(timedelta(hours=8))

# ─── 音频配置(模块级快照: 导入时加载, 热更新走 reload_audio_config_snapshot) ───
_AUDIO_CFG: dict = {}
_VP_AUDIO_CFG: dict = {}
_SLIDING_CFG: dict = {}
_SEG_CFG: dict = {}
_AS_NORM_CFG: dict = {}
_TAG_CFG: dict = {}

# 段级声纹滑窗(阶段8: 与 two_step 统一为 1500/750, 由 1000/750 变更)
_SLIDING_WINDOW_MS: int = 1500
_SLIDING_HOP_MS: int = 750
# speaker 名标注阈值(原硬编码 0.5)
_SPK_LABEL_THR: float = 0.5
# 进入声纹分析的最短段(原 0.5s)
_MIN_SPEECH_S: float = 0.5
# Wave C1 清理：原 _VAD_COVERAGE / _MAX_SEG_S 两常量(旧两步切分/建档链遗留,
# 链已上内核后全文件零引用)随本地切分本体一并摘除；vad_coverage/max_s 配置键
# 保留(未知消费方在 config 层面可继续透传内核)。
# AS-Norm 域切换门(原硬编码 10, 与内核 voiceprint.service AS_NORM_MIN_COHORT 同源)
_AS_NORM_MIN_COHORT: int = 10
# 逐字/整段身份分档阈值(原 0.75/0.30/0.90/0.20)
_TAG_REGISTERED_SIM: float = 0.75
_TAG_MIXED_SIM: float = 0.30
_TAG_SELF_PCT: float = 0.90
_TAG_MIXED_PCT: float = 0.20
# 流式音频是否也写 perception.jsonl(audio.stream.persist_perception, 默认 False=流式隔离)
_PERSIST_STREAM_PERCEPTION: bool = False


def _load_audio_config_snapshot() -> None:
    """把最新 audio 配置写入模块级快照（全局赋值，供函数动态读取）。"""
    global _AUDIO_CFG, _VP_AUDIO_CFG, _SLIDING_CFG, _SEG_CFG
    global _AS_NORM_CFG, _TAG_CFG
    global _SLIDING_WINDOW_MS, _SLIDING_HOP_MS, _SPK_LABEL_THR, _MIN_SPEECH_S
    global _AS_NORM_MIN_COHORT
    global _TAG_REGISTERED_SIM, _TAG_MIXED_SIM, _TAG_SELF_PCT, _TAG_MIXED_PCT
    global _PERSIST_STREAM_PERCEPTION

    cfg = get_audio_config()
    _AUDIO_CFG = cfg
    _VP_AUDIO_CFG = cfg.get("voiceprint", {}) or {}
    _SLIDING_CFG = _VP_AUDIO_CFG.get("sliding", {}) or {}
    _SEG_CFG = _VP_AUDIO_CFG.get("segment", {}) or {}
    _AS_NORM_CFG = _VP_AUDIO_CFG.get("as_norm", {}) or {}
    _TAG_CFG = _VP_AUDIO_CFG.get("tag", {}) or {}

    _SLIDING_WINDOW_MS = int(_SLIDING_CFG.get("window_ms", 1500))
    _SLIDING_HOP_MS = int(_SLIDING_CFG.get("hop_ms", 750))
    _SPK_LABEL_THR = float(_SLIDING_CFG.get("label_threshold", 0.5))
    _MIN_SPEECH_S = float(_SEG_CFG.get("min_speech_s", 0.5))
    _AS_NORM_MIN_COHORT = int(_AS_NORM_CFG.get("min_cohort", 10))
    _TAG_REGISTERED_SIM = float(_TAG_CFG.get("registered_sim", 0.75))
    _TAG_MIXED_SIM = float(_TAG_CFG.get("mixed_sim", 0.30))
    _TAG_SELF_PCT = float(_TAG_CFG.get("self_pct", 0.90))
    _TAG_MIXED_PCT = float(_TAG_CFG.get("mixed_pct", 0.20))
    _PERSIST_STREAM_PERCEPTION = bool(
        (cfg.get("stream", {}) or {}).get("persist_perception", False)
    )


def reload_audio_config_snapshot() -> None:
    """热重载音频分析管线的模块级配置快照（幂等，可在任意时刻调用）。"""
    _load_audio_config_snapshot()


_load_audio_config_snapshot()

# ─── B2: 内核 cohort 采集开关 ───
# 段级评分请求 collect=True: 内核内三门+去重+日限采集, 写内核 state-dir cohort
# 文件(生产 cohort 池自 9-22 断供, B2 重新开闸; 外层本地采集路径随
# voiceprint_service.score_all_v2 一并退役)。
_COLLECT_ENABLED = True

# ─── B2: 降级全家桶删除 → requeue 延迟重投参数 ───
# 内核不可达/主链作业失败/适配异常时不再回退本地算法, 改为延迟重投:
# 退避参数(60s 起步倍增、封顶 900s)在 audio_analysis_queue 侧单一事实源；
# 这里只持有重试次数上限(总窗口≈51 分钟, 覆盖内核重启)。超限丢弃记 ERROR
# (原始音频文件仍在 daily/ 目录永久留存, 可经回填脚本重放——绝不静默丢数据)。
_RETRY_MAX_ATTEMPTS = 10


def analyze_audio_file(
    audio_abs_path: str,
    start_epoch_ms: int | None,
    device_name: str = "",
    ts_val: str | None = None,
    origin: str = "upload",
    attempt: int = 0,
) -> str:
    """对单个音频文件执行完整感知分析（同步，不 spawn 线程）。

    Args:
        audio_abs_path: 音频文件绝对路径
        start_epoch_ms: 音频起始绝对时间（epoch 毫秒）；None 时退回当前时间
        device_name: 设备名（写入感知条目）
        ts_val: 文件记录时刻 "HH:MM:SS"；None 时由 start_epoch_ms 推算
        origin: 音频来源标记（"upload" | "stream"），默认 "upload" 保持既有行为；
            "stream"（流式音频）时不写 perception.jsonl，避免污染 AI 增量数据。
        attempt: B2 requeue 重试次数（0=首次；>0 为重投消费），随条目透传。

    Returns:
        "ok"    正常完成（含无语音跳过）；
        "retry" 内核主链不可达/作业失败 -> 已安排延迟重投（或超限丢弃）。
        绝不回退本地模型（B2 起外层零算法残留）。
    """
    audio_path = audio_abs_path
    # 旁路转码文件（瞬态衍生品）：分析结束一律删除，不在数据目录持久保存
    analysis_path: "str | None" = None
    # 统一时间基准：有绝对时间用绝对时间，否则用当前东八区时间
    if start_epoch_ms is not None:
        _base_dt = datetime.fromtimestamp(start_epoch_ms / 1000.0, tz=_CST)
    else:
        _base_dt = datetime.now(_CST)
    if not ts_val:
        ts_val = _base_dt.strftime("%H:%M:%S")
    try:
        from services.perception_store import append_perception
        from config.config import get_config

        if not os.path.exists(audio_path):
            logger.warning(f"[AudioAnalysis] 音频文件不存在: {audio_path}")
            return "ok"

        # 检查音频格式，非 WAV 则转码到旁路（原文件字节保持不变）
        analysis_path = _ensure_wav(audio_path)
        if not analysis_path:
            logger.warning(f"[AudioAnalysis] 音频格式不支持且无法转换，跳过分析: {os.path.basename(audio_path)}")
            return "ok"

        # ── B2: 主链四 kind 内核作业（算法唯一路径）──
        # run_audio_analysis_jobs 返回 None(内核不可达/503/作业失败/超时)时
        # **不再回退本地 mgr.analyze 全家桶**，改延迟重投（requeue with backoff）：
        # 原件永久留存 daily/、旁路由本函数每次重算，重试时文件必在；超限丢弃
        # 必记 ERROR（绝不静默丢音频——用户红线）。
        # 函数体内 import -> 测试经 patch services.kernel_job_client 缝生效。
        # analysis_path: 分析/读盘一律走旁路 WAV(内核契约只收 WAV);
        # audio_path(原件)只用于 perception.jsonl 溯源指针。
        from services.kernel_job_client import run_audio_analysis_jobs as _run_kernel_jobs

        kernel_facts = _run_kernel_jobs(analysis_path)
        result = None
        if kernel_facts:
            try:
                result = _adapt_kernel_facts(kernel_facts, analysis_path)
            except Exception as e:
                # 适配异常同样按"本次分析失败"处理（重投幂等、无副作用半写：
                # append_perception 在本函数最末尾，此前不落任何增量数据）
                logger.warning(f"[AudioAnalysis] 内核 facts 适配失败（转重投）: {e}")
                result = None
        if result is None:
            logger.warning(
                f"[AudioAnalysis] 内核主链不可用，安排延迟重投: "
                f"{os.path.basename(audio_path)} (attempt={attempt})"
            )
            _schedule_retry(audio_path, start_epoch_ms, device_name, origin, attempt)
            return "retry"

        # 提取关键结果
        # U7(2026-10-08): 顶层 emotion/speaker/silent 读取已删——_adapt_kernel_facts
        # 返回值无此三键(emotion2vec 2026-10-07 整体移除后恒缺省)，零消费方。
        asr_text = _extract_asr_text(result)
        scene = result.get("scene", "")
        audio_events = result.get("audio_events", [])
        segments = result.get("segments", [])
        vad_segments = result.get("vad_segments", [])

        # ── B2: 段级声纹评分 + 滑窗趋势 + cohort 采集 = 每段一次内核请求 ──
        # 取代旧"整段打分 + 逐窗 HTTP 往返"（一段最多几十次 → 一次）。
        # 门: 内核注册库有条目才评分（V10: 计数改内核探针 vp_speaker_count,
        # 失败降级 0=跳过打分, 语义同旧镜像内存读; is_ready 的本地模型就绪
        # 语义随 C2 退役——评分本体已在内核, 外层不加载模型）。
        # 读盘走 analysis_path(旁路 WAV): soundfile 对原件 FLAC 之外的
        # AAC 等格式也不可用，分析路径统一为旁路保证可读。
        if segments and os.path.exists(analysis_path):
            try:
                import numpy as np
                import soundfile as sf
                from services import kernel_client
                if kernel_client.vp_speaker_count() > 0:
                    audio_full, fs = sf.read(analysis_path)
                    for seg in segments:
                        seg_start = seg.get("start", 0)
                        seg_end = seg.get("end", 0)
                        s_sample = int(seg_start * fs)
                        e_sample = int(seg_end * fs)
                        seg_text = seg.get("text", "")
                        _speech_prob = seg.get("speech_prob", 0.0)
                        _has_speech = seg_text and "<|nospeech|>" not in seg_text

                        if _has_speech and (seg_end - seg_start) >= _MIN_SPEECH_S:
                            # 1. VAD子段提取（只取有声部分，纯数据管理——业务编排保留）
                            if vad_segments:
                                vad_parts = []
                                for vs in vad_segments:
                                    vs_s = max(int(vs.get("start", 0) * fs), s_sample)
                                    vs_e = min(int(vs.get("end", 0) * fs), e_sample)
                                    if vs_e > vs_s:
                                        vad_parts.append(audio_full[vs_s:vs_e])
                                if vad_parts:
                                    seg_vad = np.concatenate(vad_parts) if len(vad_parts) > 1 else vad_parts[0]
                                else:
                                    seg_vad = audio_full[s_sample:e_sample]
                            else:
                                seg_vad = audio_full[s_sample:e_sample]

                            seg_len = len(seg_vad)
                            if seg_len > 0:
                                # 2. 整段打分 + 滑窗趋势 + cohort 采集（一次内核请求）
                                # 旧路径: 整段 1 次 + 每窗 1 次 kernel_score 往返；
                                # 新路径: sliding/collect 为内核 A2 additive 参数，
                                # facts 一并回六键 + windows 扁平数组 + 采集两键。
                                # 不可达时垫片返回空 detail（只记一次日志）——
                                # 打分降级不标注、不触发 requeue（requeue 只管主链）。
                                detail = {}
                                try:
                                    detail = kernel_score(
                                        seg_vad,
                                        sample_rate=fs,
                                        detail=True,
                                        sliding={"window_ms": _SLIDING_WINDOW_MS,
                                                 "hop_ms": _SLIDING_HOP_MS},
                                        collect=_COLLECT_ENABLED,
                                        collect_meta={
                                            "src_file": os.path.basename(audio_path),
                                            "src_t": ts_val,
                                            "src_start": seg_start,
                                            "src_end": seg_end,
                                            "speech_prob": _speech_prob,
                                        },
                                    ) or {}
                                except Exception:
                                    detail = {}
                                full_scores = detail.get("scores") or {}
                                _win_max = None   # 内核窗分统计（旧路径缺失致 vp.max/pct 空）
                                _win_pct = None
                                if full_scores:
                                    try:
                                        # Gap-8 修复: spk 名字只在分数达阈值才标, 否则空串
                                        # (原: 无条件取 top1 名字, sim≈-0.7 也标用户 → 污染下游)
                                        _top_name = list(full_scores.keys())[0]
                                        _top_score = round(list(full_scores.values())[0], 4)
                                        _spk_label_thr = _SPK_LABEL_THR  # 读配置(原与 two_step.user_score_threshold 一致)
                                        seg["voiceprint_speaker"] = _top_name if _top_score >= _spk_label_thr else ""
                                        seg["voiceprint_sim"] = _top_score
                                        _top_ok = bool(seg["voiceprint_speaker"])
                                    except Exception:
                                        _top_name, _top_score, _top_ok = "", 0.0, False
                                else:
                                    _top_name, _top_score, _top_ok = "", 0.0, False

                                # 3. 滑动窗口趋势（由 facts.windows 扁平数组重建，零往返）
                                # 内核 windows=[start_ms, score, ...]（win_samp/hop_samp/
                                # round 位与外层旧逐窗循环逐项一致, A2 对齐锁）。
                                # 窗级 speaker 名: 内核只回分数不回窗级 top 名——
                                # 窗分达阈值时沿用段级 top 名（与旧"该窗 top1 名"的
                                # 差异仅在多注册人且窗间 top 翻转时才出现, 见交付报告）。
                                if seg_len >= int(_SLIDING_WINDOW_MS * fs / 1000):
                                    windows = []
                                    flat = detail.get("windows") or []
                                    for i in range(0, len(flat) - 1, 2):
                                        try:
                                            _w_ms = int(flat[i])
                                            _w_score = round(float(flat[i + 1]), 4)
                                        except (TypeError, ValueError):
                                            continue
                                        windows.append({
                                            "start_ms": _w_ms,
                                            "score": _w_score,
                                            "speaker": _top_name if (_top_ok and _w_score >= _SPK_LABEL_THR) else "",
                                        })
                                    if windows:
                                        seg["voiceprint_windows"] = windows
                                        scores_arr = [w["score"] for w in windows]
                                        high_scores = [s for s in scores_arr if s > 0.0]
                                        _win_max = detail.get("win_max")
                                        _win_pct = detail.get("win_pct")
                                        seg["voiceprint_stats"] = {
                                            "min": round(min(scores_arr), 4),
                                            "max": (round(float(_win_max), 4)
                                                    if _win_max is not None
                                                    else round(max(scores_arr), 4)),
                                            "avg": round(sum(scores_arr) / len(scores_arr), 4),
                                            "user_ratio": round(len(high_scores) / len(scores_arr), 4) if scores_arr else 0,
                                        }
            except ImportError:
                logger.debug("[AudioAnalysis] numpy/soundfile 不可用")
            except Exception as e:
                logger.debug(f"[AudioAnalysis] 声纹匹配异常: {e}")

        # ── 陌生人判定: B2 已整链上内核 /v1/unknown/track(文件级一次产出,
        #    见 _apply_track_blocks)。旧"逐窗打分+候选区提取+本地 embedding
        #    建档"两步切分链(约 350 行)随本波删除——外层零算法残留。


        # 日志：ASR
        log_parts = [f"[AudioAnalysis] {os.path.basename(audio_path)}"]
        if asr_text:
            log_parts.append(f"ASR=\"{asr_text[:150]}{'...' if len(asr_text) > 150 else ''}\"")
        else:
            log_parts.append("ASR=(无语音)")

        # 日志：VAD
        duration = result.get("duration", 0)
        if not duration and segments:
            duration = max(s.get("end", 0) for s in segments)
        if not duration and vad_segments:
            duration = max(s.get("end", 0) for s in vad_segments)
        if not duration:
            duration = os.path.getsize(audio_path) / 32000 if os.path.exists(audio_path) else 0
        dur_part = f"dur={duration:.0f}s"
        if vad_segments:
            dur_part += f"({len(vad_segments)}段VAD)"
        log_parts.append(dur_part)

        # 日志：场景（只取主要场景名，不要整块 JSON）
        scene_label = ""
        if isinstance(scene, dict):
            # scene_primary 允许为 None(内核 facts 音频过短/无主场景) -> or {} 防御
            primary = scene.get("scene_primary") or {}
            scene_label = primary.get("label_cn", "") or primary.get("label", "")
        elif isinstance(scene, str):
            scene_label = scene
        if scene_label:
            log_parts.append(f"场景={scene_label}")

        # 日志：声纹（从 segments 的实际处理结果聚合）
        vp_segs = [s for s in segments if s.get("voiceprint_speaker")]
        if vp_segs:
            best_seg = max(vp_segs, key=lambda s: s.get("voiceprint_sim", 0))
            best_spk = best_seg.get("voiceprint_speaker", "?")
            best_sim = best_seg.get("voiceprint_sim", 0)
            stats = best_seg.get("voiceprint_stats", {})
            if stats:
                log_parts.append(f"声纹={best_spk}(sim={best_sim:.3f},"
                                 f"win={stats.get('min',0):.3f}/{stats.get('avg',0):.3f}/{stats.get('max',0):.3f},"
                                 f"hit={stats.get('user_ratio',0):.0%})")
            else:
                log_parts.append(f"声纹={best_spk}(sim={best_sim:.3f})")
            log_parts.append(f"vp_segs={len(vp_segs)}/{len(segments)}")
        else:
            log_parts.append("声纹=(无匹配)")

        # 日志：声纹系统状态（每段分析时附带）
        try:
            from services import kernel_client
            spk_count = kernel_client.vp_speaker_count()
            _cohort_stats = kernel_client.vp_cohort_stats()
            cohort_n = _cohort_stats.get("active", 0)
            as_norm = "AS" if cohort_n >= _AS_NORM_MIN_COHORT else "raw"
            log_parts.append(f"vp={spk_count}spk/{cohort_n}co({as_norm})")
        except Exception:
            pass

        # 日志：分段详情
        if segments:
            for i, seg in enumerate(segments):
                seg_text = seg.get("text", "")
                if seg_text:
                    log_parts.append(f"  段{i}: \"{seg_text[:100]}\"")

        logger.info(" | ".join(log_parts))

        # ── B2: 陌生人链切内核 /v1/unknown/track（文件级一次产出）──
        # 原"四层本地链"(L1 pyannote 本地切块 + 本地 embedding + L2/L3 本地
        # 会话/档案) 整链上内核(A4): 外层只喂音频+读结论(facts.blocks 段级
        # 身份 kind/name/unk_id/ref_sim/count/is_new)。门: unknown_speaker.
        # enabled 配置(纯业务开关, 不涉算法)。track 失败/不可达 -> spk 身份
        # 退回既有分档(registered/mixed/env, 业务阈值判定非算法), 绝不本地
        # 建档。读盘走 analysis_path(旁路 WAV, 恒 16k/单声道/16bit, 内核 track
        # 严格校验)。track 同步消费, 无延迟读盘者, 与旁路瞬态语义兼容。
        try:
            if _unknown_speaker_enabled():
                from services.kernel_job_client import unknown_track as _kernel_track
                # file_key 幂等: 原件 basename(含时间戳+设备, 全局唯一); 内核按
                # file_key 溯源, 重投重放同 key 回 duplicate 不重复计权。
                _file_key = os.path.basename(audio_path)
                _track_facts = _kernel_track(
                    _file_key,
                    audio_path=analysis_path,
                    start_epoch_ms=start_epoch_ms,
                    device_t=device_name or None,
                )
                if _track_facts:
                    _n_mapped = _apply_track_blocks(segments, _track_facts)
                    log_parts2 = [f"[UnknownTrack] {_file_key}"]
                    log_parts2.append(f"reason={_track_facts.get('reason', '?')}")
                    log_parts2.append(f"blocks={len(_track_facts.get('blocks') or [])}")
                    if _track_facts.get("profiles_touched"):
                        log_parts2.append(
                            "touched=%d" % len(_track_facts["profiles_touched"])
                        )
                    log_parts2.append("mapped=%d" % _n_mapped)
                    logger.info(" | ".join(log_parts2))
        except Exception as _track_err:
            logger.debug(f"[UnknownTrack] track 喂送异常: {_track_err}")

        # 感知条目写入门控：仅上传音频写入 perception.jsonl（origin 默认 "upload"）。
        # 流式音频（origin="stream"）默认不写增量数据，避免污染 AI 按日分析；
        # 来源由调用方（分析队列 / 上传路由）显式透传，缺省保持既有行为。
        # 调试/回滚开关：audio.stream.persist_perception=true 时流式音频同样写入
        # perception.jsonl（默认 false，即保持流式隔离）。配置在模块级快照，
        # 可经 reload_audio_config_snapshot() 热重载。
        if origin != "stream" or _PERSIST_STREAM_PERCEPTION:
            # 如果 ASR 有文本但之前没有传 text，补写 perception entry
            if asr_text and not any(
                entry.get("type") == "voice"
                for entry in [{}]  # placeholder - we don't check previous entries
            ):
                enriched_entry = voice_summary(
                    segments, audio_events, scene,
                    os.path.relpath(audio_path, get_config().DATA_DIR).replace("\\", "/"),
                    _base_dt.strftime("%H:%M:%S"),
                    asr_text or "",
                    duration if 'duration' in dir() else 0,
                    start_epoch_ms=start_epoch_ms,
                )
                if device_name:
                    enriched_entry["device_name"] = device_name
                # 陌生人自动识别（补充功能，副作用，失败静默）
                # B5 收口: 本地 unknown_speaker_pipeline.detect_stranger_from_entry
                # (读外层冻结索引库取 count/status + 本地整段归档) 退役——
                # 陌生人链已在内核 A4 闭环, confirmed 身份由 track 块
                # (kind=unknown) 直接携带, entry 级 unk 摘要改纯内存聚合。
                try:
                    _summarize_unk_entry(enriched_entry)
                except Exception:
                    pass
                # 事件日期分桶：离线补传/重放行不再漂进当日桶；口径同 save_audio 的 start_ms
                append_perception(enriched_entry, auto_type=False,
                                  date_str=_base_dt.strftime("%Y-%m-%d"))
        else:
            logger.debug(
                f"[AudioAnalysis] origin=stream 跳过 perception 写入: {os.path.basename(audio_path)}"
            )

    except ImportError as e:
        logger.warning(f"[AudioAnalysis] 分析模块未加载: {e}")
    except Exception as e:
        logger.error(f"[AudioAnalysis] 分析异常: {e}", exc_info=True)
    finally:
        # 旁路转码文件是瞬态衍生品, 分析结束一律清理, 不在数据目录持久保存
        # (目录只留原件 wav/flac)。安全性: 旁路的消费者全部在本函数内同步完成
        # ——内核作业长轮询到终态、残留两件作业、声纹 sf.read/track 喂送都在
        # finally 之前返回。靠 ".analysis.wav" 后缀识别旁路, 原件永不触碰;
        # 复用崩溃遗留的旁路也在此一并清掉。重投（requeue）走原件路径参数,
        # 下次消费时 _ensure_wav 会重新生成旁路。
        _purge_analysis_bypass(analysis_path)
    return "ok"


def _schedule_retry(audio_path: str, start_epoch_ms: int | None,
                    device_name: str, origin: str, attempt: int) -> None:
    """B2 requeue：内核不可达/主链失败时的延迟重投登记（绝不静默丢音频）。

    两条调度路径（perception 后台线程直调 / 分析队列单 worker）都汇聚到
    analyze_audio_file，重投统一登记进 AudioAnalysisQueue 的延迟重试堆，
    由 worker 到点回投——两条调度各自无需再处理重试语义，最小侵入。
    不重不漏：主队列对同一路径的重投堆去重（同路径只留一个堆条目，
    最新 attempt 覆盖），防止后台线程/队列双消费同文件时重复登记。

    限次/超限丢弃在此判定（而非堆）：超过 _RETRY_MAX_ATTEMPTS 即记 ERROR
    放弃重投。原始音频仍永久留存 daily/{date}/audio/，事后可经回填脚本
    重放（绝不丢数据是用户红线；丢弃的只是"分析任务"而非"音频"）。
    """
    nxt = attempt + 1
    if nxt > _RETRY_MAX_ATTEMPTS:
        logger.error(
            f"[AudioAnalysis] 重投超限丢弃分析(音频原件仍在 daily/, 可回填重放): "
            f"{audio_path} (已尝试 {attempt} 次)"
        )
        return
    try:
        from services.audio_analysis_queue import get_analysis_queue

        get_analysis_queue().schedule_retry(
            audio_path, start_epoch_ms, device_name, origin, nxt
        )
    except Exception as e:
        # 登记失败也不静默: ERROR 记录后放弃(不阻塞 worker 消费下一条)
        logger.error(
            f"[AudioAnalysis] 重投登记失败(本条分析丢失, 音频原件仍在可回填): {e}"
        )


def _unknown_speaker_enabled() -> bool:
    """unknown_speaker.enabled 业务开关(纯配置读, 不 import 本地算法链)。

    B2 起管线不再 import services.unknown_speaker_config(本地四层链配置模块,
    C1 随本体删除)——直接读 config.yaml 顶层 unknown_speaker 节(经 Config
    实例的原始数据), 缺省 False fail-safe 与历史一致。读失败同样 False。
    """
    try:
        from config.config import get_config

        cfg = get_config()
        section = getattr(cfg, "_data", {}) or {}
        return bool((section.get("unknown_speaker") or {}).get("enabled", False))
    except Exception:
        return False


def _apply_track_blocks(segments: list, track_facts: dict) -> int:
    """B2: /v1/unknown/track 的 facts.blocks -> 段级 spk 富对象映射。

    内核 A4 已在 track 内完成 L1-L4 闭环并对块做身份归类(confirmed
    unknown > registered > mixed > env, 阈值 tagging 节内置=生产值),
    外层只做时间对齐与直通, **不做二次判定、不本地建档**。

    对齐规则: 块(start_ms/end_ms 为文件相对毫秒)与 ASR 语音段(秒)求
    重叠, 取重叠时长最大的块作为该段身份来源; 无重叠块 -> 段不映射
    (spk 走既有分档阈值: registered/mixed/env 是业务规则非算法)。

    形状硬约束(voice 条目零变化): 产出与 voice_summary 既有 spk 富对象
    同键集 {id,kind,name,unk_id,ref_sim,count,is_new}; kind=unknown 时
    id=unk_id/name=None, registered 时 id=name/unk_id=None —— 与旧
    confirmed-unknown / registered 分支逐键一致。
    """
    blocks = [b for b in (track_facts.get("blocks") or []) if isinstance(b, dict)]
    if not blocks:
        return 0
    mapped = 0
    for seg in segments:
        text = seg.get("text", "") or ""
        if not text.strip() or "<|nospeech|>" in text:
            continue
        s_ms = float(seg.get("start", 0)) * 1000.0
        e_ms = float(seg.get("end", 0)) * 1000.0
        best = None
        best_overlap = 0.0
        for b in blocks:
            ov = min(e_ms, float(b.get("end_ms", 0))) - max(s_ms, float(b.get("start_ms", 0)))
            if ov > best_overlap:
                best_overlap = ov
                best = b
        if best is None:
            continue
        kind = str(best.get("kind") or "")
        if kind not in ("unknown", "registered", "mixed", "env"):
            continue
        unk_id = best.get("unk_id")
        name = best.get("name")
        seg["voiceprint_track_spk"] = {
            "id": (unk_id if kind == "unknown" else
                   (name if (kind == "registered" and name) else kind)),
            "kind": kind,
            "name": name if kind == "registered" else None,
            "unk_id": unk_id,
            "ref_sim": round(float(best.get("ref_sim") or 0.0), 4),
            "count": best.get("count"),
            "is_new": bool(best.get("is_new")),
        }
        mapped += 1
    return mapped


def _summarize_unk_entry(entry: dict) -> None:
    """voice 条目级 confirmed 陌生人摘要（B5 收口，纯内存聚合）。

    取代旧 ``unknown_speaker_pipeline.detect_stranger_from_entry``（该函数
    读外层冻结索引库补 count/status 并做整段归档——链已在内核 A4 闭环）。
    内核 track 块只在命中 **confirmed** 档案时产出 kind=unknown 并自带
    count/ref_sim，故外层无需再查库: 汇总 entry.segs[].spk（voice_summary
    组装后的最终身份），取命中段数最多的 unk 写 entry["unk"]。

    契约形状与历史一致（docs/DATA_FORMAT.md voice 节）:
    ``{id, count, seg_count, score}``，仅当出现 confirmed 陌生人时写入。
    """
    unk_stats = {}  # unk_id -> {"segs": 命中段数, "count": 档案累计, "score": ref_sim}
    for seg in entry.get("segs", []) or []:
        spk = seg.get("spk") or {}
        if spk.get("kind") != "unknown":
            continue
        unk_id = spk.get("unk_id")
        if not unk_id:
            continue
        hit = unk_stats.setdefault(
            unk_id,
            {"segs": 0, "count": spk.get("count"), "score": spk.get("ref_sim")},
        )
        hit["segs"] += 1
    if not unk_stats:
        return
    top_id = max(unk_stats, key=lambda k: unk_stats[k]["segs"])
    top = unk_stats[top_id]
    unk_summary = {
        "id": top_id,
        "count": top["count"] if top["count"] is not None else 1,
        "seg_count": top["segs"],
    }
    if top["score"] is not None:
        unk_summary["score"] = round(float(top["score"]), 4)
    entry["unk"] = unk_summary



def _purge_analysis_bypass(bypass_path: "str | None") -> None:
    """删除分析用的 .analysis.wav 旁路（瞬态衍生品，不落数据目录）。

    仅当路径确为旁路（".analysis.wav" 结尾）才删——原件（.wav/.flac）永不触碰
    （WAV 上传时 _ensure_wav 原样返回路径，此时不相等、不删）。删除失败（如
    Windows 瞬时占用）只记 DEBUG：旁路缺失的后果只是下次重转码一次，无害。
    """
    if not bypass_path or not bypass_path.endswith(".analysis.wav"):
        return  # 原件(非旁路)或无旁路: 绝不误删
    try:
        if os.path.isfile(bypass_path):
            os.remove(bypass_path)
            logger.debug(f"[AudioAnalysis] 旁路已清理: {os.path.basename(bypass_path)}")
    except OSError as e:
        logger.debug(f"[AudioAnalysis] 旁路清理失败(忽略): {e}")


def _adapt_kernel_facts(
    facts: dict,
    audio_abs_path: str,
) -> dict:
    """内核四类作业 facts -> 既有 result 形状（B1 适配层，B2 残留两件切内核）。

    - 时间换算: 内核 facts 时间点一律 _ms 后缀, 此处统一转秒(下游按秒消费);
    - 字段来源: 只映射内核 facts 已有的键, 不造内核没有的数据
      (diarize 的 gender/timeline 颜色/align_with_segments 回写按 TDD 规则
       无现有测试依据, 不做投机扩展);
    - 残留两件(PANNs 逐窗 AED/breath 叹气) B2 起改提交内核
      analyze.aed/breath 两 kind(A1 移植), 不再经 mgr.analyze_local_residuals
      本地补算——外层零算法残留。任一残留作业失败/不可达 -> 对应字段降级为
      空/未校准(对齐旧代码 try/except 粒度), 绝不回退本地模型, 也不触发 requeue
      (主链已成功)。2026-10-07: analyze.emotion 整体移除(emotion2vec 输出恒空)。

    Args:
        facts: {"analyze.vad": {...}, "analyze.asr": {...},
                "analyze.scene": {...}, "analyze.diarize": {...}}
        audio_abs_path: wav 绝对路径(残留两件作业提交用, 同机内核直读)

    Returns:
        与原 mgr.analyze() 同形状的 result dict(下游提取键全部就位)。
    """
    from services.kernel_job_client import run_residual_analysis_jobs

    vad_f = facts.get("analyze.vad") or {}
    asr_f = facts.get("analyze.asr") or {}
    scene_f = facts.get("analyze.scene") or {}
    dia_f = facts.get("analyze.diarize") or {}

    # ASR 段: ms -> 秒; word_ts 为绝对毫秒(相对音频起点), 原样透传供逐字着色
    segments = []
    for s in asr_f.get("segments") or []:
        seg = {
            "start": round(float(s.get("start_ms", 0)) / 1000.0, 2),
            "end": round(float(s.get("end_ms", 0)) / 1000.0, 2),
            "text": s.get("text", ""),
            "emotion": s.get("emotion", ""),
            "confidence": s.get("confidence", 0),
        }
        # additive: 内核 asr facts 补齐的 word_ts/words 透传
        # (_build_char_tokens 逐字声纹着色依赖; 缺失时该函数自动回退均匀映射)
        if s.get("word_ts"):
            seg["word_ts"] = s["word_ts"]
            if s.get("words"):
                seg["words"] = s["words"]
        segments.append(seg)

    # VAD 段: ms -> 秒(下游两步切分/feed 按秒消费)
    vad_segments = [
        {"start": round(float(x.get("start_ms", 0)) / 1000.0, 2),
         "end": round(float(x.get("end_ms", 0)) / 1000.0, 2)}
        for x in vad_f.get("segments") or []
    ]

    # 场景: 保留 voice_summary/perception_store 消费的三键形状
    scene = {
        "scene_primary": scene_f.get("scene_primary"),
        "scene_tags": scene_f.get("scene_tags") or [],
        "scene_groups": scene_f.get("scene_groups") or {},
    }

    # diarize: 只映射内核已有 n_speakers/分段(ms->秒); gender/timeline 颜色
    # 与 align 回写无测试依据, 按 TDD 规则不做(现有键 speaker_diarization 保留)
    speaker_diarization = {
        "n_speakers": dia_f.get("n_speakers"),
        "segments": [
            {"start": round(float(x.get("start_ms", 0)) / 1000.0, 2),
             "end": round(float(x.get("end_ms", 0)) / 1000.0, 2),
             "speaker": x.get("speaker")}
            for x in dia_f.get("segments") or []
        ],
    }

    # 时长: 任一 facts 的 duration_ms 均可(同音频同一时长)
    duration = 0.0
    for f in (asr_f, vad_f, scene_f, dia_f):
        if f.get("duration_ms"):
            duration = round(float(f["duration_ms"]) / 1000.0, 1)
            break

    result = {
        "success": True,
        "duration": duration,
        "text": asr_f.get("text", ""),
        "segments": segments,
        "vad_segments": vad_segments,
        "scene": scene,
        "speaker_diarization": speaker_diarization,
    }

    # ── B2: 残留作业切内核(aed/breath; 2026-10-07 emotion 整体移除——
    # emotion2vec 权重 decoder miss 输出恒空、零消费方, 不再提交)。
    # 任一作业失败/不可达 -> 该字段降级为空/未校准(旧 try/except 粒度), 绝不本地补算。
    vad_timeline_ms = [
        {"start_ms": int(round(float(v.get("start", 0)) * 1000)),
         "end_ms": int(round(float(v.get("end", 0)) * 1000))}
        for v in vad_segments
    ]
    residual = run_residual_analysis_jobs(
        audio_abs_path,
        vad_timeline_ms=vad_timeline_ms or None,
    )
    _merge_residual_facts(result, segments, residual)
    return result


# PANNs Speech 概率校准常数(与 audio_processor.SPEECH_THRESHOLD /
# CONFIDENCE_PENALTY 同值——纯算术阈值属业务编排, 推理本体在内核 aed)
_SPEECH_THRESHOLD = 0.3
_CONFIDENCE_PENALTY = 0.6

# 呼吸事件 type -> 中文(与 sigh_detector 同表)
_BREATH_TYPE_CN = {"sigh": "叹气", "breath": "深呼吸"}


def _merge_residual_facts(result: dict, segments: list, residual: dict) -> None:
    """内核残留两件 facts -> 旧 analyze_local_residuals 的合并语义。

    逐字段对照旧路径(外层 _run_aed_detection / _calibrate_segment_confidence /
    _run_breath_detection), 保证 perception voice 条目形状零变化:

    - aed: facts.events {start_ms,end_ms,label,label_cn,prob,...} -> 秒口径
      {start,end,label,label_cn,probability,probability_pct,count};
      失败/缺失 -> audio_events 不写键(旧: AED 模型缺失返回 None 不写)。
    - emotion: 2026-10-07 整体移除(emotion2vec 输出恒空、零消费方), 段 emotion
      保留 ASR(SenseVoice) 原标签不再改写; 原 emotion confidence=1.0 的副作用由
      下述 PANNs Speech 二次校准统一接管(公式不变)。
      **PANNs Speech 二次校准**(旧同款): 概率取自
      aed 事件流中标签 Speech 与段重叠的最高 prob(aed 为 2s 窗 50% 重叠的
      逐窗检测, 段重叠取 max; aed 缺失时该段跳过校准——旧代码 scene_analyzer
      为 None 同样跳过), 低于 0.3 罚乘 0.6, 否则 *1.1 封顶 0.95, 并写
      speech_prob(下游 ac 与 cohort 采集元数据消费)。
    - breath: facts.breaths {start_ms,end_ms,kind} -> {start,end,type,type_cn};
      空/失败 -> 不写键(旧: None 不写)。旧含的 confidence 内核 facts 未回——
      breath_events 不落 perception、零消费方, 故不补键(零形状风险)。
    """
    aed_f = residual.get("analyze.aed") or {}
    breath_f = residual.get("analyze.breath") or {}

    # 1) AED 事件(秒口径, 与旧 _run_aed_detection 输出逐键一致)
    aed_events = []
    for ev in aed_f.get("events") or []:
        prob = ev.get("prob")
        prob_pct = ("%d%%" % int(float(prob) * 100)) if prob is not None else ""
        aed_events.append({
            "start": round(float(ev.get("start_ms", 0)) / 1000.0, 1),
            "end": round(float(ev.get("end_ms", 0)) / 1000.0, 1),
            "label": ev.get("label", ""),
            "label_cn": ev.get("label_cn", ev.get("label", "")),
            "probability": prob,
            "probability_pct": prob_pct,
            "count": ev.get("count", 1),
        })
    if aed_events:
        # 旧语义: _run_aed_detection 有事件才写键(无事件/模型缺失返回 None 不写)
        result["audio_events"] = aed_events

    # 2) PANNs Speech 二次校准(aed Speech 标签段重叠近似)。
    #    2026-10-07: emotion2vec 主校准已整体移除(aed/breath 保留), 段 confidence
    #    直接进 PANNs 二次校准(旧: 先 emotion2vec 总改 confidence, 后 PANNs 叠加)。
    #    旧同款: 概率取自 aed 事件流中标签 Speech 与段重叠的最高 prob(aed 为 2s 窗
    #    50% 重叠的逐窗检测, 段重叠取 max; aed 缺失时该段跳过校准——旧代码
    #    scene_analyzer 为 None 同样跳过), 低于 0.3 罚乘 0.6, 否则 *1.1 封顶 0.95,
    #    并写 speech_prob(下游 ac 与 cohort 采集元数据消费)。
    speech_events = [
        e for e in aed_events if e.get("label") == "Speech"
    ]
    for seg in segments:
        s_ms = int(round(float(seg.get("start", 0)) * 1000))
        e_ms = int(round(float(seg.get("end", 0)) * 1000))
        # PANNs Speech 概率: 与段有时间重叠的 Speech 事件最高 prob;
        # 无重叠事件 -> aed 成功但未见 Speech(概率低于 0.1 窗内阈) -> 按 0 计;
        # aed 整体缺失 -> 跳过二次校准(旧: scene_analyzer 为 None 同跳过)。
        if aed_f:
            speech_prob = 0.0
            for ev in speech_events:
                if ev["start"] < (e_ms / 1000.0) and ev["end"] > (s_ms / 1000.0):
                    try:
                        p = float(ev.get("probability") or 0.0)
                    except (TypeError, ValueError):
                        p = 0.0
                    if p > speech_prob:
                        speech_prob = p
            base_conf = seg.get("confidence", 0.8) or 0.8
            if speech_prob < _SPEECH_THRESHOLD:
                penalty = max(speech_prob / _SPEECH_THRESHOLD, 0.2)
                cal_conf = base_conf * penalty * _CONFIDENCE_PENALTY
            else:
                cal_conf = min(base_conf * 1.1, 0.95)
            seg["confidence"] = round(cal_conf, 2)
            seg["confidence_pct"] = "%d%%" % int(cal_conf * 100)
            seg["speech_prob"] = round(speech_prob, 3)

    # 3) 呼吸事件
    if breath_f:
        breaths = [
            {
                "start": round(float(b.get("start_ms", 0)) / 1000.0, 2),
                "end": round(float(b.get("end_ms", 0)) / 1000.0, 2),
                "type": b.get("kind", ""),
                "type_cn": _BREATH_TYPE_CN.get(b.get("kind", ""), b.get("kind", "")),
            }
            for b in breath_f.get("breaths") or []
        ]
        if breaths:
            result["breath_events"] = breaths


def _build_char_tokens(seg, text: str, windows: list):
    """按真实时间对齐把滑窗声纹分映射到每个字符。

    2026-09-05 修复: 原实现按字符序号均匀映射(语速均匀假设) → 实际语速不均时
    大量错位(实测 36字段 26字分错, 平均差0.33)。改为用 ASR output_timestamp
    的逐字时间戳(word_ts, 绝对ms) 对齐滑窗真实时间(start_ms 相对语音段起点)。

    词→字符分配: ASR words 是分词(中文每字一词, 英文按词/子词), text 与
    words 可能不等长(标点/itn/空字符)。策略: 遍历 text 每个字符, 尽量把
    word_ts 按 words 与 text 的顺序对齐消费; 对不上的字符(标点等) 沿用前一词时间。
    窗口时间基准: windows[k].start_ms 相对本段语音起点(0 起), word_ts 绝对ms,
    差一个 seg.start 偏移 → 统一转相对 seg 起点后比较。

    Returns:
        list[{c, v}] — 无 word_ts 时回退均匀映射(旧行为, 保证 tokens 恒有值)。
    """
    try:
        word_ts = seg.get("word_ts") or []
        words = seg.get("words") or []
        if not text or not windows:
            return None
        n_win = len(windows)
        n_char = len(text)
        if n_win == 0 or n_char == 0:
            return None
        # 无逐字时间戳: 回退字符序号均匀映射(旧逻辑)
        if not word_ts:
            scores = [float(w.get("score", 0)) for w in windows]
            return [{"c": ch,
                     "v": round(scores[min(int(i * n_win / n_char), n_win - 1)], 4)}
                    for i, ch in enumerate(text)]
        seg_start_ms = float(seg.get("start", 0)) * 1000.0

        # 窗口时间轴(相对 seg 起点ms) → 排序后的 (start, end, score)
        win_iv = []
        for w in windows:
            st = float(w.get("start_ms", 0))
            # 窗口时长读配置 audio.voiceprint.sliding.window_ms, 末窗可能不足
            win_iv.append((st, st + float(_SLIDING_WINDOW_MS), float(w.get("score", 0))))
        if not win_iv:
            return None

        # 字符时间: 逐词消费 words+word_ts, 每词时长均分到词内字符
        char_t = []  # (char, mid_ms_abs)
        w_idx = 0
        pos = 0
        n_w = len(words)
        # words 里可能有空串/空格, 预清理但保持 index
        while pos < len(text):
            ch = text[pos]
            # 找与当前字符匹配的 word 前缀(跳过空 word)
            matched = False
            for wi in range(w_idx, min(w_idx + 3, n_w)):
                wstr = str(words[wi] or "").strip()
                if not wstr:
                    continue
                if text.startswith(wstr, pos):
                    # 该词命中: 时长均分到 wstr 各字符
                    t0, t1 = float(word_ts[wi][0]), float(word_ts[wi][1])
                    L = len(wstr)
                    if L <= 0:
                        matched = True
                        w_idx = wi + 1
                        break
                    for k in range(L):
                        c_mid = t0 + (t1 - t0) * (k + 0.5) / L
                        char_t.append((wstr[k], c_mid))
                    pos += L
                    w_idx = wi + 1
                    matched = True
                    break
            if not matched:
                # 单字符无法配词(标点/识别差异): 沿用前一词末时间或本词首
                if w_idx < n_w and word_ts[w_idx]:
                    c_mid = float(word_ts[w_idx][0])
                elif char_t:
                    c_mid = char_t[-1][1]
                else:
                    c_mid = 0.0
                char_t.append((ch, c_mid))
                pos += 1

        if len(char_t) != len(text):
            return None

        # 每字符中心时刻(相对 seg 起点) → 找覆盖它的窗口取分
        def _score_at(abs_ms):
            rel = abs_ms - seg_start_ms
            # 找窗口: start <= rel < start+window_ms(读配置)
            best = None
            best_dist = 1e18
            for (st, en, sc) in win_iv:
                if st <= rel < en:
                    return sc
                d = 0.0
                if rel < st:
                    d = st - rel
                elif rel > en:
                    d = rel - en
                if d < best_dist:
                    best_dist = d
                    best = sc
            return best if best is not None else win_iv[-1][2]

        out = []
        for ch, c_mid in char_t:
            v = round(float(_score_at(c_mid)), 4)
            out.append({"c": ch, "v": v})
        return out
    except Exception:
        logger.debug("[Voiceprint] 逐字时间对齐映射失败, 回退均匀映射", exc_info=True)
        return None

def _extract_asr_text(result):
    """从音频分析结果提取全量转写文本。

    优先级：
      1. 顶层 asr_text（历史兼容键，通常不存在）；
      2. 顶层 text（multimodal_audio_manager.analyze 在 process 结果缺 text 时
         会用全部 segments 拼接补上，已是全量转写）；
      3. 回退拼接所有有效段（过滤空串与 <|nospeech|> 占位）。
    绝不能只取首段——那会让多段语音只保留第一段文本，导致 AI 严重丢信息。
    """
    text = result.get("asr_text", "") or result.get("text", "") or ""
    if text:
        return text
    seg_texts = [
        s.get("text", "").strip()
        for s in result.get("segments", [])
        if s.get("text", "").strip() and "<|nospeech|>" not in str(s.get("text", ""))
    ]
    return " ".join(seg_texts)


def voice_summary(segments, audio_events, scene, audio_path, ts_val, asr_text, duration,
                  start_epoch_ms: int | None = None):
    """构建优化后的语音条目（支持 VAD 多段）。

    传入 start_epoch_ms 时，条目 t 使用其推算的真实时刻；否则沿用 ts_val。
    """
    if start_epoch_ms is not None:
        _t_val = datetime.fromtimestamp(start_epoch_ms / 1000.0, tz=_CST).strftime("%H:%M:%S")
    else:
        _t_val = ts_val
    if not segments:
        return {"type": "voice", "t": _t_val, "dur": 0, "tag": "other", "text": "", "audio": audio_path or ""}

    # === 计算所有值 ===
    dur = round(duration or max(s.get("end", 0) for s in segments), 0)

    # 场景标签
    if isinstance(scene, dict):
        # scene_primary 允许为 None(内核 facts 音频过短/无主场景) -> or {} 防御
        primary = scene.get("scene_primary") or {}
        scene_label = primary.get("label_cn", "") or primary.get("label", "")
    elif isinstance(scene, str):
        scene_label = scene
    else:
        scene_label = ""

    # 顶层 ASR 总文本（优先用 asr_text，否则拼接所有段）
    top_text = ""
    if asr_text and "<|nospeech|>" not in str(asr_text):
        top_text = asr_text[:1000]
    else:
        combined = " ".join(s.get("text", "").strip() for s in segments if s.get("text", "").strip() and "<|nospeech|>" not in str(s.get("text", "")))
        if combined:
            top_text = combined[:1000]

    # 环境音（top-5）: 对象数组 {label, prob, start}，对齐内核 schema。
    # prob 允许为 None（下游 fact_extractor 兜底 0.5）；start 单位秒（AED 事件起点）。
    env_val = None
    if audio_events:
        env_items = [
            {"label": e.get("label_cn") or e.get("label", ""), "prob": e.get("probability"), "start": e.get("start", 0)}
            for e in audio_events[:5]
            if e.get("label_cn") or e.get("label")
        ]
        if env_items:
            env_val = env_items

    # 遍历所有 VAD 段，构建 segs 数组
    seg_entries = []
    all_window_scores = []  # 用于计算整体 tag

    for seg in segments:
        text = seg.get("text", "").strip()
        if not text or "<|nospeech|>" in str(text):
            continue

        se = {
            "start": round(float(seg.get("start", 0)), 1),
            "end": round(float(seg.get("end", 0)), 1),
            "text": text[:500],
        }

        # 声纹块（每段独立）
        windows = seg.get("voiceprint_windows", [])
        sim = seg.get("voiceprint_sim")

        if windows and sim is not None:
            scores = [w["score"] for w in windows]
            total = len(scores)
            pct = sum(1 for s in scores if s > 0.0) / total if total > 0 else 0

            # 压缩滑窗为扁平数组 [t_ms, score, t_ms, score, ...]
            ws_flat = []
            for w in windows:
                ws_flat.append(round(w["start_ms"]))
                ws_flat.append(round(w["score"], 4))

            se["vp"] = {
                "spk": seg.get("voiceprint_speaker", ""),
                "sim": round(float(sim), 4),
                # max/pct 窗分聚合与旧公式逐位一致(B2 滑窗改单请求后 windows
                # 由内核 facts.windows 重建, 值语义不变)。B2 同时根治
                # "整段打分成功但逐窗请求失败 -> vp 缺 ws/max/pct ->
                # fact_extractor 标未校验" 的历史问题: 单请求原子产出五键。
                "max": round(max(scores), 4) if scores else 0,
                "pct": round(pct, 4),
                "ws": ws_flat,
                "ws_spk": [w.get("speaker", "") for w in windows],
            }
            # 字级声纹分值映射（逐字着色用）
            # 优先: ASR 逐字时间戳(word_ts, 绝对ms) + 滑窗真实时间(start_ms 相对语音段起点)
            #   → 每字按其真实时刻落入的窗口取分(真实时间对齐)
            # 回退: 无 word_ts 时按字符序号均匀映射(语速均匀近似)
            tokens = _build_char_tokens(seg, text, windows)
            if tokens is not None:
                se["tokens"] = tokens
            # 透传逐字时间戳(供审计/前端精确着色): [start_ms,end_ms] 绝对文件时间
            if seg.get("word_ts"):
                se["word_ts"] = seg["word_ts"]
                if seg.get("words"):
                    se["words"] = seg["words"]
            all_window_scores.extend(scores)
        elif sim is not None:
            # 短段无窗但有序分：精简 vp + 统一 tokens
            se["vp"] = {
                "spk": seg.get("voiceprint_speaker", ""),
                "sim": round(float(sim), 4),
            }
            if text:
                se["tokens"] = [{"c": ch, "v": round(float(sim), 4)} for ch in text]

        # 说话人身份结论（registered/unknown/env/mixed）
        # B2: /v1/unknown/track 产出的段级身份直通(_apply_track_blocks 写入)——
        # 内核 track 已按生产 tagging 阈值归类, 外层不二次判定、不本地建档。
        # 无 track 块(未启用/失败/短语音) 时才走既有分档(业务阈值判定非算法)。
        # U7(2026-10-08): 原陌生人档 pending/confirmed 溯源分支整删——
        # 对应段键全仓零写方(本地建档链已随 B5 退役, 外层从不写), 恒不可达。
        _trk = seg.get("voiceprint_track_spk")
        if _trk:
            se["spk"] = _trk
        else:
            _spk_name = seg.get("voiceprint_speaker", "")
            _sim = float(seg.get("voiceprint_sim") or sim or 0)
            if _spk_name and _sim >= _TAG_REGISTERED_SIM:
                se["spk"] = {
                    "id": _spk_name,
                    "kind": "registered",
                    "name": _spk_name,
                    "unk_id": None,
                    "ref_sim": round(_sim, 4),
                    "count": None,
                    "is_new": False,
                }
            elif _sim >= _TAG_MIXED_SIM:
                se["spk"] = {
                    "id": "mixed",
                    "kind": "mixed",
                    "name": None,
                    "unk_id": None,
                    "ref_sim": round(_sim, 4),
                    "count": None,
                    "is_new": False,
                }
            else:
                se["spk"] = {
                    "id": "env",
                    "kind": "env",
                    "name": None,
                    "unk_id": None,
                    "ref_sim": round(_sim, 4),
                    "count": None,
                    "is_new": False,
                }

        seg_entries.append(se)

    # 整体场景标签（基于所有段的滑动窗口聚合）
    if all_window_scores:
        overall_pct = sum(1 for s in all_window_scores if s > 0.0) / len(all_window_scores)
        if overall_pct >= _TAG_SELF_PCT:
            tag_val = "self"
        elif overall_pct >= _TAG_MIXED_PCT:
            tag_val = "mixed"
        else:
            tag_val = "other"
    else:
        tag_val = "other"

    # 无有效语音段时的兼容
    if not seg_entries:
        top_text = ""

    # 声学特征（所有段平均）
    ac_val = None
    avg_dbs = [s.get("avg_db", 0) for s in segments if s.get("avg_db", 0) != 0]
    speech_pcts = [(s.get("voice_ratio", 0) or s.get("speech_prob", 0)) for s in segments]
    if avg_dbs or any(speech_pcts):
        ac_val = {
            "db": round(float(sum(avg_dbs) / len(avg_dbs)), 1) if avg_dbs else 0,
            "spk": round(float(sum(speech_pcts) / len(speech_pcts)) * 100, 1) if speech_pcts else 0,
        }

    # === 按目标顺序组装最终 dict ===
    result = {
        "type": "voice",
        "t": _t_val,
        "dur": dur,
        "tag": tag_val,
        "text": top_text,
        "audio": audio_path or "",
    }
    if scene_label:
        result["scene"] = scene_label
    if seg_entries:
        result["segs"] = seg_entries
    if ac_val:
        result["ac"] = ac_val
    if env_val:
        result["env"] = env_val
    return result


def _ensure_wav(path: str):
    """确保有可分析的 WAV，返回可分析路径。

    - 已是有效 WAV: 返回原路径（字节不变）;
    - 非 WAV（FLAC/AAC 等）: ffmpeg 转码到旁路 ``{stem}.analysis.wav``
      并返回旁路路径，**原文件字节保持不变**（严禁 os.replace 就地覆盖，
      否则原件内容被毁——B 类高危）;
    - 无法转换（无 ffmpeg / 转码失败）: 返回 None，原文件不动。

    旁路文件复用: 已存在且为有效 WAV 时直接返回，避免重复转码。

    Returns:
        str | None: 可分析的 WAV 路径；失败返回 None。
    """
    import wave
    import os
    import subprocess

    try:
        with wave.open(path, "rb") as wf:
            wf.readframes(1)
            return path  # 已经是有效 WAV
    except wave.Error:
        pass  # 非 WAV，需要转换
    except Exception:
        pass

    # 旁路文件名: {stem}.analysis.wav（与原件同目录）
    stem, _ext = os.path.splitext(path)
    wav_path = stem + ".analysis.wav"

    # 旁路已存在且有效 -> 直接复用（避免重复转码）
    if wav_path != path:
        try:
            with wave.open(wav_path, "rb") as wf:
                wf.readframes(1)
                return wav_path
        except Exception:
            pass  # 不存在或损坏，重新转码

    logger.info(f"[AudioAnalysis] 检测到非 WAV 格式 ({os.path.basename(path)})，正在转码到旁路...")

    # 尝试用 ffmpeg 转码
    # Linux 迁移(2026-10-07)：win32 保留 bin/ffmpeg.exe 优先；其余平台用 PATH ffmpeg
    if sys.platform != "win32":
        ffmpeg_paths = ["ffmpeg"]
    else:
        ffmpeg_paths = [
            os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "ffmpeg.exe"),
            "ffmpeg", "ffmpeg.exe",
        ]
    ffmpeg_cmd = None
    for fp in ffmpeg_paths:
        if fp in ("ffmpeg", "ffmpeg.exe") or os.path.exists(fp):
            ffmpeg_cmd = fp
            break

    if ffmpeg_cmd is None:
        logger.warning("[AudioAnalysis] ffmpeg 未找到，无法转换音频格式")
        return None

    try:
        subprocess.run(
            [ffmpeg_cmd, "-y", "-i", path, "-ar", "16000", "-ac", "1", wav_path],
            capture_output=True, timeout=60
        )
        if os.path.exists(wav_path) and os.path.getsize(wav_path) > 1000:
            # 旁路落盘成功: 返回旁路路径，原文件字节不变（不 os.replace）
            logger.info(f"[AudioAnalysis] 转码成功: {os.path.basename(path)} -> {os.path.basename(wav_path)}")
            return wav_path
    except FileNotFoundError:
        logger.warning(f"[AudioAnalysis] ffmpeg 未找到 ({ffmpeg_cmd})，无法转换音频格式")
    except subprocess.TimeoutExpired:
        logger.warning("[AudioAnalysis] ffmpeg 转换超时")
    except Exception as e:
        logger.warning(f"[AudioAnalysis] 转换失败: {e}")

    # 失败: 清理半成品旁路，原文件不动
    if os.path.exists(wav_path):
        try:
            os.remove(wav_path)
        except OSError:
            pass

    return None
