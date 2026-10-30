# -*- coding: utf-8 -*-
"""T1 append_perception 显式事件日期分桶测试（手机离线补传场景）。

背景：补传数天前的旧录音时分析今天才完成，append_perception 若固定按
今天分桶会把事件写错日期。要求调用方可显式传 date_str 指定事件日期；
非法日期必须 fail-loud 抛 ValueError 到调用方（不能被吞掉返回 False，
否则补传链路静默写错桶无人察觉）。分桶取值先例见 save_audio 的
"绝不使用服务器当前时间"。
"""
import json
import os

from services import perception_store


def _isolated_env(monkeypatch, tmp_path, today="2026-10-12"):
    """隔离数据根目录 + 固定 _today_str，测试不依赖服务器真实时间。"""
    monkeypatch.setattr(perception_store, "_DATA_BASE", str(tmp_path / "daily"))
    monkeypatch.setattr(perception_store, "_today_str", lambda: today)
    return today


def test_explicit_date_str_lands_in_event_bucket(monkeypatch, tmp_path):
    """date_str 显式指定时落事件日期桶，绝不落今天的桶（离线补传核心用例）。"""
    today = _isolated_env(monkeypatch, tmp_path, today="2026-10-12")

    ok = perception_store.append_perception(
        {"type": "voice", "text": "离线补传"}, date_str="2026-10-11")

    assert ok is True
    event_file = os.path.join(str(tmp_path), "daily", "2026-10-11", "perception.jsonl")
    # _date_dir 对缺失日期目录必须自动创建，此处即其证明
    assert os.path.exists(event_file)
    lines = open(event_file, encoding="utf-8").read().strip().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["text"] == "离线补传"
    # 今天的桶一个字节都不许有
    today_file = os.path.join(str(tmp_path), "daily", today, "perception.jsonl")
    assert not os.path.exists(today_file)


def test_date_str_none_keeps_today_bucket(monkeypatch, tmp_path):
    """date_str=None 保持旧行为：落今天的桶（存量调用方不受影响）。"""
    today = _isolated_env(monkeypatch, tmp_path, today="2026-10-12")

    ok = perception_store.append_perception({"type": "sensor"})

    assert ok is True
    today_file = os.path.join(str(tmp_path), "daily", today, "perception.jsonl")
    assert os.path.exists(today_file)
    lines = open(today_file, encoding="utf-8").read().strip().splitlines()
    assert json.loads(lines[0])["type"] == "sensor"


def test_bad_date_str_raises_valueerror_to_caller(monkeypatch, tmp_path):
    """非法日期直接向调用方抛 ValueError（故意 fail-loud，不被宽 try/except 吞成 False）。"""
    _isolated_env(monkeypatch, tmp_path)
    for bad in ("20261011", "2026-13-99"):
        try:
            perception_store.append_perception({"type": "voice"}, date_str=bad)
            assert False, f"非法日期 {bad!r} 必须抛 ValueError 到调用方"
        except ValueError:
            pass
