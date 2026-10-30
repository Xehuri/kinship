# -*- coding: utf-8 -*-
"""离线补采 cohort：遍历近期感知音频，逐窗经内核 POST /v1/voiceprint/score 采集。

用法:
    python backend/scripts/rebuild_cohort.py [目标条数] [--days D1,D2,...]
        [--limit N] [--data-root PATH] [--dry-run]

    默认: 近3天(9/3-9/5), 目标采满 2000 条后停止扫描(留给 compact 选 500)

B4 迁移(2026-09-24):
    - 不再 import voiceprint_service / 不再本地加载模型；一切评分+采集经
      services.kernel_client 走内核 POST /v1/voiceprint/score
      (collect=true + collect_meta 溯源)。三门(时长/相似度/RMS) + 去重 +
      每日限流全在内核内执行，与外层旧 score_all_v2 采集语义逐门对齐。
    - 采集落内核 state-dir 的 cohort_audit/active（唯一真相源）；
      ai/data/cache/cohort_*.jsonl 为历史归档，本脚本不再读写。
    - 逐窗请求 = 每窗一次整段采集，与外层逐窗 score_all_v2 数学等价
      （窗 2.0s 恰好过时长下限门；短于 2s 内核同样拒——门在内核内）。

选项:
    --days      逗号分隔日期列表(默认 2026-09-03,2026-09-04,2026-09-05)
    --limit     每文件最多试采窗口数(默认 8，控制运行时间)
    --data-root 数据根(默认 <AI_ROOT>/data，测试可注入临时目录)
    --dry-run   只扫描窗口不过内核(自测预筛行为，不写入任何数据)
"""
import argparse
import base64
import glob
import io
import os
import sys
import time
import wave

# 脚本在 backend/scripts/ 下: backend 为工作根, services 包在其中
_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(_BACKEND)  # backend/ 为 cwd → services/xxx 可导入
sys.path.insert(0, _BACKEND)

import numpy as np  # noqa: E402

from services import kernel_client  # noqa: E402


def _default_data_root() -> str:
    env = os.environ.get("AXEUH_AI_ROOT", "").strip()
    if env:
        return os.path.join(os.path.abspath(os.path.expanduser(env)), "data")
    try:
        from config.config import get_config

        return os.path.join(get_config().AI_ROOT, "data")
    except Exception:
        return os.path.join(os.path.dirname(_BACKEND), "ai", "data")


# 滑窗参数(与旧实现一致): 2s 窗 / 1s 步进, RMS 预筛门 0.008
WIN_SEC = 2.0
HOP_SEC = 1.0
RMS_PRE_FILTER = 0.008
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


def score_window(client, chunk: np.ndarray, src_file: str, src_t: str,
                 src_start: float, src_end: float) -> dict:
    """逐窗送内核评分+采集，返回 facts（含 collected/collect_reason）。"""
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


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="逐窗经内核补采 cohort")
    p.add_argument("target", nargs="?", type=int, default=2000,
                   help="目标采集条数(默认 2000)")
    p.add_argument("--days", default="2026-09-03,2026-09-04,2026-09-05",
                   help="逗号分隔日期列表")
    p.add_argument("--limit", type=int, default=8,
                   help="每文件最多试采窗口数(默认 8)")
    p.add_argument("--data-root", default=_default_data_root(),
                   help="数据根(默认 <AI_ROOT>/data，可用 --data-root 或 AXEUH_AI_ROOT 覆盖)")
    p.add_argument("--dry-run", action="store_true",
                   help="只扫描计数不过内核")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    days = [d.strip() for d in args.days.split(",") if d.strip()]
    start_ts = time.time()

    client = kernel_client.get_kernel_client()
    if not args.dry_run:
        # 探活(首次可能触发 spawn/握手, 模型懒加载在首个 score 上)
        if not client.available():
            print("内核不可达，终止（不降级到本地模型）")
            return

    wavs = []
    for day in days:
        wavs.extend(sorted(glob.glob(
            os.path.join(args.data_root, "daily", day, "audio", "*.wav"))))
    print(f"待扫描音频: {len(wavs)} 个 ({days[0]}~{days[-1]})", flush=True)

    try:
        start_audit = audit_total(client) if not args.dry_run else 0
    except Exception as e:
        print(f"audit 计数获取失败(继续, 仅进度显示缺): {e}", flush=True)
        start_audit = 0
    print(f"初始 audit: {start_audit} 条", flush=True)

    scanned = 0
    tried = 0
    collected = 0
    for wav in wavs:
        if collected >= args.target:
            print(f"已达采集目标 {args.target}，停止扫描", flush=True)
            break
        scanned += 1
        try:
            import soundfile as sf
            audio, fs = sf.read(wav, dtype="float32")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if int(fs) != KERNEL_FS:
                continue  # 内核只收 16k WAV；非标文件跳过（生产恒 16k）
            # 文件名 → ts (HHMMSS)
            base = os.path.basename(wav).split("_")[0]
            ts_val = f"{base[0:2]}:{base[2:4]}:{base[4:6]}"

            win = int(fs * WIN_SEC)
            hop = int(fs * HOP_SEC)
            n_windows_tried = 0
            for s in range(0, len(audio) - win + 1, hop):
                if n_windows_tried >= args.limit:  # 每文件最多试 N 窗, 控制时间
                    break
                chunk = audio[s: s + win]
                rms = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
                if rms < RMS_PRE_FILTER:  # 能量门预筛(省请求; 内核同款门仍兜底)
                    continue
                n_windows_tried += 1
                tried += 1
                if args.dry_run:
                    continue
                # 三门/去重/日限全在内核内: 窗<2s 内核同样拒——与外层逐窗等价
                try:
                    facts = score_window(
                        client, chunk,
                        os.path.basename(wav), ts_val,
                        s / fs, (s + win) / fs,
                    )
                    if facts.get("collected"):
                        collected += 1
                except kernel_client.KernelUnavailable as e:
                    print(f"内核不可达，中止: {e}", flush=True)
                    return
                except kernel_client.KernelHttpError:
                    pass  # 单窗内核错误(如模型缺失)尽力而为跳过, 对齐旧 except 语义
            # 每 50 文件刷一次进度
            if scanned % 50 == 0:
                now = audit_total(client) if not args.dry_run else -1
                delta = f"audit={now} (+{now - start_audit})" if now >= 0 else "dry-run"
                print(
                    f"  扫描 {scanned}/{len(wavs)} | {delta} "
                    f"| collected={collected} | {time.time()-start_ts:.0f}s",
                    flush=True,
                )
        except Exception:
            pass

    end_audit = audit_total(client) if not args.dry_run else start_audit
    print(f"\n完成: 扫描 {scanned} 文件 | 试采 {tried} 窗 | 采集 {collected} 条 "
          f"| audit {start_audit} → {end_audit} "
          f"(+{end_audit - start_audit})", flush=True)
    print(f"耗时 {time.time()-start_ts:.0f}s", flush=True)
    if not args.dry_run:
        print("提示: 采集已写内核 state-dir cohort_audit/active；压缩触发: "
              "POST /api/admin/cohort/compact", flush=True)


if __name__ == "__main__":
    main()
