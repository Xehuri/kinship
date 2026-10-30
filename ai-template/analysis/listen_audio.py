#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
listen_audio.py — AI 音频内容理解工具（供 agent 审计音频）

用途：快速判断任意音频里"是什么"——说话人/媒体/环境/内容。
基于 MiMo 多模态 API，复用项目安全链路：
    复制到 cache/mimo_audio/ → 后端 /api/mimo/audio/{fn} 签名暴露 → MiMo 拉取 → 清理

与 audio_mimo_analyzer.py 的区别：
    - 面向 agent 程序化调用：analyze_file() 直接返回 dict
    - 支持任意文件路径（不限于 daily/日期）
    - 简洁输出，专注"这段音频里是什么"四要素
    - 支持并发批量

用法（CLI）:
    python listen_audio.py <音频路径> [更多路径...]
    python listen_audio.py --json <路径>            # JSON 输出
    python listen_audio.py --batch paths.txt        # 文件列表
    python listen_audio.py --question "这段里是几个人在对话?" <路径>

配置（环境变量）:
    MIMO_API_BASE       MiMo API 基址，默认 https://token-plan-cn.xiaomimimo.com/v1
    MIMO_MODEL          模型名，默认 mimo-v2.6-flash
    MIMO_PUBLIC_BASE    后端公网基础 URL（必填），如 https://your-domain:8768
    MIMO_API_KEY        可选；缺省读后端配置 config.yaml
    AXEUH_BACKEND_DIR   可选；后端目录，缺省为 {项目根目录}/backend

程序化:
    from listen_audio import analyze_file
    r = analyze_file("data/audio/sample.wav", question="...")
    print(r["text"])   # 分析文本
