"""
name: 音乐追踪器
enabled: false
note: 每半小时检查 perception.jsonl 增量，检测到新歌立即写入歌单和每日报告。
prompt: |-
  音乐追踪器，实时记录音乐播放数据，维护歌单和新歌报告。
"""

import time
import json
import os
from datetime import datetime

DATA_DIR = os.environ.get("AXEUH_AI_DATA_DIR", "ai/data")


def _format_duration(ms):
    """毫秒转为 mm:ss 格式"""
    if not ms:
        return "?"
    s = ms // 1000
    return f"{s // 60}:{s % 60:02d}"


def _song_key(artist, title):
    """构建唯一键"""
    a = (artist or "").strip()
    t = (title or "").strip()
    return f"{a} - {t}" if a else t


def _load_playlist(path):
    """加载歌单 JSON"""
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"total": 0, "songs": {}, "today_new": []}


def _save_playlist(path, data):
    """保存歌单 JSON"""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _write_master_md(path, data):
    """写入总歌单 Markdown"""
    songs = data.get("songs", {})
    # 按首次播放时间排序
    sorted_songs = sorted(songs.items(), key=lambda x: x[1].get("first_played", ""))

    lines = [
        "# 歌单",
        "",
        f"> 共 {len(sorted_songs)} 首，最后更新: {data.get('updated_at', '')}",
        "",
        "| # | 歌曲 | 艺术家 | 来源 | 首次播放 | 播放次数 |",
        "|---|------|--------|------|---------|---------|",
    ]

    for i, (key, info) in enumerate(sorted_songs, 1):
        title = info.get("title", "?")
        artist = info.get("artist", "?")
        app = info.get("app", "?")
        first = info.get("first_played", "?")
        count = info.get("play_count", 0)
        lines.append(f"| {i} | {title} | {artist} | {app} | {first} | {count} |")

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def _write_daily_new_md(path, date_str, new_songs):
    """写入/更新每日新歌 Markdown"""
    lines = [
        f"# 今日新歌 - {date_str}",
        "",
        f"> 共 {len(new_songs)} 首新歌",
        "",
    ]

    if new_songs:
        lines.append("| 时间 | 歌曲 | 艺术家 | 来源 | 时长 |")
        lines.append("|------|------|--------|------|------|")
        for s in new_songs:
            t = s.get("t", "?")
            title = s.get("title", "?")
            artist = s.get("artist", "?")
            app = s.get("app", "?")
            dur = _format_duration(s.get("duration"))
            lines.append(f"| {t} | {title} | {artist} | {app} | {dur} |")
    else:
        lines.append("今日暂无新歌。")

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def run(context):
    """实时监控 perception.jsonl 增量"""
    context.log("音乐追踪器已启动，实时监控 media 事件")

    playlist_path = os.path.join(DATA_DIR, "music_playlist.json")
    master_md_path = os.path.join(DATA_DIR, "歌单.md")
    file_positions = {}  # {path: last_byte_position}
    today_new = {}  # {date_str: [song_info]}

    # 加载已有歌单
    playlist = _load_playlist(playlist_path)

    while True:
        now = datetime.now()
        today = now.strftime("%Y-%m-%d")

        jsonl_path = os.path.join(DATA_DIR, today, "perception.jsonl")

        if os.path.exists(jsonl_path):
            current_size = os.path.getsize(jsonl_path)
            last_pos = file_positions.get(jsonl_path, 0)

            if current_size > last_pos:
                # 有新增内容，读取增量部分
                try:
                    with open(jsonl_path, "r", encoding="utf-8") as f:
                        f.seek(last_pos)
                        new_content = f.read()
                    file_positions[jsonl_path] = current_size

                    # 逐行处理新的 media 事件
                    changed = False
                    day_new_songs = today_new.setdefault(today, [])

                    for line in new_content.strip().split("\n"):
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        if event.get("type") != "media":
                            continue
                        # 只记录 playing 状态
                        if event.get("media_state") != "playing":
                            continue

                        title = event.get("media_title", "")
                        artist = event.get("media_artist", "")
                        app = event.get("media_app", "")
                        duration = event.get("media_duration", 0)
                        t = event.get("t", "")

                        key = _song_key(artist, title)
                        if not key:
                            continue

                        songs = playlist.setdefault("songs", {})

                        if key not in songs:
                            # 新歌
                            songs[key] = {
                                "title": title,
                                "artist": artist,
                                "app": app,
                                "duration_ms": duration,
                                "first_played": today,
                                "last_played": today,
                                "play_count": 1,
                                "play_dates": [today],
                            }
                            playlist["today_new"] = playlist.get("today_new", []) + [key]
                            day_new_songs.append({
                                "t": t,
                                "title": title,
                                "artist": artist,
                                "app": app,
                                "duration": duration,
                            })
                            context.log(f"新歌: {key}")
                            changed = True
                        else:
                            # 已存在的歌，更新统计
                            info = songs[key]
                            info["last_played"] = today
                            info["play_count"] = info.get("play_count", 0) + 1
                            dates = info.setdefault("play_dates", [])
                            if today not in dates:
                                dates.append(today)

                    if changed:
                        # 保存歌单 JSON
                        playlist["total"] = len(playlist.get("songs", {}))
                        _save_playlist(playlist_path, playlist)

                        # 更新总歌单 MD
                        _write_master_md(master_md_path, playlist)

                        # 更新每日新歌 MD
                        daily_new_path = os.path.join(DATA_DIR, today, f"新歌-{today}.md")
                        _write_daily_new_md(daily_new_path, today, day_new_songs)

                except Exception as e:
                    context.log(f"读取 perception.jsonl 异常: {e}")

        # 每半小时检查一次，心跳每 60 秒发送一次（留足余量）
        for _ in range(30):
            context.heartbeat()
            time.sleep(60)
