# -*- coding: utf-8 -*-
"""从每天 perception.jsonl 已标注语音段重建 cohort（经内核逐段采集）。

核心思路(用户指定): 不用 audit(旧数据78%负sim是垃圾), 也不用全文件扫描,
而是从每天的感知 json 里拿样本 —— perception.jsonl 的 voice 段已含
ASR文本(start/end偏移/vp.sim), 筛出真实人声段, 从 wav 精确切出音频,
逐段送内核评分并采集进 cohort。

筛选条件(外层预筛, 省内核调用; 三门/去重/日限在内核内还会再过一遍):
  - 有 ASR 文本(非 nospeech/非空) → 真实语音, 排除白噪
  - 段长 >= 2s (MIN_DUR_SEC, 与内核时长下限门同值)
  - vp.sim < 0.25 (与注册质心不太像 → 非用户, 供 AS-Norm 当冒名者)

用法: python backend/scripts/rebuild_cohort_from_perception.py [目标条数]
        [--days D1,D2,...] [--data-root PATH] [--dry-run]

B4 迁移(2026-09-24):
  - 不再 import voiceprint_service / 本地模型；逐段经 services.kernel_client
    POST /v1/voiceprint/score {audio_b64, collect:true, collect_meta} ——
    每段一次整段采集，与旧外层逐段 score_all_v2 数学等价（门在内核内）。
  - 采集落内核 state-dir（唯一真相源）；不再读写外层 buffer/audit 文件，
    原"刷盘"步骤随 CohortManager 一并移除（内核 write-through 即时落盘）。
"""
import argparse
import base64
import io
import json
import os
import sys
import time
import wave

_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(_BACKEND)
sys.path.insert(0, _BACKEND)

import numpy as np  # noqa: E402

from services import kernel_client, perception_reader  # noqa: E402


def _default_data_root() -> str:
    env = os.environ.get("AXEUH_AI_ROOT", "").strip()
    if env:
        return os.path.join(os.path.abspath(os.path.expanduser(env)), "data")
    try:
        from config.config import get_config

        return os.path.join(get_config().AI_ROOT, "data")
    except Exception:
        return os.path.join(os.path.dirname(_BACKEND), "ai", "data")


DEFAULT_DAYS = ["2026-09-03", "2026-09-04", "2026-09-05"]
SIM_THRESHOLD = 0.25
MIN_DUR = 2.0
KERNEL_FS = 16000  # 内核 score 输入硬约束: 16k/mono/16bit WAV


