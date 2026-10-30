# -*- coding: utf-8 -*-
"""backfill_audio_kernel.py 契约测试（tmp 树；分析入口全部打桩，绝不触内核）。"""
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "_backfill_audio_kernel_mod",
    _REPO_ROOT / "scripts" / "backfill_audio_kernel.py",
)
bf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bf)

_DATE = "2026-10-21"
_OLD_MS = 1600000000000
_OLD_NAME = f"143430-143524_手机_{_OLD_MS}.flac"


def _tree(tmp_path: Path, names: list[str], refs: list[str] | None = None) -> Path:
    base = tmp_path / "daily"
    audio_dir = base / _DATE / "audio"
    audio_dir.mkdir(parents=True)
    for name in names:
        (audio_dir / name).write_bytes(b"x")
    rows = "".join(
        json.dumps({"type": "voice", "audio": ref}, ensure_ascii=False) + "\n"
        for ref in refs or []
    )
    (base / _DATE / "perception.jsonl").write_text(rows, encoding="utf-8")
    return base


def _options(base: Path, **kw) -> "bf.Options":
    return bf.Options(dates=(_DATE,), scan_all=False, data_base=str(base), **kw)


def _names(targets) -> list[str]:
    return [target.path.name for target in targets]


def test_parse_start_epoch_ms():
    assert bf._parse_start_epoch_ms("143430-143524_手机_1792564470263.flac") == 1792564470263
    assert bf._parse_start_epoch_ms("part_1792564470263.wav") == 1792564470263
    assert bf._parse_start_epoch_ms("no-suffix.wav") is None


def test_parse_device_name():
    name = "143430-143524_手机_1792564470263.flac"
    assert bf._parse_device_name(name, "") == "手机"
    assert bf._parse_device_name(name, "PC") == "PC"
    assert bf._parse_device_name("random.wav", "") == ""


def test_dedupe_uses_full_path_and_basename(tmp_path):
    base = _tree(
        tmp_path,
        ["a.wav", "b.wav", "c.wav"],
        refs=[f"daily/{_DATE}/audio/a.wav", "audio/b.wav"],
    )
    targets, _ = bf._iter_targets(_options(base, min_age_s=0), base, bf._now_ms())
    selected, skipped = bf._select_targets(
        targets, bf._load_references(base), _options(base, min_age_s=0)
    )
    assert _names(selected) == ["c.wav"]
    assert skipped == 2


def test_force_includes_referenced(tmp_path):
    base = _tree(
        tmp_path,
        ["a.wav", "b.wav"],
        refs=[f"daily/{_DATE}/audio/a.wav", "audio/b.wav"],
    )
    targets, _ = bf._iter_targets(_options(base, min_age_s=0), base, bf._now_ms())
    selected, skipped = bf._select_targets(
        targets, bf._load_references(base), _options(base, min_age_s=0, force=True)
    )
    assert _names(selected) == ["a.wav", "b.wav"]
    assert skipped == 0


def test_skips_analysis_wav_and_recent_files(tmp_path):
    now_ms = int(time.time() * 1000)
    base = _tree(
        tmp_path,
        [
            f"old_{_OLD_MS}.wav",
            f"recent_{now_ms}.wav",
            f"old_{_OLD_MS}.analysis.wav",
            "note.txt",
        ],
    )
    targets, recent_skipped = bf._iter_targets(
        _options(base), base, bf._now_ms()
    )
    assert _names(targets) == [f"old_{_OLD_MS}.wav"]
    assert recent_skipped == 1


def test_dry_run_does_not_analyze(tmp_path, monkeypatch, capsys):
    base = _tree(tmp_path, [_OLD_NAME])
    monkeypatch.setattr(bf, "_preflight", lambda: pytest.fail("dry-run 不得预检内核"))
    monkeypatch.setattr(
        bf, "analyze_audio_file", lambda *a, **k: pytest.fail("dry-run 不得分析")
    )

    rc = bf.run(_options(base, dry_run=True, sleep_s=0, min_age_s=0))

    out = capsys.readouterr().out
    assert rc == 0
    assert _OLD_NAME in out
    assert "summary" in out


