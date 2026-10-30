# -*- coding: utf-8 -*-
"""P2-V11 perception_reader 单测：缺文件/坏行/过滤/谓词/iter_days 容错并集语义。"""
import json
import os

from services import perception_reader as pr


def _day_dir(tmp_path, date):
    d = os.path.join(str(tmp_path), "daily", date)
    os.makedirs(d, exist_ok=True)
    return d


def _write_lines(day_dir, lines):
    with open(os.path.join(day_dir, "perception.jsonl"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def test_missing_file_returns_empty(tmp_path):
    assert pr.read_day("2026-01-01", data_root=str(tmp_path)) == []
    assert pr.has_perception("2026-01-01", data_root=str(tmp_path)) is False


def test_path_and_perception_path_shape(tmp_path):
    assert pr.perception_path("2026-01-01", data_root=str(tmp_path)) == \
        os.path.join(str(tmp_path), "daily", "2026-01-01", "perception.jsonl")
    assert pr.daily_root(data_root=str(tmp_path)) == os.path.join(str(tmp_path), "daily")


def test_bad_lines_skipped_union_semantics(tmp_path):
    """空行/纯空白/坏 JSON/顶层非 dict 行全部跳过，好行保持行序。"""
    d = _day_dir(tmp_path, "2026-01-02")
    good1 = json.dumps({"type": "voice", "t": "01:00:00"})
    good2 = json.dumps({"type": "sensor", "t": "02:00:00"})
    _write_lines(d, [
        good1,
        "",
        "   ",
        "{not json",
        "[1, 2, 3]",
        "123",
        '"a string"',
        "null",
        good2,
    ])
    assert pr.has_perception("2026-01-02", data_root=str(tmp_path)) is True
    entries = pr.read_day("2026-01-02", data_root=str(tmp_path))
    assert entries == [{"type": "voice", "t": "01:00:00"},
                       {"type": "sensor", "t": "02:00:00"}]


def test_types_filter_str_and_set(tmp_path):
    d = _day_dir(tmp_path, "2026-01-03")
    _write_lines(d, [
        json.dumps({"type": "voice", "i": 1}),
        json.dumps({"type": "sensor", "i": 2}),
        json.dumps({"type": "app", "i": 3}),
        json.dumps({"i": 4}),
    ])
    root = str(tmp_path)
    assert pr.read_day("2026-01-03", types="voice", data_root=root) == \
        [{"type": "voice", "i": 1}]
    assert pr.read_day("2026-01-03", types=("voice", "app"), data_root=root) == \
        [{"type": "voice", "i": 1}, {"type": "app", "i": 3}]
    assert pr.read_day("2026-01-03", types=("nope",), data_root=root) == []
    assert len(pr.read_day("2026-01-03", data_root=root)) == 4


def test_predicate_filter_and_propagates(tmp_path):
    d = _day_dir(tmp_path, "2026-01-04")
    _write_lines(d, [
        json.dumps({"type": "voice", "audio": "daily/x/a.wav"}),
        json.dumps({"type": "voice", "audio": "daily/x/b.flac"}),
    ])
    root = str(tmp_path)
    out = pr.read_day("2026-01-04", types=("voice",),
                      predicate=lambda e: str(e.get("audio", "")).endswith(".wav"),
                      data_root=root)
    assert len(out) == 1 and out[0]["audio"].endswith("a.wav")

    def boom(_):
        raise ValueError("字段级异常不归 reader 吞")
    try:
        pr.read_day("2026-01-04", predicate=boom, data_root=root)
        assert False, "predicate 异常必须向上传播"
    except ValueError:
        pass


def test_unicode_error_line_skipped_rest_kept(tmp_path):
    d = _day_dir(tmp_path, "2026-01-05")
    with open(os.path.join(d, "perception.jsonl"), "wb") as f:
        f.write(json.dumps({"type": "voice", "i": 1}).encode("utf-8") + b"\n")
        f.write(json.dumps({"type": "voice", "i": 2}).encode("utf-8") + b"\n")
        f.write(b"\xff\xfe invalid utf8 \n")
        f.write(json.dumps({"type": "voice", "i": 3}).encode("utf-8") + b"\n")
    entries = pr.read_day("2026-01-05", data_root=str(tmp_path))
    assert [e["i"] for e in entries] == [1, 2, 3]


def test_day_dirs_scan(tmp_path):
    root = str(tmp_path)
    assert pr.day_dirs(data_root=root) == []
    _day_dir(tmp_path, "2026-01-06")
    _day_dir(tmp_path, "2026-01-07")
    os.makedirs(os.path.join(root, "daily", "not-a-date"))
    os.makedirs(os.path.join(root, "daily", "2026-1-7"))
    open(os.path.join(root, "daily", "afile.txt"), "w").close()
    assert pr.day_dirs(data_root=root) == ["2026-01-07", "2026-01-06"]
    assert pr.day_dirs(data_root=root, reverse=False) == ["2026-01-06", "2026-01-07"]


def test_iter_days_range_semantics(tmp_path):
    root = str(tmp_path)
    d2 = _day_dir(tmp_path, "2026-03-02")
    _write_lines(d2, [json.dumps({"type": "voice", "d": "2026-03-02"})])
    days = list(pr.iter_days("2026-03-01", "2026-03-03", data_root=root))
    assert [ds for ds, _ in days] == ["2026-03-02"]
    assert days[0][1][0]["d"] == "2026-03-02"

    with_empty = list(pr.iter_days("2026-03-01", "2026-03-03",
                                   data_root=root, include_empty=True))
    assert [ds for ds, _ in with_empty] == \
        ["2026-03-01", "2026-03-02", "2026-03-03"]
    assert with_empty[0][1] == []

    assert list(pr.iter_days("bad-date", "2026-03-03", data_root=root)) == []

    swapped = list(pr.iter_days("2026-03-03", "2026-03-01", data_root=root))
    assert [ds for ds, _ in swapped] == ["2026-03-03", "2026-03-01"]

    one = list(pr.iter_days("2026-03-02", "2026-03-02", types=("voice",),
                            data_root=root))
    assert len(one) == 1 and len(one[0][1]) == 1