def _encode_wav16(audio: np.ndarray, sample_rate: int) -> bytes:
    """float 音频 -> 16bit PCM 单声道 WAV 字节（内核 audio_b64 输入契约）。"""
    pcm = np.clip(np.asarray(audio, dtype=np.float64), -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def score_segment(client, chunk: np.ndarray, src_file: str, src_t: str,
                  src_start: float, src_end: float) -> dict:
    """逐段送内核评分+采集，返回 facts（含 collected/collect_reason）。"""
    body = {
        "audio_b64": base64.b64encode(_encode_wav16(chunk, KERNEL_FS)).decode("ascii"),
        "collect": True,
        "collect_meta": {
            "src_file": src_file,
            "src_t": src_t,
            "src_start": float(src_start),
            "src_end": float(src_end),
        },
    }
    result = client.srequest(
        "POST", "/v1/voiceprint/score", json=body,
        timeout=kernel_client.HEAVY_TIMEOUT,
    )
    facts = (result or {}).get("facts") if isinstance(result, dict) else None
    return facts if isinstance(facts, dict) else {}


def audit_total(client) -> int:
    """经内核 cohort/audit 端点取审计总数（limit=1 只拿计数）。"""
    result = client.srequest(
        "GET", "/v1/voiceprint/cohort/audit?offset=0&limit=1",
        timeout=15.0,
    )
    facts = (result or {}).get("facts") if isinstance(result, dict) else None
    return int((facts or {}).get("total") or 0)


def collect_candidates(data_root: str, days) -> list:
    """从每天的 perception.jsonl 筛候选语音段。"""
    cands = []
    for day in days:
        if not perception_reader.has_perception(day, data_root=data_root):
            print(f"  跳过 {day}: 无 perception.jsonl")
            continue
        for d in perception_reader.read_day(day, types=("voice",), data_root=data_root):
            audio_rel = d.get("audio", "")  # daily/2026-09-05/audio/xxx.wav
            if not audio_rel:
                continue
            # 兼容 T5 后双后缀（.wav/.flac）；内核只收 16k WAV，flac 原件跳过
            if not audio_rel.lower().endswith(".wav"):
                continue
            # audio_rel 形如 daily/{date}/audio/xxx.wav, 相对数据根解析
            wav = os.path.join(data_root, audio_rel)
            if not os.path.isfile(wav):
                continue
            # 日期从 wav 相对路径取 (daily/YYYY-MM-DD/audio/xxx.wav)
            seg_day = audio_rel.split("daily/")[-1].split("/")[0]
            base = os.path.basename(wav).split("_")[0]
            ts_val = f"{seg_day}T{base[0:2]}:{base[2:4]}:{base[4:6]}"
            for s in (d.get("segs") or []):
                txt = s.get("text", "")
                if not txt or "<|nospeech|>" in txt:
                    continue
                txt = txt.strip().strip("。.，, ")
                if len(txt) < 1:
                    continue
                start = float(s.get("start", 0))
                end = float(s.get("end", 0))
                dur = end - start
                if dur < MIN_DUR:
                    continue
                vp = s.get("vp") or {}
                sim = vp.get("sim")
                if sim is None or sim >= SIM_THRESHOLD:
                    continue
                cands.append({
                    "wav": wav, "start": start, "end": end, "dur": dur,
                    "ts": ts_val, "text": txt[:30], "sim": sim,
                })
    return cands


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="从 perception 已标注语音段经内核补采 cohort")
    p.add_argument("target", nargs="?", type=int, default=3000,
                   help="目标采集条数(默认 3000)")
    p.add_argument("--days", default=",".join(DEFAULT_DAYS),
                   help="逗号分隔日期列表")
    p.add_argument("--data-root", default=_default_data_root(),
                   help="数据根(默认 <AI_ROOT>/data，可用 --data-root 或 AXEUH_AI_ROOT 覆盖)")
    p.add_argument("--dry-run", action="store_true",
                   help="只筛候选计数不过内核")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    days = [d.strip() for d in args.days.split(",") if d.strip()]
    t0 = time.time()
    client = kernel_client.get_kernel_client()
    if not args.dry_run and not client.available():
        print("内核不可达，终止（不降级到本地模型）")
        return

    print("收集候选段...", flush=True)
    cands = collect_candidates(args.data_root, days)
    print(f"候选段: {len(cands)} 条 ({days[0]}~{days[-1]}, 有文本+sim<{SIM_THRESHOLD}+dur>={MIN_DUR}s)",
          flush=True)
    if args.dry_run:
        print(f"dry-run: 候选 {len(cands)} 条，未调用内核。耗时 {time.time()-t0:.0f}s", flush=True)
        return

    start_audit = audit_total(client)
    collected = 0
    for i, c in enumerate(cands):
        if collected >= args.target:
            print(f"已达目标 {args.target}, 停止", flush=True)
            break
        try:
            import soundfile as sf
            audio, fs = sf.read(c["wav"], dtype="float32")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if int(fs) != KERNEL_FS:
                continue  # 内核只收 16k WAV（生产恒 16k，非标跳过）
            s0 = int(c["start"] * fs)
            s1 = min(int(c["end"] * fs), len(audio))
            if s1 - s0 < int(MIN_DUR * fs):
                continue
            chunk = audio[s0:s1]
            try:
                facts = score_segment(
                    client, chunk,
                    os.path.basename(c["wav"]), c["ts"],
                    c["start"], c["end"],
                )
                if facts.get("collected"):
                    collected += 1
            except kernel_client.KernelUnavailable as e:
                print(f"内核不可达，中止: {e}", flush=True)
                break
            except kernel_client.KernelHttpError:
                pass  # 单段内核错误尽力而为跳过(旧 except 同款)
        except Exception:
            pass
        if (i + 1) % 200 == 0:
            print(f"  处理 {i+1}/{len(cands)} | collected={collected} | {time.time()-t0:.0f}s",
                  flush=True)

    end_audit = audit_total(client)
    print(f"\n完成: 处理 {len(cands)} 候选 | audit {start_audit}→{end_audit} "
          f"(+{end_audit - start_audit}) | 采集 {collected} 条 | "
          f"耗时 {time.time()-t0:.0f}s", flush=True)
    print("提示: 采集已写内核 state-dir cohort_audit/active；压缩触发: "
          "POST /api/admin/cohort/compact", flush=True)


if __name__ == "__main__":
    main()