def test_analyze_calls_pipeline_with_origin_upload(tmp_path, monkeypatch):
    base = _tree(tmp_path, [_OLD_NAME])
    calls: list[dict] = []

    def fake(path, start_epoch_ms, device_name="", ts_val=None, origin="upload", attempt=0):
        calls.append({
            "path": path,
            "start_epoch_ms": start_epoch_ms,
            "device_name": device_name,
            "ts_val": ts_val,
            "origin": origin,
            "attempt": attempt,
        })
        return "ok"

    monkeypatch.setattr(bf, "_preflight", lambda: None)
    monkeypatch.setattr(bf, "analyze_audio_file", fake)

    rc = bf.run(_options(base, sleep_s=0, min_age_s=0))

    assert rc == 0
    assert len(calls) == 1
    assert calls[0] == {
        "path": str(base / _DATE / "audio" / _OLD_NAME),
        "start_epoch_ms": _OLD_MS,
        "device_name": "手机",
        "ts_val": None,
        "origin": "upload",
        "attempt": 0,
    }


def test_skips_undated_files(tmp_path, monkeypatch, capsys):
    base = _tree(tmp_path, ["193622_default.wav", f"old_{_OLD_MS}.flac"])
    calls: list[str] = []

    def fake(path, *args, **kwargs):
        calls.append(path)
        return "ok"

    monkeypatch.setattr(bf, "_preflight", lambda: None)
    monkeypatch.setattr(bf, "analyze_audio_file", fake)

    rc = bf.run(_options(base, sleep_s=0, min_age_s=0))

    assert rc == 0
    assert len(calls) == 1
    assert calls[0].endswith(f"old_{_OLD_MS}.flac")
    assert "无 13 位时间戳的未分析文件" in capsys.readouterr().out


def test_recheck_skips_file_referenced_during_batch(tmp_path, monkeypatch):
    names = [f"first_{_OLD_MS}.flac", f"second_{_OLD_MS}.flac"]
    base = _tree(tmp_path, names)
    calls: list[str] = []

    def fake(path, *args, **kwargs):
        calls.append(path)
        # 模拟外部流水线在批处理中途为第二个文件写入了 voice 行
        with (base / _DATE / "perception.jsonl").open("a", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {"type": "voice", "audio": f"daily/{_DATE}/audio/{names[1]}"},
                    ensure_ascii=False,
                )
                + "\n"
            )
        return "ok"

    monkeypatch.setattr(bf, "_preflight", lambda: None)
    monkeypatch.setattr(bf, "analyze_audio_file", fake)

    rc = bf.run(_options(base, sleep_s=0, min_age_s=0))

    assert rc == 0
    assert len(calls) == 1
    assert calls[0].endswith(names[0])


def test_stops_on_retry(tmp_path, monkeypatch, capsys):
    names = [f"first_{_OLD_MS}.flac", f"second_{_OLD_MS}.flac"]
    base = _tree(tmp_path, names)
    calls: list[str] = []

    def fake(path, *args, **kwargs):
        calls.append(path)
        return "retry"

    monkeypatch.setattr(bf, "_preflight", lambda: None)
    monkeypatch.setattr(bf, "analyze_audio_file", fake)

    rc = bf.run(_options(base, sleep_s=0, min_age_s=0))

    assert rc == 2
    assert len(calls) == 1
    assert "retry" in capsys.readouterr().err


@pytest.mark.skipif(os.name == "nt", reason="POSIX 预检")
def test_requires_kernel_python_on_posix(tmp_path, monkeypatch, capsys):
    base = _tree(tmp_path, [_OLD_NAME])
    monkeypatch.delenv("AXEUH_KERNEL_PYTHON", raising=False)
    monkeypatch.setattr(
        bf, "analyze_audio_file", lambda *a, **k: pytest.fail("预检失败不得分析")
    )

    rc = bf.run(_options(base, sleep_s=0, min_age_s=0))

    assert rc == 3
    assert "AXEUH_KERNEL_PYTHON" in capsys.readouterr().err


def test_preflight_aborts_when_kernel_not_healthy(tmp_path, monkeypatch, capsys):
    from services import kernel_client as kc

    base = _tree(tmp_path, [_OLD_NAME])
    pidfile = tmp_path / "kernel.pid"
    pidfile.write_text(
        json.dumps({"port": 59999, "pid": os.getpid(), "api_version": "1.0.0"}),
        encoding="utf-8",
    )
    monkeypatch.setenv("AXEUH_KERNEL_PYTHON", "/opt/kinship/.venv-kernel/bin/python")
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(kc, "_probe_health", lambda port, timeout=1.5: False)
    monkeypatch.setattr(
        bf, "analyze_audio_file", lambda *a, **k: pytest.fail("预检失败不得分析")
    )

    rc = bf.run(_options(base, sleep_s=0, min_age_s=0))

    assert rc == 3
    assert "/v1/health" in capsys.readouterr().err


def test_cli_requires_dates_or_all():
    with pytest.raises(SystemExit) as ei:
        bf.main([])
    assert ei.value.code == 2
