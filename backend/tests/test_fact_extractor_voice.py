# -*- coding: utf-8 -*-
"""
FX lane: ai/analysis/fact_extractor.py `_collect_voice` 恢复验证（TDD）

覆盖两条验收路径：
  (a) 扁平 vp.ws 交错数组 + vp.max/vp.pct + env 三形态
      （dict{label,prob,start} / 字符串数组 / 缺 env 时的 audio_events 旧分支）
      -> 有 vp.ws+pct 时输出无 "未校验"；dict env 用真实概率与 start 偏移；
      旧字符串 env 回退 0.5/0；audio_events 分支行为保持不变。
  (b) 缺 vp.ws（或真正缺 pct）时仍输出 "未校验"，
      守卫 vp_pct == -1 路径（_section_voice_timeline L867-870 不动）。

运行方式：直接走生产收集链 collect_slot_data -> _collect_voice，
再经 _section_voice_timeline 渲染 markdown（与 build_section_markdown 同源），
不落盘、不联网、不经过 _find_data_file（H 轨道所有，零改动）。
"""
import importlib.util
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_FE_PATH = _REPO_ROOT / 'ai' / 'analysis' / 'fact_extractor.py'

if not _FE_PATH.is_file():
    pytest.skip('private ai/ is not part of the public tree', allow_module_level=True)