"""
import argparse
import os
import sys
import json
import uuid
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
AI_ROOT = os.path.normpath(os.path.join(SCRIPT_DIR, ".."))
PROJECT_ROOT = os.path.normpath(os.path.join(AI_ROOT, ".."))
BACKEND_DIR = os.environ.get("AXEUH_BACKEND_DIR") or os.path.join(PROJECT_ROOT, "backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from config.config import get_config
# 后端短 TTL 签名 URL 工具：MiMo 音频端点使用签名校验，不再免认证裸文件名
from mimo_signing import build_signed_path

MIMO_API_BASE = os.environ.get(
    "MIMO_API_BASE", "https://token-plan-cn.xiaomimimo.com/v1"
).rstrip("/")
MIMO_MODEL = os.environ.get("MIMO_MODEL", "mimo-v2.6-flash")
MIMO_MAX_TOKENS = int(os.environ.get("MIMO_MAX_TOKENS", "3000"))
MIMO_TIMEOUT = int(os.environ.get("MIMO_TIMEOUT", "180"))
MIMO_RETRIES = int(os.environ.get("MIMO_RETRIES", "2"))
RETRY_BACKOFF = [5, 20]

# 后端对外基址：用于把临时音频暴露给 MiMo 拉取（需公网可访问）。
# 通过环境变量 MIMO_PUBLIC_BASE 配置；未配置时 analyze_file() 返回明确错误。
PUBLIC_BASE = os.environ.get("MIMO_PUBLIC_BASE", "{公网基础URL}").rstrip("/")


def _resolve_binary(name):
    """ffmpeg 跨平台解析：Windows 优先 backend/bin，其他平台用 PATH。"""
    if os.name == "nt":
        candidate = os.path.join(BACKEND_DIR, "bin", name + ".exe")
        return candidate if os.path.isfile(candidate) else name
    return shutil.which(name) or name


FFMPEG = _resolve_binary("ffmpeg")

_SYSTEM_PROMPT = (
    "你是一个专业的音频分析助手。请基于音频内容客观回答："
    "声音来源(真人说话/设备播放/环境音/混合)、有几个不同的人、各自性别音色特征、"
    "场景类型、按时间顺序的内容概括。不确定的(身份/具体内容)标注'推测'或'听不清'，绝不编造。"
)

DEFAULT_QUESTION = (
    "请分析这段音频，用简洁的中文分点回答：\n"
    "1) 声音类型：真人说话 / 设备播放(音乐/视频/语音/TTS) / 纯环境音 / 混合？\n"
    "2) 若有人声：几个人？各自性别/音色/年龄特征？\n"
    "3) 场景：卧室/办公室/户外/交通工具/公共场所？依据是什么(回声/底噪/特定响声)？\n"
    "4) 内容：听到了什么(能确定的写，听不清的标注'听不清')？\n"
    "若整段无明显人声，直接说'无明显人声'并描述环境声。回答控制在 250 字内。"
)


def _tmp_dir():
    d = os.path.join(get_config().DATA_DIR, "cache", "mimo_audio")
    os.makedirs(d, exist_ok=True)
    return d


_sweep_done = False


def _sweep_cache_once():
    """每进程只清一次缓存孤儿（写入方负责，防膨胀）：
    .md 结果永不删、2 小时内在途文件保护，失败不影响分析。"""
    global _sweep_done
    if _sweep_done:
        return
    _sweep_done = True
    try:
        from mimo_audio_sweep import sweep
        sweep(cache_dir=_tmp_dir(), verbose=False)
    except Exception:
        pass


def _api_key():
    return os.environ.get("MIMO_API_KEY") or get_config().MIMO_API_KEY


def _ensure_wav(src, tmp_root):
    """把任意音频拷成 wav(或原样)，返回 (文件名, 绝对路径)。wav 直拷，其他格式 ffmpeg 转。"""
    ext = os.path.splitext(src)[1].lower()
    if ext in (".wav", ".wave"):
        fname = uuid.uuid4().hex + ".wav"
    else:
        fname = uuid.uuid4().hex + ".mp3"
        # 先转 wav? MiMo 支持 mp3。直接转 mp3 减小体积
        out_mp3 = os.path.join(tmp_root, fname)
        try:
            subprocess.run(
                [FFMPEG, "-y", "-i", src, "-acodec", "libmp3lame",
                 "-b:a", "64k", "-ar", "16000", "-ac", "1", out_mp3],
                capture_output=True, timeout=120, check=True,
            )
        except Exception:
            # ffmpeg 失败回退原文件(若 MiMo 支持该格式)
            fname = uuid.uuid4().hex + ext
            out_mp3 = os.path.join(tmp_root, fname)
            shutil.copy2(src, out_mp3)
        return fname, out_mp3
    dst = os.path.join(tmp_root, fname)
    shutil.copy2(src, dst)
    return fname, dst


def _call_mimo(audio_url, question):
    api_key = _api_key()
    if not api_key:
        return {"error": "MIMO_API_KEY 未配置"}
    headers = {"api-key": api_key, "Content-Type": "application/json"}
    payload = {
        "model": MIMO_MODEL,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "input_audio", "input_audio": {"data": audio_url}},
                {"type": "text", "text": question},
            ]},
        ],
        "max_tokens": MIMO_MAX_TOKENS,
    }
    last_err = None
    for attempt in range(MIMO_RETRIES + 1):
        try:
            r = requests.post(
                f"{MIMO_API_BASE}/chat/completions",
                headers=headers, json=payload,
                timeout=MIMO_TIMEOUT, proxies={"http": None, "https": None},
            )
            if r.status_code == 200:
                return r.json()
            last_err = f"HTTP {r.status_code}: {r.text[:200]}"
        except Exception as e:
            last_err = str(e)
        if attempt < MIMO_RETRIES:
            time.sleep(RETRY_BACKOFF[attempt])
    return {"error": last_err}


def _extract_text(res):
    if "error" in res:
        return "[失败: %s]" % res["error"]
    try:
        choices = res.get("choices", [])
        if choices:
            msg = choices[0].get("message", {})
            return msg.get("content", "")
    except Exception:
        pass
    return "[无内容]"


def analyze_file(path, question=None, request_count=1):
    """分析单个音频文件。

    Args:
        path: 音频文件绝对路径 (wav/mp3/m4a/ogg...)
        question: 自定义问题(默认四要素)
        request_count: 重复调用次数(默认1)
    Returns:
        dict: {path, ok, text(主), attempts:[...]}
    """
    _sweep_cache_once()  # 程序化入口（批量脚本直接 import，绕过 main）也要触发清理
    if not PUBLIC_BASE or "{" in PUBLIC_BASE:
        return {"path": path, "ok": False,
                "text": "[未配置公网基础 URL：请设置环境变量 MIMO_PUBLIC_BASE"
                        "（例如 https://your-domain:8768）]", "attempts": []}
    if not os.path.isfile(path):
        return {"path": path, "ok": False, "text": f"[文件不存在: {path}]", "attempts": []}
    tmp_root = _tmp_dir()
    tmp_files = []
    try:
        fname, dst = _ensure_wav(path, tmp_root)
        tmp_files.append(dst)
        url = PUBLIC_BASE + build_signed_path(fname)
        q = question or DEFAULT_QUESTION
        attempts = []
        for _ in range(max(1, request_count)):
            attempts.append(_call_mimo(url, q))
        texts = [_extract_text(r) for r in attempts]
        return {
            "path": path,
            "ok": not any("失败" in t for t in texts),
            "text": "\n\n".join(texts),
            "attempts": texts,
            "question": q[:80],
        }
    finally:
        for f in tmp_files:
            try:
                if os.path.isfile(f):
                    os.remove(f)
            except OSError:
                pass


def analyze_batch(paths, question=None, concurrency=3, request_count=1):
    """并发分析多个音频。"""
    results = {}
    workers = max(1, min(concurrency, len(paths)))
    if workers <= 1:
        for p in paths:
            results[p] = analyze_file(p, question, request_count)
    else:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = {ex.submit(analyze_file, p, question, request_count): p for p in paths}
            for fut in futures:
                p = futures[fut]
                try:
                    results[p] = fut.result()
                except Exception as e:
                    results[p] = {"path": p, "ok": False, "text": f"[异常: {e}]", "attempts": []}
    # 按输入顺序返回
    return [results[p] for p in paths]


def main():
    _sweep_cache_once()
    parser = argparse.ArgumentParser(
        description="音频内容理解（MiMo 多模态）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("paths", nargs="*", help="音频文件路径")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--batch", help="从文件读取音频路径列表（每行一个）")
    parser.add_argument("--question", help="自定义问题")
    parser.add_argument("--concurrency", type=int, default=3, help="并发数")
    parser.add_argument("--request", dest="request_count", type=int, default=1,
                        help="每个文件的重复请求次数")
    args = parser.parse_args()

    if args.batch:
        with open(args.batch, encoding="utf-8") as f:
            paths = [ln.strip() for ln in f if ln.strip()]
    else:
        paths = args.paths

    if not paths:
        parser.print_help()
        print("\n请提供音频路径或 --batch 文件", file=sys.stderr)
        return 1

    results = analyze_batch(paths, args.question, max(1, args.concurrency),
                            max(1, args.request_count))
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print("=" * 60)
            print("文件:", r["path"])
            print(r["text"])
            print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
