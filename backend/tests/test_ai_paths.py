# -*- coding: utf-8 -*-
"""AI 子系统路径接线：wake_word / unknown_speaker / kernel cohort / Loom / mobile。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from config.config import Config


@pytest.fixture(autouse=True)
def _reset_caches():
    from services import audio_config, unknown_speaker_config

    audio_config.invalidate_audio_config()
    unknown_speaker_config.invalidate_unknown_speaker_config()
    yield
    audio_config.invalidate_audio_config()
    unknown_speaker_config.invalidate_unknown_speaker_config()


def test_wake_word_defaults_follow_ai_root(monkeypatch, tmp_path):
    from services import audio_config

    ai = tmp_path / "custom-ai"
    monkeypatch.setattr(
        audio_config, "get_config", lambda: Config({"data": {"ai_root": str(ai)}})
    )

    wake = audio_config.get_audio_config()["wake_word"]

    assert wake["keywords_file"] == str(ai / "data" / "wake_word" / "keywords.txt")
    assert wake["model_dir"] == str(
        ai
        / "data"
        / "wake_word"
        / "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20"
    )


def test_wake_word_explicit_paths_win(monkeypatch, tmp_path):
    from services import audio_config

    ai = tmp_path / "custom-ai"
    keywords = tmp_path / "elsewhere" / "keywords.txt"
    model = tmp_path / "elsewhere" / "kws-model"
    monkeypatch.setattr(
        audio_config,
        "get_config",
        lambda: Config(
            {
                "data": {"ai_root": str(ai)},
                "audio": {
                    "wake_word": {
                        "keywords_file": str(keywords),
                        "model_dir": str(model),
                    }
                },
            }
        ),
    )

    wake = audio_config.get_audio_config()["wake_word"]

    assert wake["keywords_file"] == str(keywords)
    assert wake["model_dir"] == str(model)


def test_unknown_speaker_defaults_follow_ai_root(monkeypatch, tmp_path):
    from services import unknown_speaker_config

    ai = tmp_path / "custom-ai"
    monkeypatch.setattr(
        unknown_speaker_config,
        "get_config",
        lambda: Config({"data": {"ai_root": str(ai)}}),
    )

    cfg = unknown_speaker_config.get_unknown_speaker_config()
    cache = ai / "data" / "cache"

    assert cfg["audio_archive"]["root"] == str(cache / "unknown_audio")
    assert cfg["storage"]["unknown_db"] == str(cache / "unknown_speakers.jsonl")
    assert cfg["storage"]["audit_log"] == str(cache / "unknown_audit.jsonl")
    assert cfg["storage"]["scan_state"] == str(cache / "unknown_scan_state.json")
    assert cfg["storage"]["pending_db"] == str(
        cache / "unknown_pending_sessions.jsonl"
    )
    assert cfg["storage"]["session_state"] == str(
        cache / "unknown_session_state.json"
    )


def test_unknown_speaker_explicit_storage_wins(monkeypatch, tmp_path):
    from services import unknown_speaker_config

    ai = tmp_path / "custom-ai"
    explicit = tmp_path / "elsewhere" / "unknown.jsonl"
    monkeypatch.setattr(
        unknown_speaker_config,
        "get_config",
        lambda: Config(
            {
                "data": {"ai_root": str(ai)},
                "unknown_speaker": {"storage": {"unknown_db": str(explicit)}},
            }
        ),
    )

    cfg = unknown_speaker_config.get_unknown_speaker_config()

    assert cfg["storage"]["unknown_db"] == str(explicit)


def test_kernel_cohort_seed_reads_ai_root(monkeypatch, tmp_path):
    import config.config as config_module
    from services import kernel_client

    ai = tmp_path / "custom-ai"
    cohort = ai / "data" / "cache" / "cohort_active.jsonl"
    cohort.parent.mkdir(parents=True)
    cohort.write_text('{"id": "seed"}\n', encoding="utf-8")

    monkeypatch.setattr(
        config_module, "get_config", lambda: Config({"data": {"ai_root": str(ai)}})
    )
    state_dir = tmp_path / "kernel-state"

    kernel_client.KernelClient._seed_state_from_outer(state_dir)

    seeded = state_dir / "voiceprint" / "cohort_active.jsonl"
    assert seeded.read_text(encoding="utf-8") == '{"id": "seed"}\n'


def test_loom_instance_root_uses_config_ai_root(tmp_path):
    from services.orchestrator.loom_spec import loom_instance_root

    ai = tmp_path / "custom-ai"
    cfg = Config({"data": {"ai_root": str(ai)}})

    assert loom_instance_root(cfg) == ai.resolve()


def test_mobile_report_scan_stays_relative_to_ai_root(monkeypatch, tmp_path):
    import routers.mobile as mobile

    ai = tmp_path / "custom-ai"
    day = ai / "data" / "daily" / "2026-10-26"
    day.mkdir(parents=True)
    (day / "健康清单-2026-10-26.md").write_text(
        "---\ndate: 2026-10-26\n---\n# 清单\n", encoding="utf-8"
    )
    cfg = SimpleNamespace(AI_ROOT=str(ai), DATA_DIR=str(ai / "data"))
    monkeypatch.setattr(mobile, "get_config", lambda: cfg)

    rows = mobile._scan_report_files()

    assert [row["title"] for row in rows] == ["清单"]
