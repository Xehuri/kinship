# -*- coding: utf-8 -*-
"""
综合音频分析测试脚本:
  Step 1: 加载模型
  Step 2: VAD + ASR + PANNs + Emotion 全分析 (对多个测试音频)
  Step 3: 声纹识别 (Voiceprint)
  Step 4: 增量数据生成 (perception.jsonl)
  Step 5: 结果汇总

用法:
    cd backend && python ../scripts/test_all_audio.py
"""

import sys, os, json, time
from datetime import datetime, timezone, timedelta

# 添加 backend 到 sys.path 以引用 services
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJ = os.path.normpath(os.path.join(_HERE, '..'))
_BACKEND = os.path.join(_PROJ, 'backend')
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
os.environ['CI'] = 'true'

_CST = timezone(timedelta(hours=8))
_log = []

def log(msg: str):
    _log.append(msg)
    print(msg)

def log_json(label: str, data, max_len: int = 300):
    try:
        s = json.dumps(data, ensure_ascii=False, indent=2)
        if len(s) > max_len:
            s = s[:max_len] + f"\n  ... (truncated, total {len(s)} chars)"
        log(f"  {label}: {s}")
    except Exception as e:
        log(f"  {label}: <serialize error: {e}>")

def main():
    t_start = time.time()

    # ── 导入服务 ──────────────────────────────────────
    log("[Step 0] 导入服务模块...")
    from services.multimodal_audio_manager import get_multimodal_audio_manager
    from services.voiceprint_service import get_voiceprint_service
    from services.perception_store import append_perception
    from config.config import get_config

    mgr = get_multimodal_audio_manager()
    vp = get_voiceprint_service()
    cfg = get_config()

    log(f"  DATA_DIR = {cfg.DATA_DIR}")
    log(f"  VOICEPRINTS_PATH = {cfg.VOICEPRINTS_PATH}")
    log(f"  注册声纹数: {vp.get_speaker_count()}")
    if vp.get_speaker_count() > 0:
        for spk in vp.list_speakers():
            log(f"    说话人: {spk['name']} (ID: {spk['speaker_id']})")

    # ── 加载模型 ──────────────────────────────────────
    log("\n[Step 1] 加载多模态音频模型...")
    t0 = time.time()
    mgr.load_models()
    log(f"  模型加载耗时: {time.time()-t0:.1f}s")

    # ── 测试音频扫描 ───────────────────────────────────
    test_dir = os.path.join(_PROJ, "tmp_test")
    if not os.path.isdir(test_dir):
        log(f"  ERROR: 测试目录不存在: {test_dir}")
        sys.exit(1)

    all_wavs = sorted([f for f in os.listdir(test_dir) if f.endswith('.wav')])
    log(f"\n  测试目录: {test_dir}")
    log(f"  共发现 {len(all_wavs)} 个 WAV 文件")

    # 选取前3个用于全分析, 再选2个(不同时长)用于声纹
    test_files = all_wavs[:5]
    log(f"  选取前 {len(test_files)} 个进行测试\n")

    # ── Step 2: 全分析 (VAD + ASR + PANNs + Emotion) ──
    log("=" * 60)
    log("[Step 2] 全分析: VAD + ASR + PANNs + Emotion + SpeakerDiarizer")
    log("=" * 60)

    analysis_results = []
    for i, fname in enumerate(test_files):
        fpath = os.path.join(test_dir, fname)
        size_kb = os.path.getsize(fpath) // 1024
        log(f"\n--- Test {i+1}: {fname} ({size_kb}KB) ---")

        result = mgr.analyze(fpath)
        analysis_results.append((fname, result))

        # 显示关键字段
        if not result.get("success"):
            log(f"  ERROR: {result.get('error', 'unknown')}")
            continue

        dur = result.get("duration_str", "?")
        log(f"  时长: {dur}")

        # VAD 分段
        segs = result.get("segments", [])
        log(f"  VAD 分段数: {len(segs)}")

        # ASR 文本
        texts = [s.get("text", "") for s in segs if s.get("text")]
        asr_text = "".join(texts)
        log(f"  ASR 文本: {asr_text[:200] if asr_text else '(空)'}")

        # 场景
        scene = result.get("scene")
        if scene:
            log_json("场景 (scene)", scene)

        # 音频事件
        events = result.get("audio_events")
        if events:
            log_json("音频事件 (audio_events)", events[:5])

        # 情绪
        emotion = result.get("emotion_summary") or result.get("emotion")
        if emotion:
            log_json("情绪摘要 (emotion_summary)", emotion)

        dominant = result.get("dominant_emotion")
        if dominant:
            log(f"  主导情绪: {dominant} ({result.get('dominant_emotion_cn', '')})")

        silent = result.get("silent")
        if silent is not None:
            log(f"  静音标记: {silent}")

    # ── Step 3: 声纹识别 ──────────────────────────────
    log("\n" + "=" * 60)
    log("[Step 3] 声纹识别")
    log("=" * 60)

    # 先尝试用 voiceprints.json 做声纹识别
    if vp.get_speaker_count() > 0:
        for i, (fname, result) in enumerate(analysis_results):
            fpath = os.path.join(test_dir, fname)
            log(f"\n--- Speaker ID on {fname} ---")
            spk_result = vp.identify(fpath, top_k=3)
            if spk_result:
                for r in spk_result:
                    log(f"  说话人: {r['name']} (相似度: {r['similarity']:.4f})")
            else:
                log(f"  未识别到匹配说话人")
                # 打印 top scores
                scores = vp.score_all(fpath)
                if scores:
                    log_json("  top scores (no threshold)", scores, 200)
    else:
        log("  声纹库为空, 跳过声纹识别测试")

    # ── Step 4: 增量数据生成 ──────────────────────────
    log("\n" + "=" * 60)
    log("[Step 4] 增量数据生成 (perception.jsonl / health.json)")
    log("=" * 60)

    # 4a: 写入 perception.jsonl
    log("\n--- 写入 perception.jsonl ---")
    for i, (fname, result) in enumerate(analysis_results[:3]):
        if not result.get("success"):
            continue
        texts = [s.get("text", "") for s in result.get("segments", []) if s.get("text")]
        asr_text = "".join(texts)
        scene = result.get("scene", {})
        scene_label = ""
        if isinstance(scene, dict):
            scene_label = scene.get("top_label", scene.get("label", ""))
        event = {
            "type": "voice",
            "time": datetime.now(_CST).isoformat(),
            "audio_file": fname,
            "asr_text": asr_text or "(静音/无声)",
            "scene": scene_label or "未知",
            "speaker_count": len(result.get("segments", [])),
            "confidence": 0.85,
            "source": "audio_test_script",
        }
        ok = append_perception(event)
        log(f"  [{i+1}] {fname}: {'OK' if ok else 'FAIL'} — event type=voice text={asr_text[:50] or '(空)'}")

    # 4b: 写入 health.json (如果目录支持)
    log("\n--- 检查 health.json 写入 ---")
    try:
        from services.health_storage import save_health_data
        today = datetime.now(_CST).strftime("%Y-%m-%d")
        health_entry = {
            "date": today,
            "time": datetime.now(_CST).strftime("%H:%M:%S"),
            "heart_rate": 72,
            "spo2": 98,
            "stress": 35,
            "steps": 4521,
            "source": "audio_test_script",
        }
        ok = save_health_data(health_entry)
        log(f"  health.json: {'OK' if ok else 'FAIL'}")
    except ImportError:
        log("  health_storage not available, skip")
    except Exception as e:
        log(f"  health.json write error: {e}")

    # 4c: 验证文件存在
    log("\n--- 验证生成的文件 ---")
    today = datetime.now(_CST).strftime("%Y-%m-%d")
    data_dir = cfg.DATA_DIR
    pfile = os.path.join(data_dir, today, "perception.jsonl")
    hfile = os.path.join(data_dir, today, "health.json")
    for label, fp in [("perception.jsonl", pfile), ("health.json", hfile)]:
        if os.path.exists(fp):
            with open(fp, "r", encoding="utf-8") as f:
                content = f.read()
            log(f"  {label} ({os.path.getsize(fp)} bytes):")
            lines = content.strip().split("\n")
            for li, line in enumerate(lines[-5:], max(1, len(lines)-4)):
                preview = line[:120] + "..." if len(line) > 120 else line
                log(f"    line {li}: {preview}")
        else:
            log(f"  {label}: 文件不存在")

    # ── 结论 ──────────────────────────────────────────
    total_time = time.time() - t_start
    log("\n" + "=" * 60)
    log(f"[完成] 全部测试耗时 {total_time:.1f}s")
    log("=" * 60)

    # 汇总
    success_count = sum(1 for _, r in analysis_results if r.get("success"))
    log(f"  全分析成功率: {success_count}/{len(analysis_results)}")
    log(f"  ASR 有文本数: {sum(1 for _, r in analysis_results if any(s.get('text') for s in r.get('segments', [])))}/{len(analysis_results)}")
    log(f"  Speaker ID 测试: {'PASS' if vp.get_speaker_count() > 0 else 'SKIP (no enrollment)'}")
    log(f"  Perception JSONL: {'PASS' if os.path.exists(pfile) else 'FAIL'}")

if __name__ == "__main__":
    main()
