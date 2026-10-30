#!/usr/bin/env python3
"""直连监视一个 OpenCode 会话，直到它安静下来。

不依赖外部的会话枚举（那一步在部分实例上会超时），
只用单会话接口：GET /session/{id} 与 /session/{id}/message?limit=1。

判定空闲：最近消息 id 与 session.updated 连续 idle 秒不变。
用法：
  python3 watch_opencode_session.py <session> [--base-url URL] [--idle-seconds 60] [--timeout 21600]
退出码：0 空闲 / 3 超时 / 4 连接错误
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request

UA = {"User-Agent": "opencode-watch/1.0"}


def get(url: str, timeout: float = 15.0):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def dir_stamp(path: str) -> int:
    """目录内最近修改时间（向下取整到 10s），用于把“文件在动”也算作活动。"""
    import os
    newest = 0.0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules')]
        for f in files:
            try:
                newest = max(newest, os.path.getmtime(os.path.join(root, f)))
            except OSError:
                pass
    return int(newest // 10) * 10


def snapshot(base: str, sid: str, activity_dir: str | None = None) -> tuple:
    sess = get(f"{base}/session/{sid}")
    upd = int((sess.get("time") or {}).get("updated") or 0)
    msgs = get(f"{base}/session/{sid}/message?limit=1")
    last_id, last_t = "", 0
    if isinstance(msgs, list) and msgs:
        info = msgs[-1].get("info") or {}
        last_id = info.get("id", "")
        last_t = int((info.get("time") or {}).get("created") or 0)
    stamp = dir_stamp(activity_dir) if activity_dir else 0
    return last_id, last_t, upd, stamp


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    ap.add_argument("--base-url", default="http://127.0.0.1:4097")
    ap.add_argument("--idle-seconds", type=int, default=60)
    ap.add_argument("--timeout", type=int, default=21600)
    ap.add_argument("--poll-interval", type=int, default=10)
    ap.add_argument("--activity-dir", default="")
    a = ap.parse_args()

    started = time.time()
    prev, stable_since = None, time.time()
    errs = 0
    while True:
        if time.time() - started > a.timeout:
            print(f"TIMEOUT {a.session} after {a.timeout}s", flush=True)
            return 3
        try:
            cur = snapshot(a.base_url, a.session, a.activity_dir or None)
            errs = 0
        except Exception as exc:  # noqa: BLE001
            errs += 1
            print(f"[warn] poll error {errs}: {exc}", flush=True)
            if errs >= 30:
                print(f"ERROR {a.session} 连续 30 次连接失败", flush=True)
                return 4
            time.sleep(a.poll_interval)
            continue
        if cur != prev:
            prev, stable_since = cur, time.time()
        elif time.time() - stable_since >= a.idle_seconds:
            print(f"IDLE {a.session} 静默 {a.idle_seconds}s，最后消息 {cur[0] or '-'}", flush=True)
            return 0
        time.sleep(a.poll_interval)


if __name__ == "__main__":
    raise SystemExit(main())
