#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
事实提取器 - 将原始perception.jsonl转换为可读的Markdown格式

去机器冗余但保留全量语音信息。
- GPS不变不重复
- HR取范围值
- VAD重复文本去重（前40字相同视为重复）
- 全量保留语音原文（不折叠不裁剪）

用法:
    python {AI目录}/analysis/fact_extractor.py 2026-06-14
    python {AI目录}/analysis/fact_extractor.py 2026-06-14 --hours 06:00~14:00
    python {AI目录}/analysis/fact_extractor.py 2026-06-14 --output /path/to/output.md
"""

import json
import re
import sys
import os
import requests
import time
from datetime import datetime, timedelta, timezone

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_AI_DIR = os.path.normpath(os.path.join(_SCRIPT_DIR, '..'))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
from health_source import read_health_view

# 百度逆地理编码配置（部署时替换为你的 AK，或改为从配置文件读取）
BAIDU_AK = '{百度地图AK}'
GEO_CACHE_FILE = os.path.join(_AI_DIR, 'data', 'gps_cache.json')

# GPS缓存
_geo_cache = {}
if os.path.exists(GEO_CACHE_FILE):
    try:
        with open(GEO_CACHE_FILE, 'r', encoding='utf-8') as f:
            _geo_cache = json.load(f)
    except Exception:
        _geo_cache = {}


def reverse_geocode(gps_str):
    """解析GPS坐标，返回地名（带缓存）"""
    if gps_str in _geo_cache:
        return _geo_cache[gps_str]

    parts = gps_str.split(',')
    if len(parts) != 2:
        _geo_cache[gps_str] = gps_str
        return gps_str

    lat, lng = parts[0].strip(), parts[1].strip()
    url = (
        f'https://api.map.baidu.com/reverse_geocoding/v3/'
        f'?ak={BAIDU_AK}&output=json&coordtype=wgs84ll&location={lat},{lng}'
    )

    try:
        r = requests.get(url, timeout=10)
        data = r.json()
        if data.get('status') == 0:
            result = data.get('result', {})
            addr = result.get('formatted_address', '')
            poi = result.get('pois', [])
            poi_names = [p.get('name', '') for p in poi[:3]]
            location = addr
            if poi_names:
                location += ' | 附近: ' + ', '.join(poi_names)
            _geo_cache[gps_str] = location
        else:
            _geo_cache[gps_str] = gps_str
    except Exception:
        _geo_cache[gps_str] = gps_str

    time.sleep(0.5)  # 1秒最多2次，避免百度API限流
    return _geo_cache[gps_str]


def save_geo_cache():
    """保存GPS缓存"""
    try:
        os.makedirs(os.path.dirname(GEO_CACHE_FILE), exist_ok=True)
        with open(GEO_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(_geo_cache, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _find_data_file(date_str, filename):
    """在 AI 目录的数据根中查找数据文件（兼容 daily/ 与旧扁平布局）"""
    cwd = os.getcwd()
    search_paths = [
        os.path.join(_AI_DIR, 'data', 'daily', date_str, filename),
        os.path.join(cwd, 'data', 'daily', date_str, filename),
        # 向后兼容旧路径
        os.path.join(_AI_DIR, 'data', date_str, filename),
        os.path.join(cwd, 'data', date_str, filename),
    ]
    for p in search_paths:
        if os.path.exists(p):
            return p
    return None


def load_perception(date_str):
    """加载指定日期的perception.jsonl（R7: 逐行容错，坏行跳过并计数告警；合法文件输出与原实现逐字节一致）"""
    path = _find_data_file(date_str, 'perception.jsonl')
    if not path:
        print(f'错误: 未找到 data/daily/{date_str}/perception.jsonl', file=sys.stderr)
        return None
    events = []
    bad_lines = 0
    with open(path, 'r', encoding='utf-8') as f:
        for lineno, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except ValueError:
                bad_lines += 1
                print(f'警告: perception.jsonl 第{lineno}行 JSON 解析失败，已跳过', file=sys.stderr)
    if bad_lines:
        print(f'警告: perception.jsonl 共跳过 {bad_lines} 个坏行', file=sys.stderr)
    return events


def load_deepdive(date_str: str) -> "dict[str, dict] | None":
    """加载 MOSS 深潜旁路 audio_deepdive.jsonl，返回 {audio指针: 行dict}（同指针后行覆盖前行）。

    缺文件 / 任何读取错误 → None（绝不抛异常）。None 是"当日无深潜数据"的唯一信号，
    渲染层收到 None 必须不产出任何 MOSS 行——这是 D10 的缺失即逐字节不变金标契约。
    """
    path = _find_data_file(date_str, 'audio_deepdive.jsonl')
    if not path:
        return None
    rows: dict[str, dict] = {}
    bad_lines = 0
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for lineno, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    bad_lines += 1
                    print(f'警告: audio_deepdive.jsonl 第{lineno}行 JSON 解析失败，已跳过', file=sys.stderr)
                    continue
                if isinstance(row, dict) and row.get('audio'):
                    rows[row['audio']] = row  # 后行覆盖前行（append-only 文件取最新深潜结论）
    except Exception:
        return None
    if bad_lines:
        print(f'警告: audio_deepdive.jsonl 共跳过 {bad_lines} 个坏行', file=sys.stderr)
    return rows


def _moss_one_line(value) -> str:
    """把任意字段压成单行文本（去掉换行），保证 └ MOSS 子行绝不跨行。"""
    if value is None:
        return ''
    return str(value).replace('\r', ' ').replace('\n', ' ')


def _moss_subline(deepdive_map: "dict[str, dict] | None", audio_ptr: str) -> str:
    """按 audio 指针生成一条语音行子行（无命中返回 ''）。

    三形态分派（D4 行形状）：_sc 短路静音 / _error 出错 / 正常行 src+scene+叙事。
    叙事截断 120 字与"单行化"都是字节契约的一部分：子行恒为一行。
    """
    if not deepdive_map or not audio_ptr:
        return ''
    row = deepdive_map.get(audio_ptr)
    if row is None:
        return ''
    if row.get('_sc'):
        return '  └ MOSS: 短路静音'
    err = row.get('_error')
    if err is not None:
        return ''
    parsed = row.get('parsed') or {}
    if parsed.get('is_silence') is True:
        return '  └ MOSS: 静音/无语音'
    src = _moss_one_line(parsed.get('source_type'))
    if src != 'ambient':
        return ''
    scene = _moss_one_line(parsed.get('scene'))
    # 截断 120 字：深潜叙事长句仅做旁注，事实文件不吞正文
    narr = _moss_one_line(parsed.get('narrative'))[:120]
    if scene:
        return f'  └ MOSS: src={src} scene={scene} 叙事:{narr}'
    return f'  └ MOSS: src={src} 叙事:{narr}'


def _health_shard_exists(date_str):
    """分片真源是否存在（users/*/health/{date}/cloud.json）"""
    bases = [
        os.path.join(os.getcwd(), 'ai', 'data'),
        os.path.join(os.getcwd(), 'data'),
        os.path.join(_SCRIPT_DIR, '..', 'data'),
    ]
    for base in bases:
        users_dir = os.path.join(base, 'users')
        if not os.path.isdir(users_dir):
            continue
        try:
            users = os.listdir(users_dir)
        except OSError:
            continue
        for user in users:
            if os.path.exists(
                os.path.join(users_dir, user, 'health', date_str, 'cloud.json')
            ):
                return True
    return False


def load_health(date_str):
    """加载指定日期的健康数据（P2-V11: 分片合成视图优先，派生文件回落）

    fail-fast: 分片真源存在但视图读不出（典型＝裸 python 缺 pydantic）时直接退出，
    不再静默产出没有 HR/SpO2 的事实文件。
    """
    view = read_health_view(date_str)
    if view is not None:
        return view
    path = _find_data_file(date_str, 'health.json')
    if not path:
        if _health_shard_exists(date_str):
            sys.exit(
                f'错误: {date_str} 健康分片存在但视图读取失败（多为缺 pydantic）。'
                '请改用安装了后端依赖的 Python 解释器（{Python解释器路径}）运行 fact_extractor.py，'
                '否则事实文件会静默丢 HR/SpO2。'
            )
        return {'samples': [], 'sleep_data': {}}
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def clean_time_str(t_str):
    """统一时间格式：去除日期前缀和时区后缀，返回 HH:MM:SS"""
    if not t_str:
        return ''
    clean = t_str
    if 'T' in clean:
        clean = clean.split('T')[1]
    if '+' in clean and clean.count(':') >= 2:
        clean = clean.split('+')[0]
    clean = clean.rstrip('Z')
    return clean


def get_slot_key(t_str):
    """将时间戳转为5分钟时段键 'HH:MM'"""
    clean = clean_time_str(t_str)
    if not clean:
        return '00:00'
    parts = clean.split(':')
    h = int(parts[0])
    m = int(parts[1])
    slot_m = (m // 5) * 5
    return f'{h:02d}:{slot_m:02d}'


def seconds_since_midnight(t_str):
    """将时间戳转为秒数"""
    clean = clean_time_str(t_str)
    if not clean:
        return 0
    parts = clean.split(':')
    h = int(parts[0])
    m = int(parts[1])
    s = int(parts[2]) if len(parts) > 2 else 0
    return h * 3600 + m * 60 + s


def secs_to_str(secs):
    """秒数转为 HH:MM:SS 字符串"""
    total = int(secs) % 86400
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    return f'{h:02d}:{m:02d}:{s:02d}'


def is_valid_voice_text(text):
    """判断语音文本是否有效（非空、非nospeech/Event_UNK）"""
    if not text or not text.strip():
        return False
    stripped = text.strip()
    if '<|nospeech|>' in stripped or '<|Event_UNK|>' in stripped:
        return False
    return True


def get_voice_dedup_key(text):
    """语音去重键：前40字"""
    return text.strip()[:40]


def parse_time_to_minutes(t_str):
    """将多种时间格式解析为当天分钟数(0~1440)"""
    if not t_str:
        return None
    clean = t_str
    # 去掉日期部分 (如 "2026-06-22T19:13:50+08:00" -> "19:13:50+08:00")
    if 'T' in clean:
        clean = clean.split('T')[1]
    # 去掉时区偏移 (如 "19:13:50+08:00" -> "19:13:50")
    if '+' in clean and clean.count(':') >= 2:
        clean = clean.split('+')[0]
    # 去掉可能的Z后缀
    clean = clean.rstrip('Z')
    parts = clean.split(':')
    if len(parts) >= 2:
        try:
            return int(parts[0]) * 60 + int(parts[1])
        except ValueError:
            return None
    return None


_CST = timezone(timedelta(hours=8))


def _epoch_hm(ts):
    """epoch 秒 -> 东八区 HH:MM；非法值返回空串。"""
    if isinstance(ts, bool):
        return ''
    if isinstance(ts, str):
        try:
            ts = int(ts.strip())
        except ValueError:
            return ''
    if not isinstance(ts, (int, float)):
        return ''
    try:
        return datetime.fromtimestamp(ts, _CST).strftime('%H:%M')
    except (ValueError, OSError, OverflowError):
        return ''


def _stage_hm(stage):
    """stage 的时间标签：legacy `t` 优先，canonical `start_ts` 回落。"""
    if not isinstance(stage, dict):
        return ''
    t = stage.get('t')
    if t:
        return str(t)
    return _epoch_hm(stage.get('start_ts'))


def _stage_duration_min(stages, idx):
    """第 idx 段时长：优先 duration_min，缺失时用与下一段的 HH:MM 间隔。"""
    stage = stages[idx]
    duration = stage.get('duration_min')
    if duration is None and idx + 1 < len(stages):
        duration = _stage_gap_minutes(_stage_hm(stage), _stage_hm(stages[idx + 1]))
    return int(duration or 0)


def filter_events_by_time(events, time_range_str):
    """按时间范围过滤事件"""
    if not time_range_str:
        return events
    # 格式: "06:00~14:00"
    start_str, end_str = time_range_str.split('~')
    start_min = int(start_str[:2]) * 60 + int(start_str[3:5])
    end_min = int(end_str[:2]) * 60 + int(end_str[3:5])

    result = []
    for e in events:
        t = e.get('t', '')
        t_min = parse_time_to_minutes(t)
        if t_min is None:
            continue

        if start_min <= end_min:
            if start_min <= t_min <= end_min:
                result.append(e)
        else:
            # 跨天 (如 22:00~06:00)
            if t_min >= start_min or t_min <= end_min:
                result.append(e)
    return result


def group_by_slot(events):
    """将事件按5分钟时段分组，返回有序列表 [(slot_key, [events])]"""
    slot_map = {}
    for e in events:
        t = e.get('t', '')
        if not t:
            continue
        slot = get_slot_key(t)
        if slot not in slot_map:
            slot_map[slot] = []
        slot_map[slot].append(e)

    result = []
    for sk in sorted(slot_map.keys()):
        result.append((sk, slot_map[sk]))
    return result


# pyright: reportOptionalMemberAccess=false, reportAttributeAccessIssue=false


def _collect_device_ids(data, e):
    """收集事件中的设备标识（设备名 + PC Agent ID）"""
    # 收集设备标识
    dn = e.get('device_name')
    if dn:
        data['device_names'].add(dn)
    aid = e.get('_agent_id')
    if aid:
        data['device_agent_ids'].add(aid)


def _collect_sensor(data, e, t):
    """收集 sensor 事件（GPS/HR/步数/电量）"""
    gps = e.get('gps')
    if gps and gps != data['gps']:
        data['gps'] = gps
        data['gps_time'] = t[:5]
        data['gps_location'] = reverse_geocode(gps)

    hr = e.get('hr')
    if hr:
        data['hr_values'].append((t[:5], hr))

    steps = e.get('steps')
    if steps is not None:
        data['steps'] = steps
    battery = e.get('battery')
    if battery is not None:
        data['battery'] = battery
    pb = e.get('phone_battery')
    if pb is not None:
        data['phone_battery'] = pb


def _collect_screen(data, e, t):
    """收集 screen 事件（锁屏/解锁状态）"""
    locked = e.get('locked')
    if locked is not None:
        data['screen_locked'] = locked
        data['screen_times'].append((t[:5], '锁屏' if locked else '解锁'))


def _collect_heartbeat(data, e, t):
    """收集 heartbeat 事件（App 每个上传周期一条的「存活 + 当前状态」断言）

    与 screen/app 事件的本质区别：heartbeat 是周期快照、不携带"变化"语义，
    因此只更新状态 carry-forward（screen_locked / phone_battery / current_app），
    **不进 screen_times / apps 时间线**——否则 30s 一条的例行行会淹没真实变更事件。
    时段内有 heartbeat = 采集器当时在线（数据缺失可归因于"真无变化"而非"没在采"）。
    """
    locked = e.get('locked')
    if locked is not None:
        data['screen_locked'] = locked
    pb = e.get('phone_battery')
    if pb is not None:
        data['phone_battery'] = pb
    app = e.get('app')
    if app:
        data['current_app'] = app
    data['heartbeat_count'] += 1


def _collect_voice(data, e, t):
    """收集 voice 事件（语音段 + 环境音事件，合并为时间线）"""
    event_sec = seconds_since_midnight(t)
    items = []

    if "vp" in e:
        # 新格式: 遍历 segs 数组（每个 VAD 段一个对象）
        for seg in e.get("segs", []):
            text = seg.get("text", "").strip()
            vp = seg.get("vp", {}) or {}
            sim = vp.get("sim") or 0
            vp_windows = vp.get("ws", [])
            # 新格式 vp.ws 是扁平数组 [t,s,t,s,...], 转为 [{start_ms:t, score:s}]
            if vp_windows and isinstance(vp_windows, list) and len(vp_windows) > 0 and not isinstance(vp_windows[0], dict):
                converted = []
                for i in range(0, len(vp_windows) - 1, 2):
                    converted.append({"start_ms": vp_windows[i], "score": vp_windows[i+1]})
                vp_windows = converted
            # 真正缺 pct 时归 -1，供 vp_pct == -1 -> 未校验 守卫使用
            vp_pct = vp.get("pct")
            vp_pct = -1 if vp_pct is None else vp_pct

            if is_valid_voice_text(text):
                dedup_key = get_voice_dedup_key(text)
                if dedup_key not in data['seen_voice_texts']:
                    data['seen_voice_texts'].add(dedup_key)
                    items.append({
                        'type': 'speech',
                        'offset': seg.get("start", 0),
                        'sim': sim,
                        'text': text,
                        'speaker': vp.get('spk', '') or e.get("tag", ""),
                        'vp_windows': vp_windows,
                        'vp_max': vp.get('max'),
                        'vp_pct': vp_pct,
                            'tokens': seg.get("tokens", []),
                            # D10: 携带来源 voice 条目的 audio 指针，供渲染层交叉深潜子行
                            'audio_ptr': e.get('audio') or '',
                            'vp_stats': None,
                            'speech_prob': None,
                            'silence_ratio': None,
                            'avg_db': (e.get("ac") or {}).get("db"),
                            'peak_db': None,
                            'db_range': None,
                            'zcr': None,
                            'spectral': None,
                            'voice_ratio': None,
                        })
    else:
        # 兼容旧格式(segments+voiceprint_sim) 和 新格式无顶层vp(segs+vp.sim)
        segs = e.get('segments') or e.get('segs', [])
        for s in segs:
            text = s.get('text', '').strip()
            vp = s.get('vp', {}) or {}
            # sim: 优先 vp.sim(新), 降级 voiceprint_sim(旧)
            sim = vp.get('sim') or s.get('voiceprint_sim') or 0
            vp_stats = s.get('voiceprint_stats', None)
            speech_prob = s.get('speech_prob', None)
            silence_ratio = s.get('silence_ratio', None)
            avg_db = s.get('avg_db', None)
            peak_db = s.get('peak_db', None)
            db_range = s.get('db_range', None)
            zcr = s.get('zero_crossing_rate', None)
            spectral = s.get('spectral_centroid', None)
            voice_ratio = s.get('voice_ratio', None)
            offset = s.get('start', 0)
            # 新格式 vp.ws 扁平数组格式转换（与 if 分支一致）
            vp_windows = vp.get('ws') or s.get('voiceprint_windows', None)
            if vp_windows and isinstance(vp_windows, list) and len(vp_windows) > 0 and not isinstance(vp_windows[0], dict):
                converted = []
                for i in range(0, len(vp_windows) - 1, 2):
                    converted.append({"start_ms": vp_windows[i], "score": vp_windows[i+1]})
                vp_windows = converted
            # 真正缺 pct 时归 -1，供 vp_pct == -1 -> 未校验 守卫使用
            vp_pct = vp.get('pct')
            vp_pct = -1 if vp_pct is None else vp_pct
            if is_valid_voice_text(text):
                dedup_key = get_voice_dedup_key(text)
                if dedup_key not in data['seen_voice_texts']:
                    data['seen_voice_texts'].add(dedup_key)
                    items.append({
                        'type': 'speech',
                        'offset': offset,
                        'sim': sim,
                        'text': text,
                        'speaker': vp.get('spk') or s.get('voiceprint_speaker', ''),
                        'vp_windows': vp_windows,
                        'vp_max': vp.get('max'),
                        'vp_pct': vp_pct,
                            'tokens': s.get("tokens", []),
                            'audio_ptr': e.get('audio') or '',
                            'vp_stats': vp_stats,
                        'speech_prob': speech_prob,
                        'silence_ratio': silence_ratio,
                        'avg_db': avg_db,
                        'peak_db': peak_db,
                        'db_range': db_range,
                        'zcr': zcr,
                        'spectral': spectral,
                        'voice_ratio': voice_ratio,
                    })

    # 收集音频事件（与语音段时间线合并）—— env 三形态兼容分派：
    # dict{label,prob,start}(内核新产) / 纯字符串 / 字符串数组(历史)
    env_val = e.get("env", None)
    if env_val is not None:
        if isinstance(env_val, dict):
            env_list = [env_val]
        elif isinstance(env_val, str):
            env_list = [env_val]
        else:
            env_list = env_val
        seen_env = set()
        for entry in env_list:
            if isinstance(entry, dict):
                # 内核新格式: 用真实概率 + start 偏移，按 (label, offset) 去重
                label = entry.get('label') or ''
                prob = entry.get('prob')
                if prob is None:
                    prob = entry.get('probability', 0.5)
                offset = entry.get('start') or 0
                dedup_key = (label, offset)
            else:
                # 历史字符串形态: 回退固定 0.5 / 0
                label = entry
                prob = 0.5
                offset = 0
                dedup_key = label
            if label and dedup_key not in seen_env:
                seen_env.add(dedup_key)
                items.append({
                    'type': 'audio_event',
                    'offset': offset,
                    'label': label,
                    'probability': prob,
                })
    else:
        # 旧格式: 对象数组（按 (label, offset) 去重，避免同事件内完全重复项）
        seen_ae = set()
        for ae in e.get('audio_events', []):
            label = ae.get('label_cn', ae.get('label', ''))
            prob = ae.get('probability', 0)
            offset = ae.get('start', 0)
            key = (label, offset)
            if prob >= 0.1 and label and key not in seen_ae:
                seen_ae.add(key)
                items.append({
                    'type': 'audio_event',
                    'offset': offset,
                    'label': label,
                    'probability': prob,
                })

    # 按 (事件时间, 偏移量) 排序后追加
    for item in sorted(items, key=lambda x: (event_sec, x['offset'])):
        item['event_time'] = event_sec
        item['time_display'] = t[:5]
        data['voice_timeline'].append(item)


def _collect_app(data, e, t):
    """收集 app 事件（前台应用）"""
    app_name = e.get('app', '')
    if app_name:
        data['apps'].append((t[:5], app_name))


def _collect_media(data, e, t):
    """收集 media 事件（音乐/媒体）"""
    title = e.get('media_title', '')
    artist = e.get('media_artist', '')
    state = e.get('media_state', '')
    if title:
        data['medias'].append((t[:5], title, artist, state))


def _collect_notify(data, e, t):
    """收集 notify 事件（通知，兼容新旧格式）"""
    # 兼容新旧格式：app(新) > pkg(旧)
    app = e.get('app', e.get('pkg', ''))
    title = e.get('title', '')
    text = e.get('text', '')
    items = e.get('items', [])
    if items:
        for item in items:
            itext = item.get('text', '')
            iapp = item.get('app', item.get('pkg', ''))
            ititle = item.get('title', '')
            if itext:
                data['notifies'].append((t[:5], iapp, ititle, itext))
    elif text:
        data['notifies'].append((t[:5], app, title, text))


def _collect_input(data, e, t):
    """收集 input 事件（用户输入）"""
    text = e.get('text', '')
    if text:
        data['inputs'].append((t[:5], text))


def _collect_web_message(data, e, t):
    """收集 web_message 事件（网页消息/任务触发）"""
    content = e.get('content', '')
    source = e.get('source', 'web_message')
    if content:
        if source == 'task_trigger':
            data['task_triggers'].append((t[:5], content))
        else:
            data['web_messages'].append((t[:5], content))


def _collect_device_env(data, e, t):
    """收集 device_env 事件（WiFi 状态）"""
    wifi = e.get('wifi', {})
    conn = wifi.get('connected')
    if conn is not None:
        data['wifi_connected'] = conn
        data['wifi_rssi'] = wifi.get('rssi')


def _collect_pc_idle(data, e, t):
    """收集 pc_idle 事件（PC 待机状态）"""
    payload = e.get('payload', {})
    state = payload.get('state', '')
    idle = payload.get('idle_seconds')
    if state:
        data['pc_idle'] = state
        data['pc_idle_seconds'] = idle


def _collect_pc_window(data, e, t):
    """收集 pc_window 事件（PC 前台窗口）"""
    payload = e.get('payload', {})
    proc = payload.get('process', '')
    title = payload.get('title', '')
    if proc:
        data['pc_windows'].append((t[:5], proc, title))


def _collect_balance(data, e, t):
    """收集 balance 事件（DeepSeek 余额记录）"""
    bal = e.get('balance')
    if bal is not None:
        data['balances'].append((t[:5], bal, e.get('currency', 'CNY')))


def collect_slot_data(events, prev_state):
    """收集一个时段内所有类型的数据，返回摘要字典"""
    data = {
        'gps': prev_state.get('gps'),
        'gps_time': None,
        'gps_location': prev_state.get('gps_location'),
        'hr_values': [],
        'steps': None,
        'battery': None,
        'phone_battery': None,
        'screen_locked': prev_state.get('screen_locked'),
        'screen_times': [],
        # heartbeat：周期快照计数 + 最后已知前台应用（不进时间线，仅存活证明与 carry-forward）
        'heartbeat_count': 0,
        'current_app': prev_state.get('current_app'),
        'voice_timeline': [],  # 统一时间线：语音段 + 环境音事件，按时间排列
        'apps': [],
        'medias': [],
        'notifies': [],
        'inputs': [],
        'web_messages': [],
        'task_triggers': [],
        'wifi_connected': prev_state.get('wifi_connected'),
        'wifi_rssi': None,
        'pc_windows': [],
        'pc_idle': prev_state.get('pc_idle'),
        'pc_idle_seconds': prev_state.get('pc_idle_seconds'),
        'balances': [],  # DeepSeek 余额记录 (t, balance, currency)
        'seen_voice_texts': set(),
        'device_names': set(),    # 该时段活跃的设备名称集合
        'device_agent_ids': set(),  # PC Agent ID 集合
    }

    for e in events:
        t = e.get('t', '')
        tp = e.get('type', '')

        # 收集设备标识
        _collect_device_ids(data, e)

        if tp == 'sensor':
            _collect_sensor(data, e, t)
        elif tp == 'screen':
            _collect_screen(data, e, t)
        elif tp == 'voice':
            _collect_voice(data, e, t)
        elif tp == 'app':
            _collect_app(data, e, t)
        elif tp == 'media':
            _collect_media(data, e, t)
        elif tp == 'notify':
            _collect_notify(data, e, t)
        elif tp == 'input':
            _collect_input(data, e, t)
        elif tp == 'web_message':
            _collect_web_message(data, e, t)
        elif tp == 'device_env':
            _collect_device_env(data, e, t)
        elif tp == 'heartbeat':
            _collect_heartbeat(data, e, t)
        elif tp == 'pc_idle':
            _collect_pc_idle(data, e, t)
        elif tp == 'pc_window':
            _collect_pc_window(data, e, t)
        elif tp == 'balance':
            _collect_balance(data, e, t)

    return data


def format_hr_trend(hr_values):
    """格式化HR趋势：全相同→单值; 有变化→首尾趋势"""
    if not hr_values:
        return ''
    vals = [v for _, v in hr_values]
    if len(set(vals)) == 1:
        return str(vals[0])
    # 只显示首尾变化点
    first = hr_values[0]
    last = hr_values[-1]
    return f'{first[1]}({first[0]})->{last[1]}({last[0]})'


def format_hr_range(hr_values):
    """格式化HR范围（用于合并时段）：返回 min~max"""
    if not hr_values:
        return ''
    vals = [v for _, v in hr_values]
    return f'{min(vals)}~{max(vals)}'


def get_health_hr_at_time(health_samples, target_time_str):
    """从health.json获取指定时间附近的HR值"""
    target_sec = seconds_since_midnight(target_time_str)
    best = None
    best_diff = 99999
    for s in health_samples:
        t_iso = s.get('t_iso', '')
        hr = s.get('hr')
        if hr and t_iso:
            try:
                dt = datetime.fromisoformat(t_iso)
                sample_sec = dt.hour * 3600 + dt.minute * 60 + dt.second
                diff = abs(sample_sec - target_sec)
                if diff < best_diff and diff < 180:
                    best = (dt.strftime('%H:%M'), hr)
                    best_diff = diff
            except Exception:
                pass
    return best


def get_health_spo2_at_time(health_samples, target_time_str):
    """从health.json获取指定时间附近的血氧值"""
    target_sec = seconds_since_midnight(target_time_str)
    best = None
    best_diff = 99999
    for s in health_samples:
        t_iso = s.get('t_iso', '')
        spo2 = s.get('spo2')
        if spo2 and t_iso:
            try:
                dt = datetime.fromisoformat(t_iso)
                sample_sec = dt.hour * 3600 + dt.minute * 60 + dt.second
                diff = abs(sample_sec - target_sec)
                if diff < best_diff and diff < 180:
                    best = (dt.strftime('%H:%M'), spo2)
                    best_diff = diff
            except Exception:
                pass
    return best


def get_health_hr_values(health_samples, start_time_str, end_time_str):
    """从health.json获取指定时段内的所有心率值，返回数组"""
    start_sec = seconds_since_midnight(start_time_str)
    end_sec = seconds_since_midnight(end_time_str)
    values = []
    for s in health_samples:
        t_iso = s.get('t_iso', '')
        hr = s.get('hr')
        if hr and t_iso:
            try:
                dt = datetime.fromisoformat(t_iso)
                sample_sec = dt.hour * 3600 + dt.minute * 60 + dt.second
                if start_sec <= sample_sec <= end_sec:
                    values.append(hr)
            except Exception:
                pass
    return values


def format_hr_array(values):
    """将心率数组格式化为显示字符串，过长时截断为数组+范围"""
    if not values:
        return ''
    if len(values) <= 8:
        return '[' + ', '.join(str(v) for v in values) + ']'
    return f'[{values[0]}~{values[-1]}] ({min(values)}-{max(values)}, {len(values)}个)'


def format_slot_end(slot_key):
    """从时段键计算结束时间显示 (slot_key + 5分钟)"""
    h = int(slot_key[:2])
    m = int(slot_key[3:5]) + 5
    if m >= 60:
        h += 1
        m -= 60
    return f'{h:02d}:{m:02d}'


def _format_token_text(text, tokens, threshold=0.01):
    """将 tokens 逐字声纹值嵌入文本，连续重复/近似值只显示第一个。
    连续负值只显示第一个，正值逐个显示。

    输出: "字1(0.12)字2 字3(0.15)字4..."
    阈值 0.01 过滤微差（如 0.0371→0.0371 不重复显示）
    """
    if not tokens or not text:
        return text

    # 从 tokens 提取字符和分值
    chars = [t.get('c', '') for t in tokens]
    vals = [t.get('v', 0) for t in tokens]

    # 安全兜底：tokens 长度和文本不一致时回退
    if len(chars) != len(text):
        return text

    result = []
    last_shown = None
    in_negative_run = False
    for i, (ch, v) in enumerate(zip(chars, vals)):
        result.append(ch)
        if v < 0:
            if in_negative_run:
                continue
            in_negative_run = True
            result.append(f'({v:.2f})')
            last_shown = v
        else:
            in_negative_run = False
            if last_shown is None or abs(v - last_shown) > threshold:
                result.append(f'({v:.2f})')
                last_shown = v

    return ''.join(result)


def _section_location(data):
    """位置行（仅坐标变化时输出）"""
    lines = []
    # 位置（不显示原始GPS坐标；重复坐标不输出，仅坐标变化时输出 — 2026-09-11 GPS去重）
    if data.get('gps_time') is not None:
        if data['gps'] and data['gps_location']:
            lines.append(f'\n- **位置**: {data["gps_location"]}')
        elif data['gps']:
            lines.append('- **位置**: (GPS信号，位置解析中)')
    return lines


def _section_physio(data, slot_start, slot_end, health_samples, is_merged):
    """生理行（HR/SpO2/电量）"""
    lines = []
    # 生理
    physio_parts = []
    # 优先使用感知数据中的HR，其次从health.json获取
    if data['hr_values']:
        if is_merged:
            hr_str = format_hr_range(data['hr_values'])
        else:
            hr_str = format_hr_trend(data['hr_values'])
        physio_parts.append(f'HR={hr_str}')
    elif health_samples and not is_merged:
        # 从health.json获取该时段所有心率值
        hr_vals = get_health_hr_values(health_samples, slot_start + ':00', slot_end + ':00')
        if hr_vals:
            physio_parts.append(f'HR={format_hr_array(hr_vals)}')
        # SpO2：取该时段所有血氧值
        spo2_vals = []
        for s in health_samples:
            t_iso = s.get('t_iso', '')
            spo2 = s.get('spo2')
            if spo2 and t_iso:
                from datetime import datetime
                dt = datetime.fromisoformat(t_iso)
                sample_sec = dt.hour * 3600 + dt.minute * 60 + dt.second
                start_sec = seconds_since_midnight(slot_start + ':00')
                end_sec = seconds_since_midnight(slot_end + ':00')
                if start_sec <= sample_sec <= end_sec:
                    spo2_vals.append(spo2)
        if spo2_vals:
            physio_parts.append(f'SpO2={format_hr_array(spo2_vals)}')
    # 设备维度电量（优先）
    device_batteries = data.get('device_batteries', [])
    if device_batteries:
        battery_parts = []
        for dev, val in device_batteries:
            if dev:
                battery_parts.append(f'[{dev}]手环{val}%')
            else:
                battery_parts.append(f'手环{val}%')
        physio_parts.append(' | '.join(battery_parts))
    elif data['battery'] is not None:
        physio_parts.append(f'手环{data["battery"]}%')

    # 设备维度手机电量（优先）
    device_phone_batteries = data.get('device_phone_batteries', [])
    if device_phone_batteries:
        phone_battery_parts = []
        for dev, val in device_phone_batteries:
            if dev:
                phone_battery_parts.append(f'[{dev}]手机{val}%')
            else:
                phone_battery_parts.append(f'手机{val}%')
        physio_parts.append(' | '.join(phone_battery_parts))
    elif data['phone_battery'] is not None:
        physio_parts.append(f'手机{data["phone_battery"]}%')
    if physio_parts:
        lines.append(f'- **生理**: {" | ".join(physio_parts)}')
    return lines


def _section_alive(data):
    """App 存活行（heartbeat 周期快照汇总，仅有心跳数据时输出）

    heartbeat 由 App 每个上传周期（默认30s）发一条，携带 locked/phone_battery/app 当前态。
    渲染为一条计数行：无变化事件的时段靠它区分"状态真没变"与"采集器离线"。
    """
    lines = []
    hb = data.get('heartbeat_count', 0)
    if hb > 0:
        parts = [f'{hb} 次']
        if data.get('current_app'):
            parts.append(f"末态前台={data['current_app']}")
        if data.get('screen_locked') is not None:
            parts.append('末态亮屏' if not data['screen_locked'] else '末态锁屏')
        joined = ' | '.join(parts)
        lines.append(f'- **App存活**: {joined}')
    return lines


def _section_screen(data):
    """屏幕时间线/状态行"""
    lines = []
    # 屏幕时间线（每次屏幕状态变化）
    device_screen_times = data.get('device_screen_times', [])
    if device_screen_times:
        # 按设备分组
        dev_groups = {}
        for dev, (t, action) in device_screen_times:
            if dev not in dev_groups:
                dev_groups[dev] = []
            dev_groups[dev].append((t, action))
        lines.append('- **屏幕时间线**:')
        for dev in sorted(dev_groups.keys(), key=lambda x: (x == '', x)):
            for t, action in dev_groups[dev]:
                dev_prefix = f'[{dev}] ' if dev else ''
                lines.append(f'  - {t}:00 {action} {dev_prefix}'.strip())
    elif data['screen_times']:
        lines.append('- **屏幕时间线**:')
        for t, action in data['screen_times']:
            lines.append(f'  - {t}:00 {action}')
    elif data['screen_locked'] is not None:
        status = '锁屏' if data['screen_locked'] else '解锁'
        lines.append(f'- **屏幕**: {status}')
    return lines


def _section_voice_timeline(data, deepdive_map=None):
    """语音时间线行（语音段 + 环境音合并行；deepdive_map 命中时追加 └ MOSS 子行）"""
    lines = []
    # 语音时间线（语音段 + 环境音事件，按时间排列）
    if data['voice_timeline']:
        lines.append('- **语音时间线**:')
        # 分离 speech 和 audio_event
        speech_items = []
        audio_items = []
        for item in data['voice_timeline']:
            if item['type'] == 'speech':
                speech_items.append(item)
            else:
                audio_items.append(item)

        # 先渲染所有语音段
        for item in speech_items:
            speaker_str = f' [{item["speaker"]}]' if item.get('speaker') else ''
            # 时间信息：滑窗起止转为绝对时间戳
            vp_windows = item.get('vp_windows')
            if vp_windows and len(vp_windows) > 1:
                event_sec = item.get('event_time', 0)
                start_ms = vp_windows[0].get('start_ms', 0) if isinstance(vp_windows[0], dict) else 0
                end_ms = vp_windows[-1].get('start_ms', 0) if isinstance(vp_windows[-1], dict) else 0
                start_ts = secs_to_str(event_sec + start_ms / 1000.0)
                end_ts = secs_to_str(event_sec + end_ms / 1000.0)
                time_info = f' ({start_ts}~{end_ts})'
            else:
                event_sec = item.get('event_time', 0)
                offset = item.get('offset', 0)
                time_info = f' ({secs_to_str(event_sec + offset)})'

            # 声纹相似度：只报数值，不产出归属标签
            # （sim 是"像不像"，不是"是不是他说的"；归属由分析层
            #   凭设备侧证据（前台 App / 屏幕 / 电量）+ 用户口述判定）
            sim_val = item.get('sim', 0)
            vp_ws = item.get('vp_windows', [])
            vp_pct = item.get('vp_pct', -1)

            if not vp_ws or vp_pct == -1:
                stats_str = f' [sim {sim_val:.2f} 未校验]'
            else:
                stats_str = f' [sim {sim_val:.2f}]'

            # 基于 tokens 嵌入逐字声纹值（过滤连续重复/近似）
            formatted_text = _format_token_text(item['text'], item.get('tokens', []))
            lines.append(f'  - {time_info}: "{formatted_text}"{stats_str}')
            # D10 交叉参照：命中深潜行才追加子行；map 为 None / 未命中 → 输出与从前逐字节相同
            moss_line = _moss_subline(deepdive_map, item.get('audio_ptr') or '')
            if moss_line:
                lines.append(moss_line)

        # 再渲染环境音合并行（如果有）
        if audio_items:
            # 统计每个标签的出现次数和最高概率
            label_stats = {}  # label -> [count, max_probability]
            earliest_time = None
            latest_time = None
            for item in audio_items:
                lbl = item['label']
                p = item['probability']
                event_sec = item.get('event_time', 0)
                offset = item.get('offset', 0)
                event_time = event_sec + offset

                if lbl not in label_stats:
                    label_stats[lbl] = [1, p]
                else:
                    label_stats[lbl][0] += 1
                    label_stats[lbl][1] = max(label_stats[lbl][1], p)

                if earliest_time is None or event_time < earliest_time:
                    earliest_time = event_time
                if latest_time is None or event_time > latest_time:
                    latest_time = event_time

            # 排序：出现次数降序 > 概率降序 > 标签名升序
            sorted_labels = sorted(
                label_stats.items(),
                key=lambda x: (-x[1][0], -x[1][1], x[0])
            )

            # 分类：出现次数>=2的优先保留，其余按顺序
            high_freq = [(lbl, stats[0], stats[1]) for lbl, stats in sorted_labels if stats[0] >= 2]
            low_freq = [(lbl, stats[0], stats[1]) for lbl, stats in sorted_labels if stats[0] < 2]

            # 最多显示8个标签：高频率的全部保留，低频率的取满8个为止
            final_labels = high_freq[:8]
            remaining_slots = 8 - len(final_labels)
            if remaining_slots > 0:
                final_labels.extend(low_freq[:remaining_slots])

            # 构建标签字符串
            label_parts = []
            for lbl, count, prob in final_labels:
                prob_pct = int(prob * 100)
                label_parts.append(f'{lbl}[{prob_pct}%]')

            # 时间范围
            if earliest_time is not None and latest_time is not None:
                earliest_str = secs_to_str(earliest_time)[:5]  # HH:MM
                latest_str = secs_to_str(latest_time)[:5]
                if earliest_str == latest_str:
                    time_range = f' ({earliest_str})'
                else:
                    time_range = f' ({earliest_str}~{latest_str})'
            else:
                time_range = ''

            audio_line = f'- **环境音**: {" | ".join(label_parts)}{time_range}'
            lines.append(audio_line)
    else:
        lines.append('- **语音时间线**: 无')
    return lines


def _section_moss_ambient(deepdive_map, data, slot_start, slot_end):
    if not deepdive_map:
        return []
    attached = {
        item.get('audio_ptr')
        for item in data.get('voice_timeline', [])
        if item.get('type') == 'speech' and item.get('audio_ptr')
    }
    start = parse_time_to_minutes(slot_start)
    end = parse_time_to_minutes(slot_end)
    if start is None or end is None:
        return []
    selected = []
    for ptr, row in deepdive_map.items():
        if not ptr or ptr in attached:
            continue
        row_ts = str(row.get('ts') or '')
        minutes = parse_time_to_minutes(row_ts)
        if minutes is None:
            start_ms = row.get('start_ms')
            if isinstance(start_ms, (int, float)):
                dt = datetime.fromtimestamp(start_ms / 1000)
                minutes = dt.hour * 60 + dt.minute
        if minutes is None:
            continue
        if start <= end:
            if not (start <= minutes < end):
                continue
        elif not (minutes >= start or minutes < end):
            continue
        line = _moss_subline({ptr: row}, ptr).strip()
        if not line:
            continue
        if 'T' in row_ts:
            clock = row_ts.split('T', 1)[1][:8]
        else:
            clock = f'{minutes // 60:02d}:{minutes % 60:02d}'
        selected.append((minutes, clock, line.removeprefix('└ MOSS: ').strip()))
    if not selected:
        return []
    selected.sort()
    lines = ['- **MOSS 环境/静音**:']
    for _m, clock, payload in selected:
        lines.append(f'  - {clock} MOSS: {payload}')
    return lines


def _section_acoustics(data):
    """声学参数汇总行"""
    lines = []
    # 声学参数汇总（每时段一条，汇总该时段所有语音段）
    acou_dbs = []
    acou_peaks = []
    acou_ranges = []
    acou_zcrs = []
    acou_spectrals = []
    acou_vrs = []
    acou_probs = []
    for item in data['voice_timeline']:
        if item['type'] != 'speech':
            continue
        avg_db = item.get('avg_db')
        if avg_db is not None and avg_db != 0:
            acou_dbs.append(avg_db)
            peak_db = item.get('peak_db')
            if peak_db is not None and peak_db != 0:
                acou_peaks.append(peak_db)
            db_range = item.get('db_range')
            if db_range is not None and db_range != 0:
                acou_ranges.append(db_range)
        zcr = item.get('zcr')
        if zcr is not None and zcr > 0:
            acou_zcrs.append(zcr)
        spectral = item.get('spectral')
        if spectral is not None and spectral > 0:
            acou_spectrals.append(spectral)
        voice_ratio = item.get('voice_ratio')
        if voice_ratio is not None and voice_ratio > 0:
            acou_vrs.append(voice_ratio)
        speech_prob = item.get('speech_prob')
        if speech_prob is not None:
            acou_probs.append(speech_prob)

    if acou_dbs:
        parts = [f'音量={sum(acou_dbs)/len(acou_dbs):.0f}dB']
        if acou_peaks:
            parts.append(f'峰值={sum(acou_peaks)/len(acou_peaks):.0f}dB')
        if acou_ranges:
            parts.append(f'动态={sum(acou_ranges)/len(acou_ranges):.1f}dB')
        if acou_zcrs:
            parts.append(f'ZCR={sum(acou_zcrs)/len(acou_zcrs):.3f}')
        if acou_spectrals:
            parts.append(f'频谱={sum(acou_spectrals)/len(acou_spectrals):.0f}Hz')
        if acou_vrs:
            parts.append(f'语音占比={sum(acou_vrs)/len(acou_vrs)*100:.0f}%')
        if acou_probs:
            parts.append(f'说话概率={sum(acou_probs)/len(acou_probs)*100:.0f}%')
        lines.append(f'- **声学**: {" ".join(parts)}')
    return lines


def _section_music(data):
    """音乐行（设备维度优先，去重同曲目）"""
    lines = []
    # 音乐（去重同曲目）
    device_medias = data.get('device_medias', [])
    if device_medias:
        # 按设备分组，去重
        dev_groups = {}
        for dev, (t, title, artist, state) in device_medias:
            key = f'{title}|{artist}'
            if dev not in dev_groups:
                dev_groups[dev] = {'seen': set(), 'items': []}
            if key not in dev_groups[dev]['seen']:
                dev_groups[dev]['seen'].add(key)
                dev_groups[dev]['items'].append((t, title, artist, state))
        lines.append('- **音乐**:')
        for dev in sorted(dev_groups.keys(), key=lambda x: (x == '', x)):
            for t, title, artist, state in dev_groups[dev]['items']:
                artist_str = f' - {artist}' if artist else ''
                state_str = f' [{state}]' if state else ''
                dev_suffix = f'[{dev}]' if dev else ''
                lines.append(f'  - {t} "{title}"{artist_str}{state_str} {dev_suffix}'.strip())
    elif data['medias']:
        lines.append('- **音乐**:')
        seen_songs = set()
        for t, title, artist, state in data['medias']:
            key = f'{title}|{artist}'
            if key in seen_songs:
                continue
            seen_songs.add(key)
            artist_str = f' - {artist}' if artist else ''
            state_str = f' [{state}]' if state else ''
            lines.append(f'  - {t} "{title}"{artist_str}{state_str}')
    return lines


def _section_apps(data):
    """App 行（设备维度优先）"""
    lines = []
    # App
    device_apps = data.get('device_apps', [])
    if device_apps:
        # 按设备分组
        dev_groups = {}
        for dev, (t, name) in device_apps:
            if dev not in dev_groups:
                dev_groups[dev] = []
            dev_groups[dev].append(f'{t} {name}')
        app_parts = []
        for dev in sorted(dev_groups.keys(), key=lambda x: (x == '', x)):
            dev_prefix = f'[{dev}] ' if dev else ''
            app_parts.append(dev_prefix + '; '.join(dev_groups[dev]))
        lines.append(f'- **App**: {" | ".join(app_parts)}')
    elif data['apps']:
        app_strs = [f'{t} {name}' for t, name in data['apps']]
        lines.append(f'- **App**: {"; ".join(app_strs)}')
    return lines


def _section_notify(data):
    """通知行（设备维度优先，去重）"""
    lines = []
    # 通知（去重）
    device_notifies = data.get('device_notifies', [])
    if device_notifies:
        # 按设备分组，去重
        dev_groups = {}
        for dev, (t, pkg, title, text) in device_notifies:
            key = f'{pkg}:{title}:{text[:30]}'
            if dev not in dev_groups:
                dev_groups[dev] = {'seen': set(), 'items': []}
            if key not in dev_groups[dev]['seen']:
                dev_groups[dev]['seen'].add(key)
                dev_groups[dev]['items'].append((t, pkg, title, text))
        lines.append('- **通知**:')
        for dev in sorted(dev_groups.keys(), key=lambda x: (x == '', x)):
            for t, pkg, title, text in dev_groups[dev]['items']:
                pkg_short = pkg.split('.')[-1] if '.' in pkg else pkg
                title_part = f'[{title}] ' if title else ''
                dev_prefix = f'[{dev}] ' if dev else ''
                lines.append(f'  - {t} {pkg_short}: {title_part}{text} {dev_prefix}'.strip())
    elif data['notifies']:
        seen_notify = set()
        unique_notifies = []
        for t, pkg, title, text in data['notifies']:
            key = f'{pkg}:{title}:{text[:30]}'
            if key not in seen_notify:
                seen_notify.add(key)
                unique_notifies.append((t, pkg, title, text))
        lines.append('- **通知**:')
        for t, pkg, title, text in unique_notifies:
            pkg_short = pkg.split('.')[-1] if '.' in pkg else pkg
            title_part = f'[{title}] ' if title else ''
            lines.append(f'  - {t} {pkg_short}: {title_part}{text}')
    return lines


def _section_inputs(data):
    """输入行（设备维度优先）"""
    lines = []
    # 输入
    device_inputs = data.get('device_inputs', [])
    if device_inputs:
        for dev, (t, text) in device_inputs:
            dev_suffix = f'[{dev}]' if dev else ''
            lines.append(f'- **输入**: {t} "{text}" {dev_suffix}'.strip())
    elif data['inputs']:
        for t, text in data['inputs']:
            lines.append(f'- **输入**: {t} "{text}"')
    return lines


def _section_web_messages(data):
    """用户网页消息行（设备维度优先）"""
    lines = []
    # 用户网页消息
    device_web_messages = data.get('device_web_messages', [])
    if device_web_messages:
        for dev, (t, text) in device_web_messages:
            dev_suffix = f'[{dev}]' if dev else ''
            lines.append(f'- **用户消息**: {t} "{text}" {dev_suffix}'.strip())
    elif data['web_messages']:
        for t, text in data['web_messages']:
            lines.append(f'- **用户消息**: {t} "{text}"')
    return lines


def _section_task_triggers(data):
    """任务触发行（设备维度优先，去重）"""
    lines = []
    # 任务触发（设备维度优先）
    device_task_triggers = data.get('device_task_triggers', [])
    if device_task_triggers:
        # 按设备分组，去重
        dev_groups = {}
        for dev, (t, text) in device_task_triggers:
            key = f'{t}:{text[:30]}'
            if dev not in dev_groups:
                dev_groups[dev] = {'seen': set(), 'items': []}
            if key not in dev_groups[dev]['seen']:
                dev_groups[dev]['seen'].add(key)
                dev_groups[dev]['items'].append((t, text))
        for dev in sorted(dev_groups.keys(), key=lambda x: (x == '', x)):
            for t, text in dev_groups[dev]['items']:
                dev_prefix = f'[{dev}] ' if dev else ''
                lines.append(f'- **任务触发**: {dev_prefix}{t} {text}')
    elif data['task_triggers']:
        for t, text in data['task_triggers']:
            lines.append(f'- **任务触发**: {t} {text}')
    return lines


def _section_pc_windows(data):
    """PC窗口行（设备维度优先，去重）"""
    lines = []
    # PC窗口（设备维度优先）
    device_pc_windows = data.get('device_pc_windows', [])
    if device_pc_windows:
        # 按设备分组，去重
        dev_groups = {}
        for dev, (t, proc, title) in device_pc_windows:
            key = f'{proc}:{title[:30]}'
            if dev not in dev_groups:
                dev_groups[dev] = {'seen': set(), 'items': []}
            if key not in dev_groups[dev]['seen']:
                dev_groups[dev]['seen'].add(key)
                title_str = f' ({title[:40]})' if title else ''
                dev_groups[dev]['items'].append((t, proc, title_str))
        pc_items = []
        for dev in sorted(dev_groups.keys(), key=lambda x: (x == '', x)):
            for t, proc, title_str in dev_groups[dev]['items']:
                dev_prefix = f'[{dev}] ' if dev else ''
                pc_items.append(f'{dev_prefix}{t} {proc}{title_str}'.strip())
        if pc_items:
            lines.append(f'- **PC窗口**: {" | ".join(pc_items)}')
    elif data['pc_windows']:
        # 去重显示（相同进程连续出现只记一次）
        seen_procs = set()
        pc_items = []
        for t, proc, title in data['pc_windows']:
            key = f'{proc}:{title[:30]}'
            if key not in seen_procs:
                seen_procs.add(key)
                title_str = f' ({title[:40]})' if title else ''
                pc_items.append(f'{t} {proc}{title_str}')
        if pc_items:
            lines.append(f'- **PC窗口**: {" | ".join(pc_items)}')
    return lines


def _section_pc_idle(data):
    """PC待机行"""
    lines = []
    # PC待机
    if data['pc_idle'] is not None:
        if data['pc_idle'] == 'idle':
            secs = data.get('pc_idle_seconds') or 0
            min_str = f'{int(secs/60)}分' if secs >= 60 else f'{secs}秒'
            lines.append(f'- **PC待机**: 待机中（{min_str}）')
        else:
            lines.append(f'- **PC待机**: 活跃')
    return lines


def _section_balances(data):
    """DeepSeek 余额记录行"""
    lines = []
    # DeepSeek 余额记录（每累计消耗5元一条）
    if data['balances']:
        bal_parts = [f'{t} {bal}{cur}' for t, bal, cur in data['balances']]
        lines.append(f'- **DeepSeek余额**: {" | ".join(bal_parts)}')
    return lines


def _section_hr_snapshot(is_merged, hr_snap_str):
    """HR快照行（合并时段专用）"""
    lines = []
    # HR快照（合并时段专用）
    if is_merged and hr_snap_str:
        lines.append(f'- **HR快照**: {hr_snap_str}')
    return lines


def _section_sleep_stages(sleep_data, slot_start, slot_end):
    """睡眠阶段行（来自health.json；sleep_sessions 存在时逐会话拼接）"""
    lines = []
    # 睡眠阶段（来自health.json）
    if sleep_data:
        sessions = sleep_data.get('sleep_sessions') or []
        session_stages = []
        for session in sessions:
            if isinstance(session, dict):
                session_stages.extend(session.get('stages') or [])
        raw_stages = session_stages or sleep_data.get('stages', []) or []
        stages = []
        seen = set()
        for st in raw_stages:
            if not isinstance(st, dict):
                continue
            t = _stage_hm(st)
            stage = st.get('stage', '')
            key = (t, stage)
            if not t or key in seen:
                continue
            seen.add(key)
            stages.append(key)
        if stages:
            slot_start_min = parse_time_to_minutes(slot_start)
            slot_end_min = parse_time_to_minutes(slot_end)
            if slot_start_min is not None and slot_end_min is not None:
                matched = []
                for t, stage in stages:
                    st_min = parse_time_to_minutes(t)
                    if st_min is not None:
                        if slot_start_min <= slot_end_min:
                            if slot_start_min <= st_min < slot_end_min:
                                matched.append((t, stage))
                        else:
                            # 跨午夜（如 23:00~06:00）
                            if st_min >= slot_start_min or st_min < slot_end_min:
                                matched.append((t, stage))
                if matched:
                    stage_parts = [f'{stage}({t})' for t, stage in matched]
                    lines.append(f'- **睡眠阶段**: {" ".join(stage_parts)}')
    return lines


def build_section_markdown(slot_start, slot_end, data, health_samples=None, is_merged=False, hr_snap_str='', sleep_data=None, date_str='', device_name=None, deepdive_map=None):
    """构建单个时段的Markdown文本"""
    lines = []

    # 时段标题：如果有多设备，在标题后标注设备来源
    device_tag = f' | {device_name}' if device_name else ''
    if is_merged:
        lines.append(f'## {slot_start}~{slot_end} -- 睡眠（合并时段，HR快照附后）{device_tag}')
    else:
        lines.append(f'## {slot_start}~{slot_end}{device_tag}')

    lines.extend(_section_location(data))
    lines.extend(_section_physio(data, slot_start, slot_end, health_samples, is_merged))
    lines.extend(_section_screen(data))
    lines.extend(_section_voice_timeline(data, deepdive_map))
    lines.extend(_section_moss_ambient(deepdive_map, data, slot_start, slot_end))
    lines.extend(_section_acoustics(data))
    lines.extend(_section_music(data))
    lines.extend(_section_apps(data))
    lines.extend(_section_alive(data))
    lines.extend(_section_notify(data))
    lines.extend(_section_inputs(data))
    lines.extend(_section_web_messages(data))
    lines.extend(_section_task_triggers(data))
    lines.extend(_section_pc_windows(data))
    lines.extend(_section_pc_idle(data))
    lines.extend(_section_balances(data))
    lines.extend(_section_hr_snapshot(is_merged, hr_snap_str))
    lines.extend(_section_sleep_stages(sleep_data, slot_start, slot_end))

    lines.append('')
    return '\n'.join(lines)


# 设备特有列表字段：合并时自动为每个元素标注设备名（元素为元组/列表）
DEVICE_AWARE_LIST_FIELDS = ['screen_times', 'apps', 'medias', 'notifies', 'inputs', 'web_messages', 'task_triggers', 'pc_windows']
# 设备特有标量字段：合并时按设备分别记录
DEVICE_AWARE_SCALAR_FIELDS = ['battery', 'phone_battery']
# 标量字段命名映射（字段名 -> 设备维度字段名，保持兼容现有命名）
DEVICE_SCALAR_FIELD_NAMES = {
    'battery': 'device_batteries',
    'phone_battery': 'device_phone_batteries',
}


def build_merged_data(slots_sublist):
    """合并多个安静时段的数据"""
    merged = {
        'gps': None,
        'gps_location': None,
        'gps_time': None,
        'hr_values': [],
        'battery': None,
        'phone_battery': None,
        'screen_locked': None,
        'screen_times': [],
        # heartbeat：合并时计数累加、最后已知前台应用取最后非空值
        'heartbeat_count': 0,
        'current_app': None,
        'voice_timeline': [],
        'apps': [],
        'medias': [],
        'notifies': [],
        'inputs': [],
        'web_messages': [],
        'task_triggers': [],
        'wifi_connected': None,
        'pc_windows': [],
        'pc_idle': None,
        'pc_idle_seconds': None,
        'balances': [],
        'device_names': set(),
        'device_agent_ids': set(),
    }
    # 设备维度字段（清单驱动初始化）
    for f in DEVICE_AWARE_SCALAR_FIELDS:
        merged[DEVICE_SCALAR_FIELD_NAMES[f]] = []
    for f in DEVICE_AWARE_LIST_FIELDS:
        merged['device_' + f] = []
    for sk, d in slots_sublist:
        merged['voice_timeline'].extend(d['voice_timeline'])
        merged['hr_values'].extend(d['hr_values'])
        merged['apps'].extend(d.get('apps', []))
        merged['medias'].extend(d.get('medias', []))
        merged['notifies'].extend(d.get('notifies', []))
        merged['inputs'].extend(d.get('inputs', []))
        merged['web_messages'].extend(d.get('web_messages', []))
        merged['task_triggers'].extend(d.get('task_triggers', []))
        if d['battery'] is not None:
            merged['battery'] = d['battery']
        if d['phone_battery'] is not None:
            merged['phone_battery'] = d['phone_battery']
        if d['gps']:
            merged['gps'] = d['gps']
            merged['gps_location'] = d['gps_location']
        if d.get('gps_time'):
            merged['gps_time'] = d['gps_time']
        if d['screen_locked'] is not None:
            merged['screen_locked'] = d['screen_locked']
            merged['screen_times'].extend(d['screen_times'])
        merged['heartbeat_count'] += d.get('heartbeat_count', 0)
        if d.get('current_app'):
            merged['current_app'] = d['current_app']
        if d['wifi_connected'] is not None:
            merged['wifi_connected'] = d['wifi_connected']
        if d['pc_windows']:
            merged['pc_windows'].extend(d['pc_windows'])
        if d['pc_idle'] is not None:
            merged['pc_idle'] = d['pc_idle']
            merged['pc_idle_seconds'] = d.get('pc_idle_seconds')
        if d.get('balances'):
            merged['balances'].extend(d['balances'])
        if d.get('device_names'):
            merged['device_names'].update(d['device_names'])
        if d.get('device_agent_ids'):
            merged['device_agent_ids'].update(d['device_agent_ids'])

        # 提取设备名（从 device_names 取第一个，空则用 ''）
        dev = next(iter(d.get('device_names') or set()), '')

        # 设备维度数据收集（清单驱动）
        # 标量字段：按设备分别记录
        for f in DEVICE_AWARE_SCALAR_FIELDS:
            if d.get(f) is not None:
                merged[DEVICE_SCALAR_FIELD_NAMES[f]].append((dev, d[f]))
        # 列表字段：每个元素整体作为一项，保留原结构
        for f in DEVICE_AWARE_LIST_FIELDS:
            for item in d.get(f, []):
                merged['device_' + f].append((dev, item))

    return merged


def build_hr_snapshots(health_samples, start_slot, end_slot):
    """为合并时段构建HR快照（每30分钟一个）"""
    start_sec = seconds_since_midnight(start_slot + ':00')
    end_sec = seconds_since_midnight(end_slot + ':59')
    snapshots = []
    current_sec = (start_sec // 1800) * 1800
    while current_sec <= end_sec:
        h = current_sec // 3600
        m = (current_sec % 3600) // 60
        time_str = f'{h:02d}:{m:02d}'
        hr_info = get_health_hr_at_time(health_samples, time_str + ':00')
        if hr_info:
            spo2_info = get_health_spo2_at_time(health_samples, time_str + ':00')
            part = f'{hr_info[0]} HR={hr_info[1]}'
            if spo2_info:
                part += f' SpO2={spo2_info[1]}%'
            snapshots.append(part)
        current_sec += 1800
    return ', '.join(snapshots)


# ============================================================
# TASK 1: 分时段合并写入（修复 --hours 覆盖丢数据 bug）
# ============================================================


def _parse_existing_fact_file(filepath):
    """解析现有事实文件，返回 (header_lines, [(title, body_lines)])。

    标题行即 `## HH:MM~HH:MM[ 后缀]` 开头的一行；body 为该标题之后到下一个标题或
    文件结束之间的行。尾部 `---` 统计行会被丢弃（合并后重新生成）。
    """
    header = []
    sections = []
    current_title = None
    current_body = []
    with open(filepath, 'r', encoding='utf-8') as f:
        raw_lines = f.read().split('\n')
    for ln in raw_lines:
        if ln.startswith('## '):
            if current_title is not None:
                sections.append((current_title, current_body))
            current_title = ln[3:].strip()
            current_body = []
        else:
            if current_title is None:
                header.append(ln)
            else:
                current_body.append(ln)
    if current_title is not None:
        # 去掉 body 末尾的 `---` 统计行
        body = current_body
        for idx, b in enumerate(body):
            if b.strip() == '---':
                body = body[:idx]
                break
        sections.append((current_title, body))
    return header, sections


def _section_start_minutes(title):
    """从时段标题提取开始时间的分钟数（用于排序）"""
    m = re.match(r'(\d{1,2}:\d{2})', title.strip())
    if m:
        v = parse_time_to_minutes(m.group(1) + ':00')
        if v is not None:
            return v
    return 0


def merge_fact_sections(existing_path, new_sections):
    """将本次生成的段落与现有事实文件合并，仅替换同键（时段+设备）段落。

    Args:
        existing_path: 现有事实文件路径（须已存在）
        new_sections: 本次运行生成的完整段落 markdown 字符串列表

    Returns:
        (header_lines, merged_titles, merged_bodies):
            header_lines: 新头部行列表（保留原文件第一行标题，其余重生成）
            merged_titles: 合并后按时间排序的标题行列表
            merged_bodies: 与标题对应的 body 行列表
    """
    old_header, old_sections = _parse_existing_fact_file(existing_path)
    # 新段落解析为 (title, body字符串) 列表
    new_parsed = []
    for sec in new_sections:
        parts = sec.split('\n', 1)
        title = parts[0][3:].strip() if parts[0].startswith('## ') else ''
        body = parts[1] if len(parts) > 1 else ''
        if title:
            new_parsed.append((title, body))
    new_titles = {x[0] for x in new_parsed}
    # 保留未被本次覆盖的旧段落（旧 body 为行列表，统一转字符串）
    merged = []
    for t, b in old_sections:
        if t not in new_titles:
            body_str = b if isinstance(b, str) else '\n'.join(b)
            merged.append((t, body_str))
    merged.extend(new_parsed)
    # 按时段开始时间排序（跨午夜段 start 分钟数较大自然靠后）
    merged.sort(key=lambda x: _section_start_minutes(x[0]))
    merged_titles = [t for t, _ in merged]
    merged_bodies = [b for _, b in merged]
    return old_header, merged_titles, merged_bodies


def render_fact_markdown(date_str, coverage, titles, bodies, total_voice_count=None):
    """按事实文件格式渲染完整 markdown 文本"""
    now = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
    md_lines = [f'# {date_str} 事实数据', '']
    md_lines.append(f'> 生成时间: {now}')
    md_lines.append(f'> 数据覆盖: {coverage}')
    md_lines.append('')
    for t, b in zip(titles, bodies):
        md_lines.append(f'## {t}')
        if b:
            md_lines.append(b)
        md_lines.append('')
    md_lines.append('---')
    if total_voice_count is not None:
        md_lines.append(f'共 {len(titles)} 个时段，{total_voice_count} 条语音')
    else:
        md_lines.append(f'共 {len(titles)} 个时段')
    md_lines.append('')
    return '\n'.join(md_lines)


# ============================================================
# TASK 2b: 当日进度摘要维护（从批次文件提取综合判断/关键观察）
# ============================================================


SUMMARY_MAX_CHARS = 24000
SUMMARY_MAX_BYTES = 24000
BATCH_INDEX_MAX_CHARS = 4000
BATCH_INDEX_MAX_BYTES = 4000
SUMMARY_ITEM_MAX_CHARS = 200
SUMMARY_SECTION_MAX_CHARS = 1200
SUMMARY_BATCH_JUDGEMENT_CHARS = 90
SUMMARY_BATCH_OBS_CHARS = 60
BATCH_INDEX_JUDGEMENT_CHARS = 100
BATCH_INDEX_OBS_CHARS = 60
SUMMARY_SCALES = (1.0, 0.8, 0.65, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0)
INDEX_SCALES = (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0)


def _clip_text(text, limit):
    """把 text 截断到 limit 字符（超长时末字符用省略号收口）。"""
    text = (text or '').strip()
    if limit <= 0:
        return ''
    if len(text) <= limit:
        return text
    if limit == 1:
        return text[:1]
    return text[:limit - 1].rstrip() + '…'


def _truncate_doc(text, max_chars, marker, max_bytes=None):
    """按字符上限与可选 UTF-8 字节上限截断文档，末尾追加 marker。"""
    within_chars = len(text) <= max_chars
    within_bytes = max_bytes is None or len(text.encode('utf-8')) <= max_bytes
    if within_chars and within_bytes:
        return text
    tail = '\n\n' + marker
    keep = max_chars - len(tail)
    if max_bytes is not None:
        byte_budget = max_bytes - len(tail.encode('utf-8'))
        if byte_budget <= 0:
            return tail.lstrip('\n')[:max_chars]
        low, high = 0, max(keep, 0)
        while low < high:
            mid = (low + high + 1) // 2
            if len(text[:mid].encode('utf-8')) <= byte_budget:
                low = mid
            else:
                high = mid - 1
        keep = min(keep, low)
    if keep <= 0:
        return tail.lstrip('\n')[:max_chars]
    return text[:keep].rstrip() + tail


def _split_subblocks(body):
    """按 `#### 子标题` 切分段落 body，返回 [(subtitle, subbody), ...]。

    没有 `####` 时返回 [('', body)]。首个 `####` 之前的导语若非空，
    作为独立子块（subtitle=''）保留，避免丢失全窗级【综合判断】。
    """
    blocks = []
    subtitle = ''
    buf = []
    for ln in body.split('\n'):
        m = re.match(r'^####\s+(.+?)\s*$', ln)
        if m:
            subbody = '\n'.join(buf)
            if subtitle or subbody.strip():
                blocks.append((subtitle, subbody))
            subtitle = m.group(1).strip()
            buf = []
        else:
            buf.append(ln)
    subbody = '\n'.join(buf)
    if subtitle or subbody.strip():
        blocks.append((subtitle, subbody))
    return blocks or [('', body)]


def _extract_section_block(body, max_obs=3, item_max_chars=SUMMARY_ITEM_MAX_CHARS,
                           section_max_chars=SUMMARY_SECTION_MAX_CHARS):
    """从理解段落 body 提取 (综合判断, 关键观察要点列表)。

    判断与每条观察截断到 item_max_chars，返回内容合计不超过 section_max_chars。
    兼容 `#### 【综合判断】` / `**【综合判断】**` 等带前缀写法（各批次格式漂移）。
    """
    judgement = ''
    observations = []
    lines = body.split('\n')
    for i, ln in enumerate(lines):
        key = re.sub(r'^[#\s*>]+', '', ln)
        if not key.startswith('【综合判断】'):
            continue
        rest = key[len('【综合判断】'):].strip().strip('*').strip()
        if rest:
            judgement = rest
        else:
            parts = []
            for j in range(i + 1, len(lines)):
                nxt = lines[j].strip()
                if nxt.startswith('【'):
                    break
                if nxt:
                    parts.append(nxt)
            judgement = ' '.join(parts)
        break

    in_obs = False
    for ln in lines:
        s = re.sub(r'^[#\s*>]+', '', ln.strip())
        if s.startswith('【关键观察】'):
            in_obs = True
            rest = s[len('【关键观察】'):].strip().strip('*').strip()
            if rest.startswith(('-', '•')):
                observations.append(rest.lstrip('-• ').strip())
            continue
        if s.startswith('【'):
            in_obs = False
            continue
        if not in_obs:
            continue
        bullet = re.match(r'^(?:[-•]|\d+[.、])\s*(.+)$', s)
        if bullet:
            observations.append(bullet.group(1).strip())
            if len(observations) >= max_obs:
                break

    judgement = _clip_text(judgement, item_max_chars)
    clipped = [_clip_text(o, item_max_chars) for o in observations[:max_obs]]
    kept = []
    used = len(judgement)
    for obs in clipped:
        remaining = section_max_chars - used - (1 if kept else 0)
        if remaining <= 0:
            break
        kept.append(_clip_text(obs, remaining))
        used += len(kept[-1]) + (1 if len(kept) > 1 else 0)
    return judgement, kept


def _iter_time_sections(content):
    """迭代批次文件中的 `## HH:MM~HH:MM` 段，产出 (title, body, line_no)。"""
    lines = content.replace('\r\n', '\n').split('\n')
    idx = 0
    while idx < len(lines):
        m = re.match(r'^##\s+(\d{1,2}:\d{2}\s*~\s*\d{1,2}:\d{2}.*)$', lines[idx])
        if not m:
            idx += 1
            continue
        title = m.group(1)
        line_no = idx + 1  # 1-based
        body_lines = []
        idx += 1
        while idx < len(lines) and not lines[idx].startswith('## '):
            body_lines.append(lines[idx])
            idx += 1
        yield title, '\n'.join(body_lines), line_no


def _collect_batch_files(date_str, daily_dir):
    batch_files = []
    if os.path.isdir(daily_dir):
        for fname in os.listdir(daily_dir):
            m = re.match(rf'^理解-{date_str}-批次-(\d{{2}})\.md$', fname)
            if m:
                batch_files.append((int(m.group(1)), fname))
    batch_files.sort()
    return batch_files


def _render_summary_batch(hh, sections, limits):
    """渲染单批摘要：保留全部时段，每个子块仅留 1 条观察。"""
    judgement_limit, obs_limit = limits
    lines = [f'## 批{hh:02d}']
    for title, body, _line_no in sections:
        lines.append(f'### {title}')
        seg_no = 0
        for subtitle, subbody in _split_subblocks(body):
            judgement, observations = _extract_section_block(
                subbody,
                max_obs=1,
                item_max_chars=max(judgement_limit, obs_limit, 1),
                section_max_chars=max(judgement_limit + obs_limit, 1),
            )
            judgement = _clip_text(judgement, judgement_limit)
            observation = _clip_text(observations[0], obs_limit) if observations else ''
            if not judgement and not observation:
                continue
            label = ''
            if subtitle:
                seg_no += 1
                label = f'[段{seg_no}] '
            entry = f'- {label}综合判断: {judgement or "(缺失)"}'
            if observation:
                entry += f'；关键观察: {observation}'
            lines.append(entry)
    return '\n'.join(lines)


def _render_summary_batch_fitted(hh, sections, byte_budget):
    """在单批字节预算内逐级压缩每段内容，绝不丢弃批次或时段。"""
    text = ''
    for scale in SUMMARY_SCALES:
        limits = (
            int(SUMMARY_BATCH_JUDGEMENT_CHARS * scale),
            int(SUMMARY_BATCH_OBS_CHARS * scale),
        )
        text = _render_summary_batch(hh, sections, limits)
        if len(text.encode('utf-8')) <= byte_budget:
            break
    return text


def update_daily_summary(date_str, daily_dir=None):
    """更新当日进度摘要文件：读取该日所有 `理解-{date}-批次-{HH}.md`，提取
    各时段（含 `#### 段N` 子块）的【综合判断】+【关键观察】压缩为紧凑条目。

    先按批次数分配 SUMMARY_MAX_BYTES 预算，每批内逐级压缩每段；全局再按
    SUMMARY_MAX_CHARS / SUMMARY_MAX_BYTES 双上限兜底，保证不截掉尾部批次。
    返回摘要 markdown 文本（只返回字符串，不写文件）。
    """
    if daily_dir is None:
        daily_dir = os.path.join(_SCRIPT_DIR, '..', 'data', 'daily', date_str)
    batch_files = _collect_batch_files(date_str, daily_dir)
    header_lines = ['<!-- summary-v2 -->', f'# {date_str} 当日进度摘要', '']
    header_lines.append('> 程序自动维护，每批次更新。供晚批次 data-check 跨时段关联与复盘主读'
                        '使用（不替代完整批次文件）。')
    header_lines.append(f'> 更新于: {datetime.now().strftime("%Y-%m-%dT%H:%M:%S")}')
    header_lines.append('')
    header_text = '\n'.join(header_lines)
    if not batch_files:
        return _truncate_doc(
            header_text + '\n（暂无批次文件）',
            SUMMARY_MAX_CHARS, '<!-- summary truncated: see batch files -->',
            max_bytes=SUMMARY_MAX_BYTES)
    batch_count = len(batch_files)
    byte_budget = (SUMMARY_MAX_BYTES - len(header_text.encode('utf-8'))
                   - batch_count) // batch_count
    byte_budget = max(byte_budget, 1)
    parts = [header_text]
    for hh, fname in batch_files:
        fpath = os.path.join(daily_dir, fname)
        try:
            with open(fpath, 'r', encoding='utf-8') as f:
                content = f.read()
            sections = list(_iter_time_sections(content))
        except OSError:
            sections = []
        parts.append(_render_summary_batch_fitted(hh, sections, byte_budget))
    return _truncate_doc('\n'.join(parts), SUMMARY_MAX_CHARS,
                         '<!-- summary truncated: see batch files -->',
                         max_bytes=SUMMARY_MAX_BYTES)


def _index_cell(text):
    """把内容压成单行表格单元（转义竖线）。"""
    return text.replace('|', '\\|').replace('\n', ' ').strip()


def _batch_index_fields(sections):
    """提取单批索引字段：(时段跨度, 首个判断, 首条观察, 首个段标题行号)。"""
    first_judgement = ''
    first_observation = ''
    first_line_no = sections[0][2] if sections else 0
    span_start = span_end = ''
    for title, body, _line_no in sections:
        m = re.match(r'^(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})', title)
        if m:
            if not span_start:
                span_start = m.group(1)
            span_end = m.group(2)
        for _subtitle, subbody in _split_subblocks(body):
            judgement, observations = _extract_section_block(
                subbody, max_obs=1,
                item_max_chars=SUMMARY_ITEM_MAX_CHARS,
                section_max_chars=SUMMARY_SECTION_MAX_CHARS)
            if not first_judgement and judgement:
                first_judgement = judgement
            if not first_observation and observations:
                first_observation = observations[0]
    span = f'{span_start}~{span_end}' if span_start and span_end else '-'
    return span, first_judgement, first_observation, first_line_no


def _render_batch_index(header_lines, rows, limits):
    """渲染每批一行的索引表（全部批次行始终保留）。"""
    judgement_limit, obs_limit = limits
    lines = list(header_lines)
    lines.append('| HH | 时段跨度 | 判断 | 关键观察 | 来源 |')
    lines.append('| --- | --- | --- | --- | --- |')
    for hh, fname, span, judgement, observation, line_no in rows:
        judgement_cell = _index_cell(
            _clip_text(judgement or '(缺失)', judgement_limit))
        observation_cell = _index_cell(
            _clip_text(observation, obs_limit)) if observation else '-'
        lines.append(
            f'| {hh:02d} | {span} | {judgement_cell} | {observation_cell} | {fname}:{line_no} |')
    return '\n'.join(lines)


def update_batch_index(date_str, daily_dir=None):
    """生成当日批次索引：每批一行，附该批首个段标题的实际行号。

    先按 BATCH_INDEX_MAX_BYTES 逐级压缩判断/观察，全部批次行始终保留；
    最后按 BATCH_INDEX_MAX_CHARS / BATCH_INDEX_MAX_BYTES 双上限兜底。
    返回索引 markdown 文本（只返回字符串，不写文件）。
    """
    if daily_dir is None:
        daily_dir = os.path.join(_SCRIPT_DIR, '..', 'data', 'daily', date_str)
    batch_files = _collect_batch_files(date_str, daily_dir)
    header_lines = [f'# {date_str} 批次索引', '<!-- batch-index-v2 -->', '']
    header_lines.append('> 程序自动维护。每批一行；行号指向该批首个段标题（1-based），'
                        '用于回查原文（不替代完整批次文件）。')
    header_lines.append('')
    if not batch_files:
        return _truncate_doc(
            '\n'.join(header_lines + ['（暂无批次文件）']),
            BATCH_INDEX_MAX_CHARS, '<!-- batch index truncated -->',
            max_bytes=BATCH_INDEX_MAX_BYTES)
    rows = []
    for hh, fname in batch_files:
        fpath = os.path.join(daily_dir, fname)
        try:
            with open(fpath, 'r', encoding='utf-8') as f:
                content = f.read()
            sections = list(_iter_time_sections(content))
        except OSError:
            sections = []
        span, judgement, observation, line_no = _batch_index_fields(sections)
        rows.append((hh, fname, span, judgement, observation, line_no))
    text = ''
    for scale in INDEX_SCALES:
        limits = (
            int(BATCH_INDEX_JUDGEMENT_CHARS * scale),
            int(BATCH_INDEX_OBS_CHARS * scale),
        )
        text = _render_batch_index(header_lines, rows, limits)
        if len(text.encode('utf-8')) <= BATCH_INDEX_MAX_BYTES:
            break
    return _truncate_doc(text, BATCH_INDEX_MAX_CHARS,
                         '<!-- batch index truncated -->',
                         max_bytes=BATCH_INDEX_MAX_BYTES)


# ============================================================
# TASK 2c: 健康清单生成（仅 health.json 程序统计，不含模式提及）
# ============================================================


def _sleep_window_minutes(hd):
    """从 sleep_data stages 推导睡眠时间窗（分钟数）。

    取首末 stage 的时间点；无 stages 时退回夜间 22:00~08:00。
    返回 (lo_min, hi_min)，跨午夜窗口用 lo>hi 表示。
    """
    sd = hd.get('sleep_data', {}) if isinstance(hd, dict) else {}
    stages = sd.get('stages', []) if isinstance(sd, dict) else []
    if stages:
        lo = parse_time_to_minutes(stages[0].get('t', ''))
        hi = parse_time_to_minutes(stages[-1].get('t', ''))
        if lo is not None and hi is not None:
            return lo, hi
    return 22 * 60, 8 * 60


def _t_iso_minute(t_iso):
    """从 t_iso（'YYYY-MM-DD HH:MM:SS'）提取时间分钟数，解析失败返回 None。"""
    if not t_iso:
        return None
    m = re.match(r'^\d{4}-\d{2}-\d{2} (\d{2}):(\d{2})', str(t_iso))
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def _minute_in_window(m, lo, hi):
    """判断分钟数 m 是否落在睡眠时间窗内（lo>hi 表示跨午夜）。m 为 None 时不命中。"""
    if m is None:
        return False
    if lo <= hi:
        return lo <= m < hi
    return m >= lo or m < hi


def _manifest_load_health_by_day(days, daily_dir):
    """预加载各天健康数据（P2-V11: 分片合成视图优先，派生文件回落；含解析失败容错）"""
    health_by_day = {}
    for d in days:
        ds = d.strftime('%Y-%m-%d')
        hd = read_health_view(ds)
        if hd is None:
            hp = os.path.join(daily_dir, ds, 'health.json')
            hd = None
            if os.path.exists(hp):
                try:
                    with open(hp, 'r', encoding='utf-8') as f:
                        hd = json.load(f)
                except Exception:
                    hd = None
        health_by_day[ds] = hd
    return health_by_day


def _stage_gap_minutes(t_a, t_b):
    """两个 HH:MM 之间的分钟差（跨零点按 +24h 处理）；解析失败返回 None。"""
    try:
        ha, ma = [int(x) for x in str(t_a).split(':')[:2]]
        hb, mb = [int(x) for x in str(t_b).split(':')[:2]]
    except (TypeError, ValueError):
        return None
    a, b = ha * 60 + ma, hb * 60 + mb
    if b < a:
        b += 24 * 60
    return b - a


def _manifest_sleep_section(health_by_day):
    """睡眠统计段落（近 7 天，来自 sleep_data）

    新格式（后端 2026-10-27 修复后）：sleep_sessions 存主觉＋小睡，顶层字段取最长主觉，
    stages 段标签为 deep/light/rem/awake 的真值。
    旧格式回落：无 sleep_sessions/awake_count，沿用「rem 段＝清醒、awake 段＝REM」的三修
    临时映射，总睡眠min 记 `-`（旧顶层 duration 可能来自小睡，不可信）。
    """
    lines = []
    lines.append('## 睡眠统计（近 7 天）')
    lines.append('')
    lines.append('| 日期 | 格式 | 入睡 | 起床 | 总睡眠min | 清醒次 | 清醒min | 深睡min | 浅睡min | REM min | 小睡 |')
    lines.append('|------|------|------|------|-----------|--------|---------|---------|---------|---------|------|')
    fmt = lambda v: str(v) if v is not None else '-'
    for ds, hd in health_by_day.items():
        sd = (hd or {}).get('sleep_data', {}) or {}
        stages = sd.get('stages', []) or []
        sessions = sd.get('sleep_sessions') or []
        awake_count = sd.get('awake_count')
        if sessions or awake_count is not None:
            # 新格式：顶层镜像最长主觉，sleep_sessions 另存主觉与小睡
            bedtime = _epoch_hm(sd.get('bedtime'))
            if not bedtime and stages:
                bedtime = _stage_hm(stages[0])
            wakeup = _epoch_hm(sd.get('wakeup_time'))
            if not wakeup and stages:
                wakeup = _stage_hm(stages[-1])
            durations = [
                int(s.get('duration'))
                for s in sessions
                if isinstance(s, dict) and isinstance(s.get('duration'), (int, float))
            ]
            naps = []
            if durations:
                main_duration = max(durations)
                primary_skipped = False
                for duration in durations:
                    if not primary_skipped and duration == main_duration:
                        primary_skipped = True
                        continue
                    naps.append(str(duration))
            row = [
                ds, '新', bedtime or '-', wakeup or '-',
                fmt(sd.get('duration_min')), fmt(awake_count),
                fmt(sd.get('awake_min')), fmt(sd.get('deep_min')),
                fmt(sd.get('light_min')), fmt(sd.get('rem_min')),
                '+'.join(naps) if naps else '-',
            ]
        elif sd:
            # 旧格式回落：三修口径 —— stages 的 rem 段＝清醒、awake 段＝REM
            bedtime = _stage_hm(stages[0]) if stages else ''
            wakeup = _stage_hm(stages[-1]) if stages else ''
            awake_n = len([st for st in stages if st.get('stage') == 'rem']) if stages else None
            awake_minutes = None
            if stages:
                awake_minutes = sum(
                    _stage_duration_min(stages, idx)
                    for idx, st in enumerate(stages)
                    if st.get('stage') == 'rem'
                )
            rem_min = sd.get('rem_min')
            if rem_min is None and stages:
                rem_min = sum(
                    _stage_duration_min(stages, idx)
                    for idx, st in enumerate(stages)
                    if st.get('stage') == 'awake'
                )
            row = [
                ds, '旧', bedtime or '-', wakeup or '-', '-',
                fmt(awake_n), fmt(awake_minutes), fmt(sd.get('deep_min')),
                fmt(sd.get('light_min')), fmt(rem_min), '-',
            ]
        else:
            row = [ds, '-', '-', '-', '-', '-', '-', '-', '-', '-', '-']
        lines.append('| ' + ' | '.join(row) + ' |')
    lines.append('')
    lines.append('> **口径（2026-10-27 后端修复后）**：`总睡眠min`＝深睡＋浅睡＋REM（**不含清醒**）；顶层字段取当日最长主觉，`sleep_sessions` 存主觉＋各次小睡，`小睡` 列列出非主觉各段时长。`格式=旧` 的行是后端回填前落盘的数据：清醒次／清醒min 仍按「`rem` 段＝清醒、`awake` 段＝REM」的临时映射计算，且旧顶层 `duration_min`／`wakeup_time` 可能来自小睡，故 `总睡眠min` 记 `-`，不可当新口径使用。')
    return lines


def _manifest_spo2_section(health_by_day):
    """SpO2 低值段落（近 7 天，仅统计睡眠期）"""
    lines = []
    # SpO2 低值（近 7 天，仅统计睡眠期）
    lines.append('## SpO2 低值（近 7 天）')
    lines.append('')
    has_spo2 = any(
        hd and any(sm.get('spo2') is not None for sm in hd.get('samples', []))
        for hd in health_by_day.values()
    )
    if not has_spo2:
        lines.append('（近 7 天 health.json 样本中均无 SpO2 字段，跳过）')
    else:
        lines.append('| 日期 | 夜间最低SpO2 | <95低值次数 | 说明 |')
        lines.append('|------|--------------|-------------|------|')
        for ds, hd in health_by_day.items():
            if not hd:
                lines.append(f'| {ds} | - | - | 无 health.json |')
                continue
            samples = hd.get('samples', [])
            spo2_list = [sm for sm in samples if sm.get('spo2') is not None]
            if not spo2_list:
                lines.append(f'| {ds} | - | - | 无 SpO2 采样 |')
                continue
            lo, hi = _sleep_window_minutes(hd)
            night_spo2 = [
                sm for sm in spo2_list
                if _minute_in_window(_t_iso_minute(sm.get('t_iso')), lo, hi)
            ]
            if not night_spo2:
                lines.append(f'| {ds} | - | - | 睡眠期无 SpO2 采样 |')
                continue
            night_min = min(sm['spo2'] for sm in night_spo2)
            low_n = sum(1 for sm in night_spo2 if sm['spo2'] < 95)
            min_sm = min(night_spo2, key=lambda sm: sm['spo2'])
            min_t = str(min_sm.get('t_iso', ''))[11:16]
            lines.append(f'| {ds} | {night_min}% | {low_n} | 最低点 {min_t} |')
    lines.append('')
    return lines


def _manifest_hr_spike_section(health_by_day):
    """HR 睡眠期尖峰段落（近 7 天，HR>90）"""
    lines = []
    # HR 睡眠期尖峰（近 7 天，HR>90 且落在睡眠窗内）
    lines.append('## HR 睡眠期尖峰（近 7 天，HR>90）')
    lines.append('')
    any_spike = False
    for ds, hd in health_by_day.items():
        if not hd:
            continue
        samples = hd.get('samples', [])
        hr_list = [sm for sm in samples if sm.get('hr') is not None]
        if not hr_list:
            continue
        lo, hi = _sleep_window_minutes(hd)
        spikes = [
            sm for sm in hr_list
            if sm['hr'] > 90 and _minute_in_window(_t_iso_minute(sm.get('t_iso')), lo, hi)
        ]
        if not spikes:
            continue
        any_spike = True
        lines.append(f'### {ds}')
        spikes_sorted = sorted(spikes, key=lambda sm: str(sm.get('t_iso', '')))[:5]
        for sm in spikes_sorted:
            t_disp = str(sm.get('t_iso', ''))[11:16]
            lines.append(f'- {t_disp} HR={sm["hr"]}')
        lines.append('')
    if not any_spike:
        lines.append('（近 7 天睡眠期未检测到 HR>90 尖峰）')
    lines.append('')
    return lines


def _manifest_sync_section(health_by_day):
    """手环同步状态段落（近 7 天）"""
    lines = []
    # 手环同步状态（近 7 天，覆盖范围取自样本首末时间）
    lines.append('## 手环同步状态（近 7 天）')
    lines.append('')
    for ds, hd in health_by_day.items():
        if not hd:
            lines.append(f'- {ds}: 缺失（无 health.json）')
            continue
        samples = hd.get('samples', [])
        if not samples:
            lines.append(f'- {ds}: 存在，但无样本数据')
            continue
        first_t = str(samples[0].get('t_iso', ''))[11:16]
        last_t = str(samples[-1].get('t_iso', ''))[11:16]
        lines.append(f'- {ds}: 存在，覆盖 {first_t}~{last_t}')
    lines.append('')
    return lines


def build_health_manifest(date_str):
    """生成健康清单：近 7 天 health.json 程序统计（睡眠/SpO2/HR尖峰/同步状态）。

    仅收录程序计算的机械统计（日期 + 数值 + 时间点），不含任何模式提及或解读。
    输出文件 `健康清单-{date}.md`，供数据检查/复盘子智能体直接引用。
    """
    target = datetime.strptime(date_str, '%Y-%m-%d')
    days = sorted(target - timedelta(days=i) for i in range(7))
    daily_dir = os.path.join(_SCRIPT_DIR, '..', 'data', 'daily')
    health_by_day = _manifest_load_health_by_day(days, daily_dir)

    lines = [f'# {date_str} 健康清单', '']
    lines.append('> 程序预生成，仅收录 health.json 程序统计（睡眠/SpO2/HR/同步状态），不含解读。')
    lines.append(f'> 生成于: {datetime.now().strftime("%Y-%m-%dT%H:%M:%S")}')
    lines.append('')

    lines.extend(_manifest_sleep_section(health_by_day))
    lines.extend(_manifest_spo2_section(health_by_day))
    lines.extend(_manifest_hr_spike_section(health_by_day))
    lines.extend(_manifest_sync_section(health_by_day))

    lines.append('> 说明：以上为程序从 health.json 直接统计的机械事实（含日期与数值）。'
                 '趋势如何解读、模式是否成立由子智能体结合多源数据判断，禁止直接照搬为结论。')
    return '\n'.join(lines)


def _print_usage():
    print('用法: python {AI目录}/analysis/fact_extractor.py <日期> [--hours <时段>] [--output <路径>] [--update-summary]', file=sys.stderr)
    print('示例:', file=sys.stderr)
    print('  python {AI目录}/analysis/fact_extractor.py 2026-06-14', file=sys.stderr)
    print('  python {AI目录}/analysis/fact_extractor.py 2026-06-14 --hours 06:00~14:00', file=sys.stderr)
    print('  python {AI目录}/analysis/fact_extractor.py 2026-06-14 --output out.md', file=sys.stderr)
    print('  python {AI目录}/analysis/fact_extractor.py 2026-06-14 --update-summary', file=sys.stderr)


def parse_args(argv):
    """解析命令行参数，返回 (date_str, time_range_str, output_path, update_summary_only)"""
    if len(argv) >= 2 and argv[1] in ('-h', '--help'):
        _print_usage()
        sys.exit(0)
    if len(argv) < 2:
        _print_usage()
        sys.exit(1)

    date_str = argv[1]
    time_range_str = None
    output_path = None
    update_summary_only = False

    i = 2
    while i < len(argv):
        if argv[i] == '--hours' and i + 1 < len(argv):
            time_range_str = argv[i + 1]
            i += 2
        elif argv[i] == '--output' and i + 1 < len(argv):
            output_path = argv[i + 1]
            i += 2
        elif argv[i] == '--update-summary':
            update_summary_only = True
            i += 1
        else:
            i += 1

    return date_str, time_range_str, output_path, update_summary_only


def compute_slot_line_range(output_path, time_range_str):
    """计算指定时段在事实文件中的行号范围并输出（仅 --hours 参数时调用）"""
    # 解析 time_range_str
    range_start_str, range_end_str = time_range_str.split('~')
    start_min = int(range_start_str[:2]) * 60 + int(range_start_str[3:5])
    end_min = int(range_end_str[:2]) * 60 + int(range_end_str[3:5])

    # 读取文件所有行
    with open(output_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    first_match_line = None  # 第一个匹配标题的行号（1-based）
    last_match_line = None   # 最后一个匹配标题的行号（1-based）
    last_match_end_line = None  # 最后一个匹配标题的内容结束行号

    for i, line in enumerate(lines):
        # 查找标题行 ## HH:MM~
        if line.startswith('## '):
            match = re.match(r'^## (\d{1,2}:\d{2})~', line)
            if match:
                title_start = match.group(1)
                t_min = int(title_start[:2]) * 60 + int(title_start[3:5])

                # 判断是否在范围内
                in_range = False
                if start_min <= end_min:
                    # 普通窗口
                    if start_min <= t_min <= end_min:
                        in_range = True
                else:
                    # 跨天窗口 (如 22:00~00:00): 只匹配 start_min 之后的时段（22:00~23:55）
                    # 凌晨 00:00 的段落属于"下一天凌晨"，不属于本窗口
                    if t_min >= start_min:
                        in_range = True

                if in_range:
                    if first_match_line is None:
                        first_match_line = i + 1  # 1-based
                    last_match_line = i + 1

    # 计算内容结束行
    if last_match_line is not None:
        # 找到最后一个匹配标题之后的下一个 ## 标题行
        last_match_idx = last_match_line - 1  # 转为 0-based
        content_end_line = len(lines)  # 默认到文件末尾
        for i in range(last_match_idx + 1, len(lines)):
            if lines[i].startswith('## '):
                content_end_line = i  # 下一个标题行的前一行
                break
        last_match_end_line = content_end_line

    # 输出结果
    if first_match_line is not None and last_match_end_line is not None:
        line_count = last_match_end_line - first_match_line + 1
        print(f'时段 [{time_range_str}] 行号: {first_match_line}~{last_match_end_line} (共{line_count}行)', file=sys.stderr)


def main():
    date_str, time_range_str, output_path, update_summary_only = parse_args(sys.argv)

    # 仅更新当日摘要 + 健康清单（不重写事实文件）
    if update_summary_only:
        daily_dir = os.path.join(_SCRIPT_DIR, '..', 'data', 'daily', date_str)
        os.makedirs(daily_dir, exist_ok=True)
        summary_md = update_daily_summary(date_str)
        summary_path = os.path.join(daily_dir, f'当日摘要-{date_str}.md')
        with open(summary_path, 'w', encoding='utf-8') as f:
            f.write(summary_md)
        index_md = update_batch_index(date_str)
        index_path = os.path.join(daily_dir, f'批次索引-{date_str}.md')
        with open(index_path, 'w', encoding='utf-8') as f:
            f.write(index_md)
        manifest_md = build_health_manifest(date_str)
        manifest_path = os.path.join(daily_dir, f'健康清单-{date_str}.md')
        with open(manifest_path, 'w', encoding='utf-8') as f:
            f.write(manifest_md)
        print(f'当日摘要: {summary_path}', file=sys.stderr)
        print(f'批次索引: {index_path}', file=sys.stderr)
        print(f'健康清单: {manifest_path}', file=sys.stderr)
        sys.exit(0)

    # 默认输出
    if not output_path:
        output_path = os.path.join(_SCRIPT_DIR, '..', 'data', 'daily', date_str, '事实-全天.md')

    print(f'加载感知数据: {date_str}', file=sys.stderr)
    events = load_perception(date_str)
    if events is None:
        sys.exit(1)

    # MOSS 深潜交叉参照（缺文件 → None，渲染层逐字节回退旧输出）
    deepdive_map = load_deepdive(date_str)

    health_data = load_health(date_str)
    health_samples = health_data.get('samples', [])
    sleep_data = health_data.get('sleep_data', {})

    print(f'原始事件: {len(events)}条', file=sys.stderr)
    if time_range_str:
        events = filter_events_by_time(events, time_range_str)
        print(f'时段过滤 [{time_range_str}]: {len(events)}条', file=sys.stderr)

    if not events:
        print('该时段无数据', file=sys.stderr)
        sys.exit(0)

    # 按5分钟时段分组
    slot_list = group_by_slot(events)
    print(f'时段数: {len(slot_list)}', file=sys.stderr)

    if not slot_list:
        print('无有效时段', file=sys.stderr)
        sys.exit(0)

    # 处理每个时段
    prev_state = {}
    processed_slots = []  # [(slot_key, [(device_key, data), ...])]
    total_voice_count = 0

    for sk, evts in slot_list:
        # 将同一时段的按设备分组
        device_events = {}  # device_key -> [events]
        for e in evts:
            dk = e.get('device_name') or e.get('_agent_id') or ''
            if dk not in device_events:
                device_events[dk] = []
            device_events[dk].append(e)
        # 空设备名排在最后
        device_items = sorted(device_events.items(), key=lambda x: (x[0] == '', x[0]))

        device_data_list = []
        for device_key, dev_evts in device_items:
            data = collect_slot_data(dev_evts, prev_state)
            device_data_list.append((device_key, data))
            total_voice_count += sum(1 for e in data['voice_timeline'] if e['type'] == 'speech')

        # prev_state 基于所有设备的总和数据（丢弃 device_data_list 中除第一个外的 prev_state）
        # 用第一个设备的数据更新 prev_state（非设备相关的全局状态）
        if device_data_list:
            data0 = device_data_list[0][1]
            prev_state = {
                'gps': data0['gps'],
                'gps_location': data0['gps_location'],
                'screen_locked': data0['screen_locked'],
                'current_app': data0.get('current_app'),
                'wifi_connected': data0['wifi_connected'],
                'pc_idle': data0['pc_idle'],
                'pc_idle_seconds': data0['pc_idle_seconds'],
            }
            if data0.get('device_names'):
                prev_state['device_names'] = data0['device_names']
            if data0.get('device_agent_ids'):
                prev_state['device_agent_ids'] = data0['device_agent_ids']

        processed_slots.append((sk, device_data_list))

    # 不再自动合并安静时段。每 5 分钟一段如实输出，睡眠与否由上层（理解子智能体）判断。
    # 原合并逻辑（is_quiet_slot + merge_ranges）已禁用，详见 Git 历史。
    merge_ranges = []

    # 构建输出段落
    used_indices = set()
    final_sections = []
    for mr_start, mr_end in merge_ranges:
        for idx in range(mr_start, mr_end + 1):
            used_indices.add(idx)

    def _emit_slot(sk, device_key, data, is_merged=False, hr_snap='', merge_start=None, merge_end=None):
        """生成单个设备单时段的 MD 段落"""
        end_display = format_slot_end(merge_end or sk)
        start_s = merge_start or sk
        return build_section_markdown(
            start_s, end_display, data, health_samples,
            is_merged=is_merged, hr_snap_str=hr_snap,
            sleep_data=sleep_data, date_str=date_str,
            device_name=device_key or None,
            deepdive_map=deepdive_map,
        )

    idx = 0
    while idx < len(processed_slots):
        in_merge = False
        for mr_start, mr_end in merge_ranges:
            if mr_start <= idx <= mr_end:
                if idx == mr_start:
                    sk_start = processed_slots[mr_start][0]
                    sk_end = processed_slots[mr_end][0]
                    end_display = format_slot_end(sk_end)
                    hr_snap_str = build_hr_snapshots(health_samples, sk_start, sk_end)

                    # 合并时段也按设备分类输出
                    device_keys_all = set()
                    for mi in range(mr_start, mr_end + 1):
                        _, ddl = processed_slots[mi]
                        for dk, _ in ddl:
                            device_keys_all.add(dk)
                    for dk in sorted(device_keys_all, key=lambda x: (x == '', x)):
                        # 收集该设备在所有被合并 slot 中的数据
                        merged_evts = []
                        for mi in range(mr_start, mr_end + 1):
                            _, ddl = processed_slots[mi]
                            for ddk, dd in ddl:
                                if ddk == dk:
                                    merged_evts.append((processed_slots[mi][0], dd))
                        if merged_evts:
                            merged_data = build_merged_data(merged_evts)
                            merged_data['device_names'] = {dk} if dk else set()
                            merged_data['device_agent_ids'] = set()
                            section_md = _emit_slot(sk_start, dk, merged_data,
                                                    is_merged=True, hr_snap=hr_snap_str,
                                                    merge_start=sk_start, merge_end=sk_end)
                            final_sections.append(section_md)
                idx = mr_end + 1
                in_merge = True
                break

        if not in_merge:
            sk = processed_slots[idx][0]
            _, ddl = processed_slots[idx]
            if len(ddl) == 1:
                # 只有一个设备，保持原逻辑
                device_key, data = ddl[0]
                section_md = _emit_slot(sk, device_key, data)
                final_sections.append(section_md)
            else:
                # 多个设备，合并为一个段落
                # 只保留非空设备名，保持原顺序
                device_names_sorted = [dk for dk, _ in ddl if dk]
                merged_device_name = '+'.join(device_names_sorted)

                # 构造 build_merged_data 需要的输入格式 [(sk, data), ...]
                merged_input = [(sk, data) for _, data in ddl]
                merged_data = build_merged_data(merged_input)

                section_md = _emit_slot(sk, merged_device_name, merged_data)
                final_sections.append(section_md)
            idx += 1

    # 生成最终Markdown
    now = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
    coverage = time_range_str if time_range_str else '全天'

    # TASK 1: 修复 --hours 覆盖丢数据 bug —— 部分运行时与既有文件合并
    # 仅替换本次覆盖的时段段落，保留其他时段；整日运行或无既有文件时全新生成。
    is_partial = bool(time_range_str)
    existing_exists = os.path.exists(output_path)
    if is_partial and existing_exists:
        old_header, merged_titles, merged_bodies = merge_fact_sections(output_path, final_sections)
        # 保留旧文件首行标题 `# {date} 事实数据`（若存在），覆盖信息更新为合并标记
        if old_header and old_header[0].startswith('# '):
            pass
        merged_coverage = f'全天（分批次合并，最新 {time_range_str}）'
        markdown = render_fact_markdown(date_str, merged_coverage, merged_titles, merged_bodies)
        final_count = len(merged_titles)
        print(f'增量合并: 保留既有时段 + 更新 {time_range_str} 时段', file=sys.stderr)
    else:
        md_lines = [f'# {date_str} 事实数据', '']
        md_lines.append(f'> 生成时间: {now}')
        md_lines.append(f'> 数据覆盖: {coverage}')
        md_lines.append('')
        md_lines.extend(final_sections)
        md_lines.append('---')
        md_lines.append(f'共 {len(final_sections)} 个时段，{total_voice_count} 条语音')
        md_lines.append('')
        markdown = '\n'.join(md_lines)
        final_count = len(final_sections)

    # 写入文件
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(markdown)

    print(f'\n输出文件: {output_path}', file=sys.stderr)
    print(f'共 {final_count} 个时段，{total_voice_count} 条语音', file=sys.stderr)

    # 计算时段在事实文件中的行号范围（仅当使用 --hours 参数时）
    if time_range_str:
        compute_slot_line_range(output_path, time_range_str)

    # 保存GPS缓存
    save_geo_cache()


if __name__ == '__main__':
    main()