_spec = importlib.util.spec_from_file_location('_fact_extractor_fx_under_test', _FE_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError('无法加载 fact_extractor 测试目标模块')
_fe_loader = _spec.loader
fe = importlib.util.module_from_spec(_spec)
_fe_loader.exec_module(fe)


def _run_voice(event):
    """按生产路径收集单个 voice 事件并渲染语音时间线 markdown"""
    data = fe.collect_slot_data([event], {})
    md = '\n'.join(fe._section_voice_timeline(data))
    return data, md


def _audio_items(data):
    return [i for i in data['voice_timeline'] if i['type'] == 'audio_event']


def _speech_items(data):
    return [i for i in data['voice_timeline'] if i['type'] == 'speech']


def test_collect_voice_vp_ws_env_dict_and_legacy():
    # 事件1: 扁平 vp.ws/max/pct + dict env {label,prob,start}（内核新产形态）
    ev_dict = {
        'type': 'voice',
        't': '12:00:00',
        'dur': 120.0,
        'segs': [{
            'start': 10.0,
            'end': 13.5,
            'text': '明天谁的课嗯，明天谁的课明天啊明天周二的课。',
            'vp': {
                'spk': '',
                'sim': -0.1845,
                'max': 0.0029,
                'pct': 0.2,
                'ws': [0, -0.0748, 750, -0.0203, 1500, -0.0234,
                       2250, -0.2503, 3000, 0.0029],
                'ws_spk': ['', '', '', '', ''],
            },
        }],
        'ac': {'db': -18.6, 'spk': 100.0},
        'env': [
            {'label': '安静', 'prob': 0.92, 'start': 0},
            {'label': 'Clicking', 'prob': 0.61, 'start': 65},
        ],
        'device_name': '测试手机',
    }
    data1, md1 = _run_voice(ev_dict)

    # vp.ws 扁平交错 [t,s,...] -> [{start_ms,score}]；vp.max / vp.pct 读出
    sp1 = _speech_items(data1)
    assert len(sp1) == 1
    assert sp1[0]['vp_windows'] == [
        {'start_ms': 0, 'score': -0.0748},
        {'start_ms': 750, 'score': -0.0203},
        {'start_ms': 1500, 'score': -0.0234},
        {'start_ms': 2250, 'score': -0.2503},
        {'start_ms': 3000, 'score': 0.0029},
    ]
    assert sp1[0]['vp_max'] == 0.0029
    assert sp1[0]['vp_pct'] == 0.2

    # 有 vp.ws + pct -> 输出不含 "未校验"，且 ws 提供起止区间
    assert '未校验' not in md1
    assert '[sim -0.18]' in md1
    assert '(12:00:00~12:00:03)' in md1

    # dict env -> 真实概率 + start 偏移（不是硬编码 0.5 / 0）
    aud1 = _audio_items(data1)
    assert [(i['label'], i['probability'], i['offset']) for i in aud1] == [
        ('安静', 0.92, 0),
        ('Clicking', 0.61, 65),
    ]
    assert '安静[92%]' in md1
    assert 'Clicking[61%]' in md1
    assert '安静[50%]' not in md1
    # start=65s 把环境音时间范围推到 12:01（证明 offset 真实生效）
    assert '(12:00~12:01)' in md1

    # 事件2: 旧字符串数组 env -> 回退 0.5/0；vp.ws+pct 仍在 -> 无 "未校验"
    ev_legacy = {
        'type': 'voice',
        't': '12:05:00',
        'segs': [{
            'start': 2.0,
            'end': 4.0,
            'text': '旧字符串环境音测试。',
            'vp': {
                'spk': '8-23测试',
                'sim': 0.6696,
                'max': 0.71,
                'pct': 1.0,
                'ws': [0, 0.6696, 750, 0.71],
            },
        }],
        'env': ['White noise', '车辆', 'White noise'],
        'device_name': '测试手机',
    }
    data2, md2 = _run_voice(ev_legacy)
    assert '未校验' not in md2
    aud2 = _audio_items(data2)
    # 字符串按 label 去重 + 固定 0.5 / 0 回退（历史行为不变）
    assert [i['label'] for i in aud2] == ['White noise', '车辆']
    assert all(i['probability'] == 0.5 for i in aud2)
    assert all(i['offset'] == 0 for i in aud2)
    assert 'White noise[50%]' in md2
    assert '车辆[50%]' in md2

    # 事件3: 无 env 键 -> 旧 audio_events 分支保持不变（>=0.1 才收，真实概率）
    ev_ae = {
        'type': 'voice',
        't': '12:10:00',
        'segs': [{
            'start': 3.0,
            'end': 5.0,
            'text': '旧分支回归测试。',
            'vp': {
                'spk': '',
                'sim': 0.42,
                'max': 0.55,
                'pct': 0.75,
                'ws': [0, 0.55],
            },
        }],
        'audio_events': [
            {'label_cn': '敲门声', 'probability': 0.8, 'start': 5},
            {'label': 'knock', 'probability': 0.05, 'start': 9},
        ],
        'device_name': '测试手机',
    }
    data3, md3 = _run_voice(ev_ae)
    assert '未校验' not in md3
    aud3 = _audio_items(data3)
    assert [(i['label'], i['probability'], i['offset']) for i in aud3] == [
        ('敲门声', 0.8, 5),
    ]
    assert '敲门声[80%]' in md3
    assert 'knock' not in md3


def test_collect_voice_missing_vp_ws_marks_unverified():
    # (b-1) 缺 vp.ws 且缺 pct -> 仍输出 "未校验"；vp_pct 归 -1 守卫
    ev_no_ws = {
        'type': 'voice',
        't': '12:15:00',
        'segs': [{
            'start': 1.0,
            'end': 2.0,
            'text': '缺窗口语音。',
            'vp': {'spk': '8-23测试', 'sim': 0.6846},
        }],
        'env': ['安静'],
        'device_name': '测试手机',
    }
    data_b1, md_b1 = _run_voice(ev_no_ws)
    sp_b1 = _speech_items(data_b1)
    assert len(sp_b1) == 1
    assert not sp_b1[0]['vp_windows']
    # 真正缺 pct -> 归 -1（vp_pct == -1 路径）
    assert sp_b1[0]['vp_pct'] == -1
    assert '未校验' in md_b1

    # (b-2) 有 vp.ws 但缺 pct -> 真正缺 pct -> vp_pct == -1 -> "未校验"
    ev_no_pct = {
        'type': 'voice',
        't': '12:20:00',
        'segs': [{
            'start': 2.0,
            'end': 5.0,
            'text': '有窗口缺覆盖率。',
            'vp': {'spk': '', 'sim': 0.5, 'max': 0.6, 'ws': [0, 0.5, 750, 0.6]},
        }],
        'env': ['安静'],
        'device_name': '测试手机',
    }
    data_b2, md_b2 = _run_voice(ev_no_pct)
    sp_b2 = _speech_items(data_b2)
    assert len(sp_b2) == 1
    assert sp_b2[0]['vp_windows']  # 扁平 ws 已转为对象数组（vp_windows 守卫）
    assert sp_b2[0]['vp_pct'] == -1  # 真正缺 pct -> -1 -> 触发未校验
    assert '未校验' in md_b2
