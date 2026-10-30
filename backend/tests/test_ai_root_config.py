# -*- coding: utf-8 -*-
"""data.ai_root 单一 AI 根：解析顺序、派生默认、显式覆盖与独立性。"""
from __future__ import annotations

import pytest

from config.config import Config


@pytest.fixture(autouse=True)
def _project_root(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("AXEUH_PROJECT_ROOT", str(project))
    return project


def test_explicit_ai_root_wins(tmp_path):
    ai = tmp_path / "srv" / "ai"
    cfg = Config({"data": {"ai_root": str(ai), "dir": str(ai / "elsewhere")}})

    assert cfg.AI_ROOT == str(ai)
    assert cfg.DATA_DIR == str(ai / "elsewhere")


def test_unset_derived_paths_follow_ai_root(tmp_path):
    ai = tmp_path / "srv" / "ai"
    cfg = Config({"data": {"ai_root": str(ai)}})

    assert cfg.DATA_DIR == str(ai / "data")
    assert cfg.HEALTH_DIR == str(ai / "data")
    assert cfg.SESSIONS_PATH == str(ai / "data" / "cache" / "usersessions.json")
    assert cfg.VOICEPRINTS_PATH == str(ai / "data" / "cache" / "voiceprints.json")
    assert cfg.TASKS_DIR == str(ai / "data")
    assert cfg.UPLOAD_DIR == str(ai / "data" / "uploads")
    assert cfg.TASK_LOGS_DIR == str(ai / "data" / "tasks" / "logs")
    assert cfg.STREAM_DIR == str(ai / "data" / "stream")
    assert cfg.SCRIPTS_DIR == str(ai / "data" / "tasks")
    assert cfg.HEALTH_DEVICES_PATH == str(
        ai / "data" / "health" / "health_devices.json"
    )
    assert cfg.HEALTH_SOURCE_SELECTION_PATH == str(
        ai / "data" / "health" / "health_source_selection.json"
    )
    assert cfg.HEALTH_CLOUD_STATE_PATH == str(
        ai / "data" / "health" / "health_cloud_state.json"
    )
    assert cfg.OPENCODE_DIRECTORY == str(ai)


def test_explicit_child_key_overrides_ai_root(tmp_path):
    ai = tmp_path / "srv" / "ai"
    custom_data = tmp_path / "custom-data"
    custom_sessions = tmp_path / "custom-sessions.json"
    custom_scripts = tmp_path / "custom-scripts"
    cfg = Config(
        {
            "data": {
                "ai_root": str(ai),
                "dir": str(custom_data),
                "sessions": str(custom_sessions),
                "tasks": str(tmp_path / "custom-tasks"),
                "voiceprints": str(tmp_path / "custom-voiceprints.json"),
                "upload_dir": str(tmp_path / "custom-uploads"),
                "task_logs": str(tmp_path / "custom-logs"),
                "stream_dir": str(tmp_path / "custom-stream"),
            },
            "scripts": {"dir": str(custom_scripts)},
        }
    )

    assert cfg.DATA_DIR == str(custom_data)
    assert cfg.SESSIONS_PATH == str(custom_sessions)
    assert cfg.TASKS_DIR == str(tmp_path / "custom-tasks")
    assert cfg.VOICEPRINTS_PATH == str(tmp_path / "custom-voiceprints.json")
    assert cfg.UPLOAD_DIR == str(tmp_path / "custom-uploads")
    assert cfg.TASK_LOGS_DIR == str(tmp_path / "custom-logs")
    assert cfg.STREAM_DIR == str(tmp_path / "custom-stream")
    assert cfg.SCRIPTS_DIR == str(custom_scripts)
    assert cfg.HEALTH_DEVICES_PATH == str(
        ai / "data" / "health" / "health_devices.json"
    )


def test_runtime_model_and_kernel_paths_do_not_move_with_ai_root(tmp_path):
    data_root = tmp_path / "runtime"
    models = tmp_path / "models"
    kernel_state = tmp_path / "kernel-state"
    kernel_models = tmp_path / "kernel-models"
    cfg = Config(
        {
            "data": {"ai_root": str(tmp_path / "ai-a"), "root": str(data_root)},
            "models": {"dir": str(models)},
            "kernel": {
                "state_dir": str(kernel_state),
                "model_dir": str(kernel_models),
            },
        }
    )

    assert cfg.DATA_ROOT == str(data_root)
    assert cfg.MODELS_DIR == str(models)
    assert cfg.KERNEL_STATE_DIR == str(kernel_state)
    assert cfg.KERNEL_MODEL_DIR == str(kernel_models)

    moved = Config(
        {
            "data": {"ai_root": str(tmp_path / "ai-b"), "root": str(data_root)},
            "models": {"dir": str(models)},
            "kernel": {
                "state_dir": str(kernel_state),
                "model_dir": str(kernel_models),
            },
        }
    )

    assert moved.DATA_ROOT == cfg.DATA_ROOT
    assert moved.MODELS_DIR == cfg.MODELS_DIR
    assert moved.KERNEL_STATE_DIR == cfg.KERNEL_STATE_DIR
    assert moved.KERNEL_MODEL_DIR == cfg.KERNEL_MODEL_DIR


def test_legacy_config_without_ai_root_resolves_project_ai(_project_root):
    cfg = Config({})

    assert cfg.AI_ROOT == str(_project_root / "ai")
    assert cfg.DATA_DIR == str(_project_root / "ai" / "data")


def test_legacy_data_dir_without_ai_root_derives_parent(_project_root):
    cfg = Config({"data": {"dir": "custom/data"}})

    assert cfg.AI_ROOT == str(_project_root / "custom")
    assert cfg.DATA_DIR == str(_project_root / "custom" / "data")


def test_blank_ai_root_is_treated_as_unset(_project_root):
    cfg = Config({"data": {"ai_root": "   ", "dir": "custom/data"}})

    assert cfg.AI_ROOT == str(_project_root / "custom")
    assert cfg.DATA_DIR == str(_project_root / "custom" / "data")


def test_schema_registers_ai_root_and_derived_defaults():
    from config.config_schema import defaults_document, get_field

    assert get_field("data.ai_root") is not None
    doc = defaults_document()
    data = doc["data"]
    assert data["ai_root"] == ""
    assert data["dir"] == ""
    assert data["sessions"] == ""
    assert data["tasks"] == ""
    assert data["voiceprints"] == ""
    assert doc["scripts"]["dir"] == ""


def test_relative_ai_root_resolves_against_project_root(_project_root):
    cfg = Config({"data": {"ai_root": "custom-ai"}})

    assert cfg.AI_ROOT == str(_project_root / "custom-ai")
    assert cfg.DATA_DIR == str(_project_root / "custom-ai" / "data")
