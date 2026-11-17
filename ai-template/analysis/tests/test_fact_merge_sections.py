"""fact_extractor 增量合并回归测试：去重键是时段区间，不是段落标题。

同源缺陷：`render_fact_markdown` 不剥段尾空行，每跑一次 --hours 增量，所有保留段
都会多攒一行空行。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fact_extractor as fe

OLD = """# 2026-11-15 事实数据

> 生成时间: 2026-11-15T20:12:00
> 数据覆盖: 全天（分批次合并）

## 10:00~10:05 | 手机
- a

## 20:00~20:05 | 笔记本
- b

## 20:05~20:10 | 手机
- c

## 01:00~01:05 | 手机
- d
"""


def _write(tmp_path, text):
    path = tmp_path / 'fact.md'
    path.write_text(text, encoding='utf-8')
    return path


def test_same_slot_new_device_set_replaces_old(tmp_path):
    path = _write(tmp_path, OLD)
    _, titles, bodies = fe.merge_fact_sections(
        path, ['## 20:00~20:05 | 手机+笔记本\n- b2\n- extra']
    )
    assert titles.count('20:00~20:05 | 手机+笔记本') == 1
    assert '20:00~20:05 | 笔记本' not in titles
    assert list(bodies)[titles.index('20:00~20:05 | 手机+笔记本')].startswith('- b2')
    # 窗外段落原样保留
    assert '10:00~10:05 | 手机' in titles
    assert '20:05~20:10 | 手机' in titles


def test_merged_range_swallows_single_slots(tmp_path):
    path = _write(tmp_path, OLD)
    _, titles, _ = fe.merge_fact_sections(
        path, ['## 01:00~03:00 -- 睡眠（合并时段，HR快照附后） | 手机\n- d2']
    )
    assert '01:00~01:05 | 手机' not in titles
    assert any(t.startswith('01:00~03:00') for t in titles)


def test_render_is_idempotent(tmp_path):
    """渲染→解析→再渲染，文本必须逐字相同（空行不累积）。"""
    titles = ['10:00~10:05 | 手机', '20:00~20:05 | 手机+笔记本']
    bodies = ['- a', '- b\n\n']
    first = fe.render_fact_markdown('2026-11-15', '全天', titles, bodies)
    path = _write(tmp_path, first)
    _, t2, b2 = fe.merge_fact_sections(path, [])
    second = fe.render_fact_markdown('2026-11-15', '全天', t2, b2)
    # 生成时间戳行会变，比较正文段
    strip = lambda md: [ln for ln in md.splitlines() if not ln.startswith('> 生成时间')]
    assert strip(first) == strip(second)


def test_section_interval_parses_suffixes():
    assert fe._section_interval('20:00~20:05 | 笔记本') == (20 * 60, 20 * 60 + 5)
    assert fe._section_interval('01:00~03:00 -- 睡眠（合并时段，HR快照附后）') == (60, 180)
    assert fe._section_interval('23:55~00:05 | 手机') == (23 * 60 + 55, 24 * 60 + 5)
    assert fe._section_interval('没有时间') is None


def test_window_end_is_exclusive():
    """22:00~00:00 不能把次日 00:00 的第一分钟并进来（跨日窗口结束点开区间）。"""
    events = [
        {'t': '2026-11-15T21:59:00'},
        {'t': '2026-11-15T22:00:00'},
        {'t': '2026-11-15T23:59:59'},
        {'t': '2026-11-16T00:00:00'},
        {'t': '2026-11-16T00:00:30'},
    ]
    kept = [e['t'] for e in fe.filter_events_by_time(events, '22:00~00:00')]
    assert kept == ['2026-11-15T22:00:00', '2026-11-15T23:59:59']


def test_window_end_exclusive_for_normal_range():
    events = [{'t': '13:59:00'}, {'t': '14:00:00'}]
    kept = [e['t'] for e in fe.filter_events_by_time(events, '06:00~14:00')]
    assert kept == ['13:59:00']
