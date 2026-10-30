#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
时间线覆盖检查脚本

检测AI是否漏掉了某些时段的理解记录。
比较 perception.jsonl 中最晚事件时间和 理解.md 中最晚时段时间。

用法:
    python {AI目录}/analysis/check_coverage.py <日期>
    python {AI目录}/analysis/check_coverage.py <日期> --json
    python {AI目录}/analysis/check_coverage.py <日期> --quiet

退出码:
    0 = 通过 (覆盖完整)
    1 = 漏时段 (理解文件缺失或缺口超过2小时)
    2 = 数据不完整 (原始数据本身采集不完整)

依赖: 仅标准库
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_DATA_DIR = os.path.normpath(os.path.join(_SCRIPT_DIR, '..', 'data', 'daily'))

# 今日过滤的时钟偏差容差: 设备与服务器时钟存在秒级偏差, 实测有事件 t 略超当前时刻
FUTURE_GRACE_SECONDS = 600


def parse_time(t_str):
    """将 HH:MM:SS 或 HH:MM 格式的时间转换为秒数

    Args:
        t_str: 时间字符串, 如 "23:59:59" 或 "22:00"

    Returns:
        int: 从00:00:00开始的秒数, 解析失败返回 None
    """
    parts = t_str.strip().split(':')
    if len(parts) == 2:
        h, m = parts
        s = '0'
    elif len(parts) == 3:
        h, m, s = parts
    else:
        return None
    try:
        return int(h) * 3600 + int(m) * 60 + int(s)
    except (ValueError, IndexError):
        return None


