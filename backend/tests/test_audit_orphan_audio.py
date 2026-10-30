# -*- coding: utf-8 -*-
"""audit_orphan_audio.py 三分类契约测试（tmp 树，只读验证零写入）。"""
import importlib.util
import json
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "_audit_orphan_mod", _REPO_ROOT / "scripts" / "audit_orphan_audio.py")
ao = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ao)


def _row(**kw):
    return (json.dumps(kw, ensure_ascii=False) + "\n").encode("utf-8")


def _tree(tmp_path: Path) -> Path:
    base = tmp_path / "daily"
    d11 = base / "2026-10-11"
    (d11 / "audio").mkdir(parents=True)
    # 三个实物文件：a 被全路径引用；b 仅 basename 引用（旧 schema）；c 无引用
    (d11 / "audio" / "a.wav").write_bytes(b"x")
    (d11 / "audio" / "b.wav").write_bytes(b"x")
    (d11 / "audio" / "c.wav").write_bytes(b"x")
    (d11 / "audio" / "c.analysis.wav").write_bytes(b"x")  # 中间转写件：不得计为孤儿
    (d11 / "perception.jsonl").write_bytes(
        _row(type="voice", audio="daily/2026-10-11/audio/a.wav")  # 全路径命中
        + _row(type="voice", audio="audio/b.wav")                 # 旧 schema，仅 basename
        + _row(type="notify", key="k"))                            # 无音频
    return base


def test_three_way_classification(tmp_path):
    base = _tree(tmp_path)
    refs_full, refs_base = ao.collect_references(str(base))
    s = ao.audit_day(str(base), "2026-10-11", refs_full, refs_base)
    assert s["analyzed"] == 1 and s["probable"] == 1 and s["orphan"] == 1
    assert s["orphan_samples"] == ["daily/2026-10-11/audio/c.wav"]


def test_run_read_only_and_dates(tmp_path, capsys):
    base = _tree(tmp_path)
    before = {p: p.stat().st_mtime_ns for p in base.rglob("*") if p.is_file()}
    rc = ao.run(str(base), ["2026-10-11"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "orphan=1" in out
    assert {p: p.stat().st_mtime_ns for p in base.rglob("*") if p.is_file()} == before
    assert ao.run(str(base / "nope"), None) == 1