def format_time(seconds):
    """将秒数格式化为 HH:MM:SS"""
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def get_raw_time_range(date_str, base_dir=_DEFAULT_DATA_DIR, verbose=False):
    """从 perception.jsonl 获取最早和最晚事件时间

    perception.jsonl 每行一个JSON对象, 包含 t 字段 (HH:MM:SS 格式)。

    跨午夜溢出处理（历史修复）:
    后端按"接收时刻"分区落盘, 午夜后补传的事件 t 仍是前一日 23:xx, 会落在
    次日文件的行首; 其秒数远大于当日真实起点, 会污染 max (表现为
    "原始数据 00:00:47 ~ 23:59:51" 这类假的全天覆盖)。处理两步:
    1. 行首若连续出现 t >= 20:00 的事件、其后才出现 t < 12:00 的事件,
       判为前一日溢出, 整段丢弃;
    2. date_str 为今天时, 额外丢弃 t 晚于"当前时刻 + 10 分钟时钟容差"的事件
       (未来时刻不可能存在, 但设备与服务器存在秒级偏差, 故留容差)。

    Args:
        date_str: 日期字符串 YYYY-MM-DD
        base_dir: 数据根目录
        verbose: 是否打印被剔除的事件条数

    Returns:
        tuple: (first_seconds, last_seconds, last_t_str) 或 (None, None, error_message)
    """
    perception_path = os.path.join(base_dir, date_str, 'perception.jsonl')
    if not os.path.exists(perception_path):
        return None, None, f"perception.jsonl 不存在: {perception_path}"

    events = []  # [(seconds, t_str)], 保持文件行序
    try:
        with open(perception_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t_str = obj.get('t', '')
                if not t_str:
                    continue
                seconds = parse_time(t_str)
                if seconds is not None:
                    events.append((seconds, t_str))
    except Exception as e:
        return None, None, f"读取 perception.jsonl 失败: {e}"

    if not events:
        return None, None, f"perception.jsonl 中没有找到有效时间数据"

    # ---- 1. 丢弃行首的前一日跨午夜溢出事件 ----
    early_idx = None
    for i, (seconds, _) in enumerate(events):
        if seconds < 12 * 3600:
            early_idx = i
            break
    if early_idx:  # 非 None 且 > 0 才可能有溢出
        head = events[:early_idx]
        if all(seconds >= 20 * 3600 for seconds, _ in head):
            if verbose:
                print(f"[check_coverage] 已剔除行首 {early_idx} 条前一日跨午夜溢出事件")
            events = events[early_idx:]

    # ---- 2. 今天: 丢弃晚于当前时刻的事件 ----
    if date_str == datetime.now().strftime('%Y-%m-%d'):
        now = datetime.now()
        now_seconds = now.hour * 3600 + now.minute * 60 + now.second
        kept = [
            (seconds, t_str) for seconds, t_str in events
            if seconds <= now_seconds + FUTURE_GRACE_SECONDS
        ]
        if verbose and len(kept) != len(events):
            print(
                f"[check_coverage] 已剔除 {len(events) - len(kept)} 条晚于当前时刻"
                f"({format_time(now_seconds)})的事件"
            )
        events = kept

    if not events:
        return None, None, f"perception.jsonl 中没有找到有效时间数据(过滤后)"

    first_t = min(seconds for seconds, _ in events)
    last_t, last_raw = max(events, key=lambda item: item[0])

    return first_t, last_t, last_raw


def find_understanding_files(date_dir):
    """查找日期目录下所有理解文件

    优先匹配新式单文件命名 (理解-{date}.md), 存在则只返回该文件;
    否则收集所有 理解-{date}-批次-{HH}.md 多批次文件。
    保留模糊匹配 "理解" 兜底以兼容历史遗留文件。

    Args:
        date_dir: 日期目录

    Returns:
        list: 理解文件路径列表, 找不到返回空列表
    """
    if not os.path.isdir(date_dir):
        return []

    date_str = os.path.basename(date_dir)

    # 新式单文件优先
    single_candidates = [
        os.path.join(date_dir, f'理解-{date_str}.md'),
    ]
    for p in single_candidates:
        if os.path.exists(p):
            return [p]

    # 收集所有 理解-{date}-批次-{HH}.md 多批次文件
    batch_files = []
    try:
        for fname in os.listdir(date_dir):
            fpath = os.path.join(date_dir, fname)
            if os.path.isfile(fpath) and fname.endswith('.md') and f'理解-{date_str}-批次-' in fname:
                batch_files.append(fpath)
    except OSError:
        pass

    # 兼容旧模糊匹配: 目录下仅一个含"理解"的md文件
    if not batch_files:
        try:
            fuzzy = []
            for fname in os.listdir(date_dir):
                fpath = os.path.join(date_dir, fname)
                if os.path.isfile(fpath) and fname.endswith('.md') and '理解' in fname:
                    fuzzy.append(fpath)
            if len(fuzzy) == 1:
                batch_files = fuzzy
        except OSError:
            pass

    # 排序保证确定性
    batch_files.sort()
    return batch_files


def parse_understood_slots(file_list):
    """从多个理解文件中解析所有时段

    每个时段做跨午夜处理 (结束<开始则结束+24h), 返回按开始时间排序的时段列表。

    Args:
        file_list: 理解文件路径列表

    Returns:
        list: 时段列表, 每项为 (start_s, end_s, start_str, end_str)
    """
    pattern = r'##\s+(\d{1,2}:\d{2})\s*[~\-\u223c]\s*(\d{1,2}:\d{2})'
    slots = []
    for path in file_list:
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
        except Exception:
            continue
        for start_str, end_str in re.findall(pattern, content):
            start_s = parse_time(start_str)
            end_s = parse_time(end_str)
            if start_s is None or end_s is None:
                continue
            # 跨午夜处理: 结束时间小于开始时间说明跨天
            if end_s < start_s:
                end_s += 86400
            slots.append((start_s, end_s, start_str, end_str))

    slots.sort(key=lambda x: (x[0], x[1]))
    return slots


def merge_understood_slots(slots):
    """合并重叠或相邻时段, 取覆盖并集

    多批次文件的时段可能在边界重叠 (如批次-08 覆盖到 08:00, 批次-11 从 08:00 开始),
    合并后可正确判断整体覆盖缺口。

    Args:
        slots: 已排序的时段列表

    Returns:
        list: 合并后的时段列表, 每项为 (start_s, end_s, start_str, end_str)
    """
    if not slots:
        return []
    merged = [list(slots[0])]
    for start_s, end_s, start_str, end_str in slots[1:]:
        prev = merged[-1]
        if start_s <= prev[1]:
            if end_s > prev[1]:
                prev[1] = end_s
                prev[3] = end_str
        else:
            merged.append([start_s, end_s, start_str, end_str])
    return [tuple(s) for s in merged]


# ---- 7 检查点契约 (2026-10-27) ----
# 与 {AI目录}/data/plan/coverage.yaml 的 merged_7 对齐。cov-00 排在今日计划里,
# 实际读取的是前一天 22:00~00:00 的数据。
CHECKPOINT_WINDOWS = {
    'cov-00': ('22:00', '00:00'),
    'cov-06': ('00:00', '06:00'),
    'cov-08': ('06:00', '08:00'),
    'cov-12': ('08:00', '12:00'),
    'cov-16': ('12:00', '16:00'),
    'cov-20': ('16:00', '20:00'),
    'cov-22': ('20:00', '22:00'),
}

_PREVIOUS_DAY_TARGETS = frozenset({'previous_day', 'yesterday'})

_HHMM_RE = re.compile(r'^(\d{1,2}):(\d{2})$')
_WINDOW_RE = re.compile(r'^\s*(\d{1,2}:\d{2})\s*[~\-\u223c]\s*(\d{1,2}:\d{2})\s*$')


def _normalize_hhmm(value):
    if not isinstance(value, str):
        return None
    m = _HHMM_RE.match(value.strip())
    if not m:
        return None
    hour, minute = int(m.group(1)), int(m.group(2))
    if hour > 23 or minute > 59:
        return None
    return f"{hour:02d}:{minute:02d}"


def _parse_window(value):
    if not isinstance(value, str):
        return None
    m = _WINDOW_RE.match(value)
    if not m:
        return None
    start = _normalize_hhmm(m.group(1))
    end = _normalize_hhmm(m.group(2))
    if start is None or end is None:
        return None
    return start, end


def validate_profile(profile):
    """校验 7 检查点 profile 的 ID、窗口与 cov-00 的跨日归属 (纯函数, 无 I/O)。

    Args:
        profile: 检查点 mapping, 或含 'checkpoints' 的 profile dict。
            每个检查点只需 'window' ('HH:MM~HH:MM'); cov-00 另需
            target_date 为 previous_day/yesterday 才视为指向昨天。
            与 {AI目录}/data/plan/coverage.yaml 的 merged_7 结构一致。

    Returns:
        dict: {
            'ok': bool,
            'errors': list[str],
            'checkpoint_ids': list[str],
            'windows': dict[str, tuple[str, str]],
            'cov00_target_date': str | None,
        }
    """
    checkpoints = profile
    if isinstance(profile, dict) and isinstance(profile.get('checkpoints'), dict):
        checkpoints = profile['checkpoints']

    errors = []
    windows = {}
    cov00_target_date = None

    if not isinstance(checkpoints, dict):
        return {
            'ok': False,
            'errors': ['profile 必须是检查点 mapping 或含 checkpoints 的 dict'],
            'checkpoint_ids': [],
            'windows': windows,
            'cov00_target_date': cov00_target_date,
        }

    required = list(CHECKPOINT_WINDOWS)
    missing = [cid for cid in required if cid not in checkpoints]
    extra = sorted(cid for cid in checkpoints if cid not in CHECKPOINT_WINDOWS)
    if missing:
        errors.append(f"缺少检查点: {', '.join(missing)}")
    if extra:
        errors.append(f"存在未定义检查点: {', '.join(extra)}")

    for cid in required:
        cp = checkpoints.get(cid)
        if cp is None:
            continue
        if not isinstance(cp, dict):
            errors.append(f"{cid}: 检查点配置必须是 mapping")
            continue

        parsed = _parse_window(cp.get('window'))
        if parsed is None:
            errors.append(f"{cid}: window 必须为 'HH:MM~HH:MM', 实际 {cp.get('window')!r}")
        else:
            windows[cid] = parsed
            expected = CHECKPOINT_WINDOWS[cid]
            if parsed != expected:
                errors.append(
                    f"{cid}: 窗口应为 {'~'.join(expected)}, 实际 {'~'.join(parsed)}"
                )

        if cid == 'cov-00':
            cov00_target_date = cp.get('target_date')
            if cov00_target_date not in _PREVIOUS_DAY_TARGETS:
                errors.append(
                    "cov-00: target_date 必须为 previous_day (指向昨天), "
                    f"实际 {cov00_target_date!r}"
                )
        elif 'target_date' in cp and cp.get('target_date') != 'today':
            errors.append(f"{cid}: target_date 应为 today, 实际 {cp.get('target_date')!r}")

    return {
        'ok': not errors,
        'errors': errors,
        'checkpoint_ids': [cid for cid in required if cid in checkpoints],
        'windows': windows,
        'cov00_target_date': cov00_target_date,
    }


def get_understood_last_time(date_str, base_dir=_DEFAULT_DATA_DIR):
    """从理解文件获取最晚理解时段结束时间

    理解文件命名支持两种模式:
    1. 新式单文件: {date}/理解-{date}.md
    2. 新式多批次: {date}/理解-{date}-批次-{HH}.md, 多个文件合并解析后取最晚

    时段标题格式: ## HH:MM~HH:MM (说明文字)

    Args:
        date_str: 日期字符串 YYYY-MM-DD
        base_dir: 数据根目录

    Returns:
        tuple: (end_seconds, start_str, end_str) 或 (None, None, reason)
            - end_seconds: 最晚时段结束时间的秒数
            - start_str: 最晚时段的开始时间字符串
            - end_str: 最晚时段的结束时间字符串
    """
    date_dir = os.path.join(base_dir, date_str)
    file_list = find_understanding_files(date_dir)

    if not file_list:
        return None, None, "理解文件不存在"

    slots = parse_understood_slots(file_list)
    if not slots:
        return None, None, "理解文件中没有找到时段信息"

    # 取结束最晚的时段 (理解文件可能非严格时序追加, 不能用 slots[-1])
    last_start_seconds, last_end_seconds, last_start_str, last_end_str = \
        max(slots, key=lambda s: s[1])

    # 处理午夜过渡时段特例: 如果最晚时段从00:00开始且结束时间<12:00,
    # 说明是当天的午夜过渡时段, 加24h以正确比较
    if last_start_seconds == 0 and last_end_seconds is not None and last_end_seconds < 43200:
        last_end_seconds += 86400

    return last_end_seconds, last_start_str, last_end_str


def check_data_completeness(raw_first_seconds, raw_last_seconds, date_str):
    """判断当天原始数据是否采集完整

    对于已过去的日期:
    1. 如果最早数据时间晚于 08:00, 说明数据采集开始过晚
    2. 如果最晚数据时间早于 23:00, 说明采集在晚上提前结束

    对于今天, 数据可能还在收集中, 返回完整。

    Args:
        raw_first_seconds: 原始数据最早时间(秒)
        raw_last_seconds: 原始数据最晚时间(秒)
        date_str: 日期字符串

    Returns:
        tuple: (is_complete, reason)
    """
    # 对于今天, 数据可能还在收集中
    today_str = datetime.now().strftime('%Y-%m-%d')
    if date_str == today_str:
        return True, None

    # 检查最早时间: 如果数据从上午很晚才开始, 说明不完整
    late_start_threshold = 8 * 3600  # 08:00
    if raw_first_seconds is not None and raw_first_seconds >= late_start_threshold:
        return False, (
            f"数据采集开始过晚, 最早数据时间: {format_time(raw_first_seconds)}, "
            f"最晚: {format_time(raw_last_seconds)}"
        )

    # 检查最晚时间: 如果结束时间早于 23:00
    evening_threshold = 23 * 3600  # 23:00
    if raw_last_seconds < evening_threshold:
        return False, f"数据采集提前结束, 最晚数据时间: {format_time(raw_last_seconds)}"

    # 数据覆盖完整
    return True, None


def check_internal_gaps(date_str, base_dir=_DEFAULT_DATA_DIR, raw_first_seconds=None, raw_last_seconds=None):
    """检查理解文件内部是否有缺口

    解析理解文件中所有时段，检查：
    1. 时段之间是否有缺口（超过2小时无理解记录）
    2. 理解覆盖是否从原始数据开始到结束

    Args:
        date_str: 日期字符串 YYYY-MM-DD
        base_dir: 数据根目录
        raw_first_seconds: 原始数据最早时间(秒)
        raw_last_seconds: 原始数据最晚时间(秒)

    Returns:
        tuple: (passed, gaps_list)
            - passed: True表示无缺口
            - gaps_list: 缺口列表，每个缺口为(缺口起始, 缺口结束, 缺口时长秒数)
    """
    date_dir = os.path.join(base_dir, date_str)
    gaps = []

    file_list = find_understanding_files(date_dir)
    if not file_list:
        return False, [('N/A', 'N/A', 0, '理解文件不存在')]

    slots = parse_understood_slots(file_list)
    if not slots:
        return False, [('N/A', 'N/A', 0, '未找到时段信息')]

    # 合并重叠时段 (多批次边界可能重叠), 取覆盖并集后再检查缺口
    slots = merge_understood_slots(slots)

    # 检查从原始数据开始到第一个时段的缺口
    # >= 而非 >：缺口正好 2 小时也算漏（边界值 7200s 曾被漏报）
    gap_threshold = 7200  # 2小时
    if raw_first_seconds is not None and slots[0][0] >= raw_first_seconds + gap_threshold:
        gap_start = format_time(raw_first_seconds)
        gap_end = slots[0][2]
        gap_sec = slots[0][0] - raw_first_seconds
        gaps.append((gap_start, gap_end, gap_sec, '数据开始到首段理解'))

    # 检查时段之间的缺口（>=：正好 2 小时也算漏，边界值 7200s 曾漏报）
    for i in range(1, len(slots)):
        prev_end = slots[i-1][1]
        curr_start = slots[i][0]
        if curr_start >= prev_end + gap_threshold:
            gap_start = slots[i-1][3]
            gap_end = slots[i][2]
            gap_sec = curr_start - prev_end
            gaps.append((gap_start, gap_end, gap_sec, '理解时段之间'))

    # 检查最后时段到原始数据结束的缺口 (>= : 正好2小时也算漏)
    if raw_last_seconds is not None:
        last_end = slots[-1][1]
        if last_end <= raw_last_seconds - gap_threshold:
            gap_start = slots[-1][3]
            gap_end = format_time(raw_last_seconds)
            gap_sec = raw_last_seconds - last_end
            gaps.append((gap_start, gap_end, gap_sec, '最后时段到数据结束'))

    return len(gaps) == 0, gaps


def check_voice_pipeline(date_str, base_dir=_DEFAULT_DATA_DIR, grace_minutes=30):
    """voice 管线自检: 音频段数 vs perception.jsonl 里的 `voice` 事件数。

    正常时二者近似 1:1（基线 09-22: 752 事件 / 754 个音频文件，每小时各约 33）。
    音频持续落盘而 voice 事件长期为 0 或极少 → 判「voice 管线停摆」，不能当"安静"。
    当天只统计 grace_minutes 之前的音频，避免把刚上传未处理误判为故障。

    返回 dict；无音频目录时返回 None。本检查不影响覆盖判定的退出码。
    """
    audio_dir = os.path.join(base_dir, date_str, 'audio')
    if not os.path.isdir(audio_dir):
        return None

    now = datetime.now()
    cutoff = None
    if date_str == now.strftime('%Y-%m-%d'):
        now_sec = now.hour * 3600 + now.minute * 60 + now.second
        cutoff = max(0, now_sec - grace_minutes * 60)

    def _start_seconds(filename):
        m = re.match(r'^(\d{2})(\d{2})(\d{2})-', filename)
        if not m:
            return None
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))

    audio_total = 0
    for name in os.listdir(audio_dir):
        # T5: 双后缀统计（wav|flac），flac 不再被算成假缺口
        if not name.endswith(('.wav', '.flac')):
            continue
        start_sec = _start_seconds(name)
        if start_sec is None:
            continue
        if cutoff is not None and start_sec > cutoff:
            continue
        audio_total += 1

    voice_total = 0
    perception_path = os.path.join(base_dir, date_str, 'perception.jsonl')
    needle = '/' + date_str + '/audio/'
    if os.path.exists(perception_path):
        with open(perception_path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                if '"voice"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if obj.get('type') != 'voice':
                    continue
                audio = obj.get('audio') or ''
                if needle not in audio:
                    continue
                start_sec = _start_seconds(os.path.basename(audio))
                if cutoff is not None and start_sec is not None and start_sec > cutoff:
                    continue
                voice_total += 1

    ratio = (voice_total / audio_total) if audio_total else None
    warn = audio_total >= 20 and (ratio is None or ratio < 0.5)
    return {
        'audio': audio_total,
        'voice': voice_total,
        'ratio': ratio,
        'warn': warn,
        'missing': max(0, audio_total - voice_total),
    }


def format_voice_line(vp):
    """格式化 voice 管线自检结果为单行文本。"""
    if not vp:
        return None
    line = f"voice 管线: 音频 {vp['audio']} 段 / voice 事件 {vp['voice']} 条"
    if vp['ratio'] is not None:
        line += f" ({vp['ratio'] * 100:.0f}%)"
    if vp['warn']:
        line += f" -> 警告: 疑似 voice 管线停摆, 约缺 {vp['missing']} 段"
    return line


def main():
    parser = argparse.ArgumentParser(
        description='时间线覆盖检查 - 检测AI是否漏掉了某些时段的感知理解记录'
    )
    parser.add_argument('date', help='日期, 格式: YYYY-MM-DD')
    parser.add_argument('--json', action='store_true', help='输出JSON格式')
    parser.add_argument('--quiet', action='store_true', help='安静模式, 只返回退出码')
    parser.add_argument(
        '--data-dir', default=_DEFAULT_DATA_DIR,
        help=f'数据目录 (默认: {_DEFAULT_DATA_DIR})'
    )

    args = parser.parse_args()
    date_str = args.date

    # ---- 1. 获取原始数据时间范围 ----
    raw_first_seconds, raw_last_seconds, raw_last_str = get_raw_time_range(
        date_str, args.data_dir, verbose=not args.quiet
    )
    raw_first_str = format_time(raw_first_seconds) if raw_first_seconds is not None else None

    if raw_last_seconds is None:
        # perception.jsonl 本身不存在或无法读取
        if args.json:
            print(json.dumps({
                'date': date_str,
                'status': 'error',
                'reason': raw_last_str
            }, ensure_ascii=False))
        elif not args.quiet:
            print(f"[check_coverage] {date_str}")
            print(f"错误: {raw_last_str}")
        sys.exit(2)

    # ---- 1b. voice 管线自检（独立报告，不影响覆盖判定）----
    voice_pipeline = check_voice_pipeline(date_str, args.data_dir)

    # ---- 2. 检查数据完整性 ----
    data_complete, incomplete_reason = check_data_completeness(
        raw_first_seconds, raw_last_seconds, date_str
    )

    if not data_complete:
        if args.json:
            print(json.dumps({
                'date': date_str,
                'raw_last': raw_last_str,
                'understood_last': None,
                'gap_seconds': None,
                'status': 'incomplete',
                'reason': incomplete_reason
            }, ensure_ascii=False))
        elif not args.quiet:
            print(f"[check_coverage] {date_str}")
            print(f"原始数据: {raw_first_str} ~ {raw_last_str}")
            print(f"状态: 数据不完整")
            print(f"原因: {incomplete_reason}")
        sys.exit(2)

    # ---- 3. 检查内部缺口（所有时段之间的间隙）----
    internal_ok, internal_gaps = check_internal_gaps(
        date_str, args.data_dir, raw_first_seconds, raw_last_seconds
    )

    if not internal_ok:
        gap_details = '; '.join([
            f'{g[0]}~{g[1]}({format_time(g[2])})[{g[3]}]'
            for g in internal_gaps
        ])
        if args.json:
            print(json.dumps({
                'date': date_str,
                'raw_range': f'{raw_first_str}~{raw_last_str}',
                'status': 'fail',
                'reason': f'内部缺口: {gap_details}'
            }, ensure_ascii=False))
        elif not args.quiet:
            print(f"[check_coverage] {date_str}")
            print(f"原始数据: {raw_first_str} ~ {raw_last_str}")
            print(f"状态: 未通过 - 理解文件内部存在缺口")
            for g in internal_gaps:
                print(f"  缺口: {g[0]}~{g[1]} ({format_time(g[2])}) [{g[3]}]")
        sys.exit(1)

    # ---- 4. 获取理解文件最晚时段 ----
    understood_last_seconds, last_start_str, last_end_str = get_understood_last_time(
        date_str, args.data_dir
    )

    # ---- 4. 对比判断 ----
    if understood_last_seconds is None:
        # 理解文件不存在
        gap_seconds = raw_last_seconds
        reason = f"理解文件不存在, 原始数据最晚: {raw_last_str}"
        if args.json:
            print(json.dumps({
                'date': date_str,
                'raw_last': raw_last_str,
                'understood_last': None,
                'gap_seconds': gap_seconds,
                'status': 'fail',
                'reason': reason
            }, ensure_ascii=False))
        elif not args.quiet:
            print(f"[check_coverage] {date_str}")
            print(f"原始数据最晚: {raw_last_str}")
            print(f"理解文件: 不存在")
            if raw_last_seconds > 0:
                print(f"缺口: ~{format_time(gap_seconds)} 未覆盖")
        sys.exit(1)

    # 计算缺口
    gap_seconds = raw_last_seconds - understood_last_seconds
    gap_threshold = 7200  # 2 小时（>= 判定：正好 2 小时也算漏，边界漏报修正）

    if gap_seconds >= gap_threshold:
        # 漏时段
        gap_start = last_end_str
        gap_end = raw_last_str
        reason = f"未覆盖时段 {gap_start}~{gap_end} (缺口 {format_time(gap_seconds)})"

        if args.json:
            print(json.dumps({
                'date': date_str,
                'raw_last': raw_last_str,
                'understood_last': f"{last_start_str}~{last_end_str}",
                'gap_seconds': gap_seconds,
                'status': 'fail',
                'voice_pipeline': voice_pipeline,
                'reason': reason
            }, ensure_ascii=False))
        elif not args.quiet:
            hours = gap_seconds / 3600
            print(f"[check_coverage] {date_str}")
            print(f"原始数据最晚: {raw_last_str}")
            print(f"理解文件最晚: {last_start_str} (时段结束 {last_end_str})")
            print(f"缺口: {raw_last_str} - {last_end_str} = ~{hours:.1f}h -> 未通过")
            print(f"原因: {reason}")
            voice_line = format_voice_line(voice_pipeline)
            if voice_line:
                print(voice_line)
        sys.exit(1)

    # 通过
    if args.json:
        print(json.dumps({
            'date': date_str,
            'raw_last': raw_last_str,
            'understood_last': f"{last_start_str}~{last_end_str}",
            'gap_seconds': 0,
            'status': 'pass',
            'voice_pipeline': voice_pipeline,
            'reason': '覆盖完整'
        }, ensure_ascii=False))
    elif not args.quiet:
        print(f"[check_coverage] {date_str}")
        print(f"原始数据最晚: {raw_last_str}")
        print(f"理解文件最晚: {last_start_str} (时段结束 {last_end_str})")
        print(f"缺口: 0s -> 通过")
        voice_line = format_voice_line(voice_pipeline)
        if voice_line:
            print(voice_line)
    sys.exit(0)


if __name__ == '__main__':
    main()
