# -*- coding: utf-8 -*-
"""config_schema 单一真源契约：核心字段、全量叶子、掩码、校验与变更合并。"""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
import yaml

from config.config_schema import (
    ADVANCED_FIELDS,
    CATEGORIES,
    CORE_FIELDS,
    DEPRECATED_PATHS,
    ERROR_CODES,
    FIELDS,
    SCHEMA_VERSION,
    SchemaError,
    apply_strategy_for_path,
    defaults_document,
    get_field,
    has_blocking_errors,
    iter_leaf_paths,
    mask_document,
    validate_changes,
    validate_document,
)

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "config.example.yaml"
DEAD_TOP_LEVELS = {"log", "voiceprint", "memory", "agent"}
APPLY_STRATEGIES = {"hot", "reconnect", "respawn", "deployment", "none"}

EXPECTED_SENSITIVE = {
    "loom.token",
    "loom.token_file",
    "loom.credentials_file",
    "api.mimo_key",
    "api.dashscope_key",
    "api.baidu_map_ak",
    "opencode.server_password",
    "health.cloud.userid",
    "health.cloud.passtoken",
    "qq_gateway.account.ws_token_file",
    "qq_gateway.mcp.token_file",
}


def _set(doc, path: str, value) -> None:
    parts = path.split(".")
    node = doc
    for part in parts[:-1]:
        child = node.get(part)
        if not isinstance(child, dict):
            child = {}
            node[part] = child
        node = child
    node[parts[-1]] = value


def _get(doc, path: str):
    node = doc
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def _errors(doc, project_root=None) -> list[SchemaError]:
    return validate_document(doc, project_root=project_root)


def test_schema_version_is_one():
    assert SCHEMA_VERSION == 1


def test_core_fields_exactly_56_and_unique():
    assert len(CORE_FIELDS) == 56
    assert len({f.path for f in CORE_FIELDS}) == 56


def test_all_field_paths_unique():
    paths = [f.path for f in FIELDS]
    assert len(paths) == len(set(paths))


def test_core_fields_are_in_fields_and_flagged():
    indexed = {f.path: f for f in FIELDS}
    for field in CORE_FIELDS:
        assert indexed[field.path] is field
        assert field.core is True
        assert field.advanced is False
    for field in ADVANCED_FIELDS:
        assert field.core is False
        assert field.advanced is True


def test_core_paths_match_approved_list():
    expected = {
        "server.host",
        "server.port",
        "data.ai_root",
        "data.dir",
        "data.root",
        "models.dir",
        "ssl.enabled",
        "ssl.cert",
        "ssl.key",
        "auth.setup_require_token",
        "onboarding.release_manifest_url",
        "onboarding.release_base_url",
        "onboarding.frontend_autodownload",
        "onboarding.kernel_release_tag",
        "onboarding.allow_model_download",
        "onboarding.model_tiers",
        "ai_backend",
        "opencode.enabled",
        "opencode.directory",
        "opencode.url",
        "opencode.default_agent",
        "opencode.default_model",
        "opencode.default_provider",
        "loom.url",
        "loom.token",
        "api.mimo_key",
        "tts.enabled",
        "tts.device_channel_ttl_seconds",
        "qq_gateway.enabled",
        "qq_gateway.account.self_qq",
        "qq_gateway.account.ws_url",
        "p2p.enabled",
        "p2p.signal_url",
        "p2p.server_id",
        "p2p.pairing_code_ttl_seconds",
        "kernel.device",
        "kernel.python",
        "kernel.model_dir",
        "moss.enabled",
        "moss.python",
        "moss.base_url",
        "moss.model",
        "health.cloud_poll_interval_min",
        "audio.store.upload_ext",
        "audio.stream.silence_cut_s",
        "audio.stream.force_cut_s",
        "audio.stream.stitch_enabled",
        "audio.wake_word.enabled",
        "audio.wake_word.keywords_file",
        "audio.wake_word.keywords_threshold",
        "clients.android_url",
        "clients.android_sha256",
        "clients.desktop_url",
        "clients.desktop_sha256",
        "clients.github_release_tag",
        "clients.github_release_base",
    }
    assert {f.path for f in CORE_FIELDS} == expected


def test_categories_are_ordered_unique_and_used():
    ids = [category["id"] for category in CATEGORIES]
    assert len(ids) == len(set(ids))
    assert all(set(category) == {"id", "title", "description", "advanced"} for category in CATEGORIES)
    used = {field.category for field in FIELDS}
    assert used == set(ids)
    core_categories = {field.category for field in CORE_FIELDS}
    assert core_categories <= set(ids)


def test_deprecated_paths_absent_from_fields():
    field_paths = {field.path for field in FIELDS}
    assert DEPRECATED_PATHS
    assert not (DEPRECATED_PATHS & field_paths)
    assert "log.level" in DEPRECATED_PATHS
    assert "voiceprint.min_snr" in DEPRECATED_PATHS


def test_example_parity_covers_every_live_leaf():
    doc = yaml.safe_load(EXAMPLE.read_text(encoding="utf-8"))
    fields = {field.path for field in FIELDS}
    missing = [
        path
        for path in iter_leaf_paths(doc)
        if path.split(".")[0] not in DEAD_TOP_LEVELS and path not in fields
    ]
    assert missing == []


def test_example_contains_new_core_template_keys():
    doc = yaml.safe_load(EXAMPLE.read_text(encoding="utf-8"))
    assert doc["ssl"] == {"enabled": False, "cert": "", "key": ""}
    assert doc["auth"]["setup_require_token"] is True
    assert doc["api"]["baidu_map_ak"] == ""


def test_sensitive_paths_are_exactly_the_approved_set():
    assert {field.path for field in FIELDS if field.sensitive} == EXPECTED_SENSITIVE


def test_mask_document_masks_qq_token_file_paths():
    doc = defaults_document()
    _set(doc, "qq_gateway.account.ws_token_file", "/var/secrets/qq_ws_token")
    _set(doc, "qq_gateway.mcp.token_file", "/var/secrets/qq_mcp_token")

    masked = mask_document(doc)

    assert masked["qq_gateway"]["account"]["ws_token_file"] == "***"
    assert masked["qq_gateway"]["mcp"]["token_file"] == "***"


def test_mask_document_masks_only_non_empty_sensitive_values():
    doc = defaults_document()
    for path in EXPECTED_SENSITIVE:
        _set(doc, path, "secret-value")
    _set(doc, "api.dashscope_key", "dashscope-secret")
    _set(doc, "loom.token", "")
    original = copy.deepcopy(doc)

    masked = mask_document(doc)

    assert masked["loom"]["token"] == ""
    assert masked["loom"]["token_file"] == "***"
    assert masked["loom"]["credentials_file"] == "***"
    assert masked["api"]["mimo_key"] == "***"
    assert masked["api"]["dashscope_key"] == "***"
    assert masked["api"]["baidu_map_ak"] == "***"
    assert masked["opencode"]["server_password"] == "***"
    assert masked["health"]["cloud"]["userid"] == "***"
    assert masked["health"]["cloud"]["passtoken"] == "***"
    assert doc == original
    assert masked is not doc


def test_mask_document_preserves_unknown_keys():
    doc = {"unknown": {"nested": 1}, "loom": {"token": "abc"}}
    masked = mask_document(doc)
    assert masked["unknown"] == {"nested": 1}
    assert masked["loom"]["token"] == "***"
    assert doc["loom"]["token"] == "abc"


def test_mask_document_masks_unknown_secret_paths():
    doc = {
        "qq_gateway": {
            "account": {"ws_token": "ws-secret", "ws_token_env": "NAPCAT_WS_TOKEN"},
            "mcp": {"token": "mcp-secret", "token_file": ""},
        },
        "api": {"deepseek_key": "sk-deepseek-secret"},
        "ssl": {"key": "/etc/kinship/key.pem"},
        "p2p": {"allow_shared_token": False},
        "auth": {"setup_require_token": True},
        "custom": {
            "future": "keep-me",
            "retries_key": 3,
            "nested": {"password": "nested-secret"},
        },
    }

    masked = mask_document(doc)

    assert masked["qq_gateway"]["account"]["ws_token"] == "***"
    assert masked["qq_gateway"]["account"]["ws_token_env"] == "NAPCAT_WS_TOKEN"
    assert masked["qq_gateway"]["mcp"]["token"] == "***"
    assert masked["qq_gateway"]["mcp"]["token_file"] == ""
    assert masked["api"]["deepseek_key"] == "***"
    assert masked["ssl"]["key"] == "/etc/kinship/key.pem"
    assert masked["p2p"]["allow_shared_token"] is False
    assert masked["auth"]["setup_require_token"] is True
    assert masked["custom"]["future"] == "keep-me"
    assert masked["custom"]["retries_key"] == "***"
    assert masked["custom"]["nested"]["password"] == "***"
    assert doc["qq_gateway"]["account"]["ws_token"] == "ws-secret"
    assert doc["custom"]["future"] == "keep-me"


def test_defaults_have_no_placeholders():
    defaults = defaults_document()
    markers = ("YOUR_", "path/to/your", "example.com")
    strings = []

    def walk(value):
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, str):
            strings.append(value)

    walk(defaults)

    for value in strings:
        for marker in markers:
            assert marker not in value, (marker, value)
    assert defaults["health"]["primary_user"] == ""
    assert defaults["launcher"]["conda_python"] == "python"
    assert defaults["launcher"]["opencode_cmd"] == "opencode"
    assert defaults["api"]["mimo_key"] == ""
    assert defaults["loom"]["token"] == ""


def test_defaults_are_a_valid_document_and_ssl_is_coherent():
    defaults = defaults_document()
    assert defaults["ssl"]["enabled"] is False
    assert defaults["ssl"]["cert"] == ""
    assert defaults["ssl"]["key"] == ""
    assert validate_document(defaults) == []


def test_defaults_document_can_boot_degraded():
    defaults = defaults_document()
    errors = validate_document(defaults)
    assert has_blocking_errors(errors) is False
    assert has_blocking_errors(validate_document(defaults, strict=True)) is False


def test_defaults_document_returns_independent_copies():
    first = defaults_document()
    first["tts"]["fallback_client_types"].append("mutated")
    first["p2p"]["webrtc"]["stun_servers"].append("stun:mutated")
    second = defaults_document()
    assert second["tts"]["fallback_client_types"] == ["web"]
    assert second["p2p"]["webrtc"]["stun_servers"] == ["stun:stun.l.google.com:19302"]


def test_iter_leaf_paths_handles_nested_lists_and_empty_dicts():
    assert iter_leaf_paths({"a": {"b": 1}, "c": [1, 2], "d": {}}) == ["a.b", "c", "d"]
    assert iter_leaf_paths({}) == []
    assert iter_leaf_paths(None) == []


def test_get_field_finds_core_and_advanced_and_misses_unknown():
    assert get_field("server.host") is not None
    assert get_field("server.host").core is True
    assert get_field("audio.stream.sample_rate").advanced is True
    assert get_field("does.not.exist") is None


def test_opencode_default_fields_missing_is_warning_unless_strict():
    doc = defaults_document()
    del doc["opencode"]["default_agent"]
    del doc["opencode"]["default_model"]
    del doc["opencode"]["default_provider"]

    errors = validate_document(doc)

    missing = [error for error in errors if error.code == "required_missing"]
    assert {
        "opencode.default_agent",
        "opencode.default_model",
        "opencode.default_provider",
    } <= {error.path for error in missing}
    assert all(error.severity == "warning" for error in missing)
    assert has_blocking_errors(errors) is False

    strict_errors = validate_document(doc, strict=True)

    strict_missing = [error for error in strict_errors if error.code == "required_missing"]
    assert strict_missing
    assert all(error.severity == "error" for error in strict_missing)
    assert has_blocking_errors(strict_errors) is True


def test_schema_error_defaults_to_error_severity():
    error = SchemaError("server.host", "type_mismatch", "boom")
    assert error.severity == "error"


def test_validate_document_allows_unknown_keys_and_does_not_mutate():
    doc = defaults_document()
    doc["custom_section"] = {"future_key": 1}
    before = copy.deepcopy(doc)
    assert validate_document(doc) == []
    assert doc == before


def test_validate_document_reports_deprecated_keys_as_warnings():
    doc = defaults_document()
    _set(doc, "log.level", "DEBUG")
    errors = validate_document(doc)
    deprecated = [error for error in errors if error.code == "deprecated_key"]
    assert any(error.path == "log.level" for error in deprecated)
    assert all(error.severity == "warning" for error in deprecated)
    assert has_blocking_errors(errors) is False


def test_validate_document_rejects_non_mapping_root():
    errors = validate_document(["not", "a", "dict"])
    assert len(errors) == 1
    assert errors[0].code == "type_mismatch"
    assert errors[0].severity == "error"


def test_hard_errors_remain_blocking_without_strict():
    doc = defaults_document()
    _set(doc, "kernel.device", "tpu")
    errors = validate_document(doc)
    assert has_blocking_errors(errors) is True
    assert all(error.severity == "error" for error in errors)


def test_missing_required_value_is_warning_not_blocking():
    doc = defaults_document()
    _set(doc, "server.host", "")
    errors = validate_document(doc)
    missing = [error for error in errors if error.code == "required_missing"]
    assert missing
    assert all(error.severity == "warning" for error in missing)
    assert has_blocking_errors(errors) is False


@pytest.mark.parametrize(
    ("path", "value", "expected_path", "expected_code"),
    [
        ("server.host", "", "server.host", "required_missing"),
        ("server.port", 0, "server.port", "out_of_range"),
        ("server.port", 70000, "server.port", "out_of_range"),
        ("ai_backend", "invalid", "ai_backend", "enum_invalid"),
        ("opencode.url", "", "opencode.url", "required_missing"),
        ("opencode.default_agent", "", "opencode.default_agent", "required_missing"),
        ("opencode.default_model", "", "opencode.default_model", "required_missing"),
        ("opencode.default_provider", "", "opencode.default_provider", "required_missing"),
        ("opencode.enabled", 1, "opencode.enabled", "type_mismatch"),
        ("tts.device_channel_ttl_seconds", 59, "tts.device_channel_ttl_seconds", "range_invalid"),
        ("tts.device_channel_ttl_seconds", 86401, "tts.device_channel_ttl_seconds", "range_invalid"),
        ("kernel.device", "tpu", "kernel.device", "enum_invalid"),
        ("health.cloud_poll_interval_min", 4, "health.cloud_poll_interval_min", "range_invalid"),
        ("health.cloud_poll_interval_min", 1441, "health.cloud_poll_interval_min", "range_invalid"),
        ("audio.store.upload_ext", "mp3", "audio.store.upload_ext", "enum_invalid"),
        ("audio.stream.silence_cut_s", 0.2, "audio.stream.silence_cut_s", "range_invalid"),
        ("audio.stream.silence_cut_s", "1.5", "audio.stream.silence_cut_s", "type_mismatch"),
        ("audio.stream.force_cut_s", 301, "audio.stream.force_cut_s", "range_invalid"),
        ("audio.wake_word.keywords_threshold", 1.2, "audio.wake_word.keywords_threshold", "range_invalid"),
        ("p2p.pairing_code_ttl_seconds", 59, "p2p.pairing_code_ttl_seconds", "range_invalid"),
        ("p2p.pairing_code_ttl_seconds", 901, "p2p.pairing_code_ttl_seconds", "range_invalid"),
        ("p2p.room", 123, "p2p.room", "type_mismatch"),
        ("qq_gateway.account.peer_allowlist", "not-a-list", "qq_gateway.account.peer_allowlist", "type_mismatch"),
    ],
)
def test_field_level_validation_cases(path, value, expected_path, expected_code):
    doc = defaults_document()
    _set(doc, path, value)
    errors = validate_document(doc)
    assert any(error.path == expected_path and error.code == expected_code for error in errors), errors


def test_ssl_enabled_requires_cert_and_key():
    doc = defaults_document()
    _set(doc, "ssl.enabled", True)
    errors = validate_document(doc)
    paths = {error.path for error in errors if error.code == "required_missing"}
    assert {"ssl.cert", "ssl.key"} <= paths


def test_ssl_files_are_checked_against_project_root(tmp_path):
    doc = defaults_document()
    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    _set(doc, "ssl.enabled", True)
    _set(doc, "ssl.cert", str(cert))
    _set(doc, "ssl.key", str(key))

    errors = validate_document(doc, project_root=tmp_path)
    assert {error.path for error in errors if error.code == "cross_field"} == {"ssl.cert", "ssl.key"}

    cert.write_text("cert", encoding="utf-8")
    key.write_text("key", encoding="utf-8")
    assert validate_document(doc, project_root=tmp_path) == []


def test_loom_backend_requires_token_unless_env_is_set(monkeypatch):
    monkeypatch.delenv("LOOM_TOKEN", raising=False)
    doc = defaults_document()
    _set(doc, "ai_backend", "loom")
    errors = validate_document(doc)
    assert any(error.path == "loom.token" and error.code == "required_missing" for error in errors)

    monkeypatch.setenv("LOOM_TOKEN", "from-env")
    errors = validate_document(doc)
    assert not any(error.path == "loom.token" for error in errors)


def test_loom_backend_requires_url():
    doc = defaults_document()
    _set(doc, "ai_backend", "loom")
    _set(doc, "loom.url", "")
    errors = validate_document(doc)
    assert any(error.path == "loom.url" and error.code == "required_missing" for error in errors)


def test_qq_gateway_enabled_requires_digits_and_ws_scheme():
    doc = defaults_document()
    _set(doc, "qq_gateway.enabled", True)

    errors = validate_document(doc)
    assert any(error.path == "qq_gateway.account.self_qq" and error.code == "required_missing" for error in errors)

    _set(doc, "qq_gateway.account.self_qq", "12ab34")
    errors = validate_document(doc)
    assert any(error.path == "qq_gateway.account.self_qq" and error.code == "cross_field" for error in errors)

    _set(doc, "qq_gateway.account.self_qq", "123456")
    _set(doc, "qq_gateway.account.ws_url", "http://127.0.0.1:3001")
    errors = validate_document(doc)
    assert any(error.path == "qq_gateway.account.ws_url" and error.code == "cross_field" for error in errors)

    _set(doc, "qq_gateway.account.ws_url", "wss://127.0.0.1:3001")
    assert validate_document(doc) == []


def test_p2p_enabled_requires_signal_url_and_server_id():
    doc = defaults_document()
    _set(doc, "p2p.enabled", True)

    errors = validate_document(doc)
    assert any(error.path == "p2p.signal_url" and error.code == "required_missing" for error in errors)

    _set(doc, "p2p.signal_url", "wss://signal.example.test")
    _set(doc, "p2p.server_id", "")
    errors = validate_document(doc)
    assert any(error.path == "p2p.server_id" and error.code == "required_missing" for error in errors)


def test_advanced_fields_only_type_check_not_range():
    doc = defaults_document()
    _set(doc, "p2p.signal_ticket_ttl_seconds", 99999)
    assert validate_document(doc) == []
    _set(doc, "p2p.signal_ticket_ttl_seconds", "soon")
    errors = validate_document(doc)
    assert any(error.path == "p2p.signal_ticket_ttl_seconds" and error.code == "type_mismatch" for error in errors)


def test_error_codes_are_exactly_the_approved_set():
    assert ERROR_CODES == {
        "unknown_key",
        "type_mismatch",
        "enum_invalid",
        "range_invalid",
        "out_of_range",
        "required_missing",
        "cross_field",
        "deprecated_key",
    }


def test_advanced_type_inference_spot_checks():
    assert get_field("audio.stream.silence_cut_s").type == "float"
    assert get_field("audio.stream.stitch_enabled").type == "bool"
    assert get_field("qq_gateway.account.peer_allowlist").type == "list"
    assert get_field("qq_gateway.qzone.mode").type == "string"
    assert get_field("kernel.nice").type == "int"


@pytest.mark.parametrize(
    ("path", "strategy"),
    [
        ("server.host", "hot"),
        ("server.port", "hot"),
        ("ssl.enabled", "deployment"),
        ("ssl.cert", "deployment"),
        ("ssl.key", "deployment"),
        ("data.dir", "hot"),
        ("data.sessions", "hot"),
        ("auth.setup_require_token", "hot"),
        ("ai_backend", "hot"),
        ("loom.url", "hot"),
        ("opencode.enabled", "deployment"),
        ("opencode.url", "hot"),
        ("opencode.default_model", "hot"),
        ("opencode.server_password", "deployment"),
        ("opencode.server_username", "deployment"),
        ("api.mimo_key", "hot"),
        ("api.baidu_map_ak", "deployment"),
        ("tts.enabled", "hot"),
        ("audio.stream.sample_rate", "hot"),
        ("audio_compressor.enabled", "hot"),
        ("unknown_speaker.enabled", "hot"),
        ("health.cloud.enabled", "hot"),
        ("pc_sensor.exe_path", "hot"),
        ("ota.apk_dir", "hot"),
        ("scripts.dir", "hot"),
        ("features.opencode_mock_enabled", "hot"),
        ("qq_gateway.enabled", "reconnect"),
        ("qq_gateway.account.ws_url", "reconnect"),
        ("p2p.enabled", "reconnect"),
        ("p2p.webrtc.enabled", "reconnect"),
        ("kernel.device", "respawn"),
        ("kernel.state_dir", "respawn"),
        ("launcher.conda_python", "deployment"),
        ("launcher.opencode_cmd", "deployment"),
    ],
)
def test_apply_strategy_spot_checks(path, strategy):
    field = get_field(path)
    assert field is not None
    assert field.apply_strategy == strategy


def test_every_field_has_a_valid_apply_strategy():
    assert FIELDS
    for field in FIELDS:
        assert field.apply_strategy in APPLY_STRATEGIES, field.path
        assert field.apply_strategy != "none", field.path


@pytest.mark.parametrize(
    ("path", "sensitive"),
    [
        ("api.baidu_map_ak", True),
        ("opencode.server_password", True),
        ("opencode.server_username", False),
    ],
)
def test_build_time_credentials_are_deployment_boundaries(path, sensitive):
    field = get_field(path)
    assert field is not None
    assert field.sensitive is sensitive
    assert field.apply_strategy == "deployment"
    assert apply_strategy_for_path(path) == "deployment"


def test_kernel_device_enum_accepts_documented_gpu_and_auto_values():
    field = get_field("kernel.device")
    assert field is not None
    assert field.enum == ("cpu", "gpu", "auto", "cuda", "cuda:0", "cuda:1")

    for value in ("gpu", "auto", "cpu", "cuda:0"):
        doc = defaults_document()
        _set(doc, "kernel.device", value)
        assert validate_document(doc) == []


def test_deprecated_paths_map_to_none_strategy():
    assert get_field("log.level") is None
    assert "log.level" in DEPRECATED_PATHS
    assert apply_strategy_for_path("log.level") == "none"
    assert apply_strategy_for_path("not.a.real.key") is None
    assert apply_strategy_for_path("server.host") == "hot"


def test_restart_scope_property_is_a_derived_legacy_alias():
    assert get_field("server.host").restart_scope == "backend"
    assert get_field("data.dir").restart_scope == "backend"
    assert get_field("qq_gateway.enabled").restart_scope == "backend"
    assert get_field("kernel.device").restart_scope == "backend"
    assert get_field("launcher.conda_python").restart_scope == "supervisor"
    assert get_field("opencode.enabled").restart_scope == "supervisor"
    assert get_field("opencode.server_password").restart_scope == "supervisor"
    assert get_field("api.baidu_map_ak").restart_scope == "supervisor"


def test_validate_changes_merges_without_mutating_input():
    current = defaults_document()
    before = copy.deepcopy(current)

    merged, errors = validate_changes(current, {"server.host": "127.0.0.1", "tts.enabled": False})

    assert errors == []
    assert merged["server"]["host"] == "127.0.0.1"
    assert merged["tts"]["enabled"] is False
    assert current == before
    assert merged is not current


def test_validate_changes_preserves_unknown_keys():
    current = defaults_document()
    current["custom"] = {"future": 1}
    merged, errors = validate_changes(current, {"server.host": "127.0.0.1"})
    assert errors == []
    assert merged["custom"] == {"future": 1}


def test_validate_changes_rejects_unknown_path():
    current = defaults_document()
    merged, errors = validate_changes(current, {"not.a.real.key": 1})
    assert [error.code for error in errors] == ["unknown_key"]
    assert merged == current


def test_validate_changes_rejects_deprecated_path():
    current = defaults_document()
    merged, errors = validate_changes(current, {"log.level": "DEBUG"})
    assert [error.code for error in errors] == ["deprecated_key"]
    assert "log" not in merged


def test_validate_changes_sensitive_sentinel_and_empty_mean_unchanged():
    current = defaults_document()
    _set(current, "loom.token", "real-token")
    _set(current, "api.mimo_key", "real-key")

    merged, errors = validate_changes(current, {"loom.token": "***", "api.mimo_key": ""})

    assert errors == []
    assert merged["loom"]["token"] == "real-token"
    assert merged["api"]["mimo_key"] == "real-key"


def test_validate_changes_clears_sensitive_only_via_clear_keys():
    current = defaults_document()
    _set(current, "loom.token", "real-token")
    _set(current, "api.mimo_key", "real-key")

    merged, errors = validate_changes(current, {}, clear_keys=["loom.token", "api.mimo_key"])

    assert errors == []
    assert "token" not in merged["loom"]
    assert "mimo_key" not in merged["api"]


def test_validate_changes_rejects_unknown_or_deprecated_clear_keys():
    current = defaults_document()
    _, unknown_errors = validate_changes(current, {}, clear_keys=["not.a.key"])
    assert [error.code for error in unknown_errors] == ["unknown_key"]

    _, deprecated_errors = validate_changes(current, {}, clear_keys=["voiceprint.min_snr"])
    assert [error.code for error in deprecated_errors] == ["deprecated_key"]


def _production_shaped_document():
    doc = defaults_document()
    _set(doc, "log.level", "INFO")
    _set(doc, "voiceprint.min_snr", 15.0)
    _set(doc, "voiceprint.min_seg_snr", 1.0)
    _set(doc, "voiceprint.min_consistency", 0.55)
    _set(doc, "voiceprint.min_speech_ratio", 0.5)
    _set(doc, "voiceprint.min_duration", 3.0)
    return doc


def test_validate_changes_normal_save_with_legacy_keys_has_no_blocking_errors():
    merged, errors = validate_changes(
        _production_shaped_document(), {"tts.enabled": False}
    )

    assert merged["tts"]["enabled"] is False
    assert has_blocking_errors(errors) is False
    deprecated = [error for error in errors if error.code == "deprecated_key"]
    assert {error.path for error in deprecated} >= {
        "log.level",
        "voiceprint.min_snr",
    }
    assert all(error.severity == "warning" for error in deprecated)


def test_validate_changes_on_example_config_with_normal_change_has_no_blocking_errors():
    current = yaml.safe_load(EXAMPLE.read_text(encoding="utf-8"))

    merged, errors = validate_changes(
        current, {"tts.enabled": False}, project_root=ROOT
    )

    assert merged["tts"]["enabled"] is False
    assert has_blocking_errors(errors) is False
    assert [error for error in errors if error.code == "cross_field"] == []


def test_validate_changes_clears_existing_legacy_keys_without_blocking():
    current = _production_shaped_document()

    merged, errors = validate_changes(current, {}, clear_keys=["log"])
    assert "log" not in merged
    assert has_blocking_errors(errors) is False

    merged, errors = validate_changes(current, {}, clear_keys=["voiceprint.min_snr"])
    assert "min_snr" not in merged["voiceprint"]
    assert "log" in merged
    assert has_blocking_errors(errors) is False


def test_validate_changes_clear_missing_unknown_key_still_errors():
    _, errors = validate_changes(
        _production_shaped_document(), {}, clear_keys=["definitely.not.present"]
    )

    unknown = [error for error in errors if error.code == "unknown_key"]
    assert [error.path for error in unknown] == ["definitely.not.present"]
    assert unknown[0].severity == "error"
    assert has_blocking_errors(errors) is True


def test_validate_changes_allows_non_sensitive_empty_string():
    current = defaults_document()
    merged, errors = validate_changes(current, {"p2p.room": ""})
    assert errors == []
    assert merged["p2p"]["room"] == ""


def test_validate_changes_keeps_valid_changes_when_another_is_invalid():
    current = defaults_document()
    merged, errors = validate_changes(
        current,
        {"server.host": "127.0.0.1", "not.a.real.key": 1},
    )
    assert [error.code for error in errors] == ["unknown_key"]
    assert merged["server"]["host"] == "127.0.0.1"


def test_validate_changes_returns_post_merge_validation_errors():
    current = defaults_document()
    merged, errors = validate_changes(current, {"server.port": 0})
    assert merged["server"]["port"] == 0
    assert any(error.path == "server.port" and error.code == "out_of_range" for error in errors)
    assert has_blocking_errors(errors) is True


def test_server_port_rejects_70000_with_out_of_range():
    doc = defaults_document()
    _set(doc, "server.port", 70000)
    errors = validate_document(doc)
    assert any(
        error.path == "server.port" and error.code == "out_of_range"
        for error in errors
    )


def test_validate_changes_missing_required_key_is_warning_and_save_is_allowed():
    current = defaults_document()

    merged, errors = validate_changes(current, {}, clear_keys=["opencode.default_agent"])

    assert "default_agent" not in merged["opencode"]
    missing = [error for error in errors if error.code == "required_missing"]
    assert [error.path for error in missing] == ["opencode.default_agent"]
    assert missing[0].severity == "warning"
    assert has_blocking_errors(errors) is False

    _, strict_errors = validate_changes(
        current,
        {},
        clear_keys=["opencode.default_agent"],
        strict=True,
    )
    strict_missing = [error for error in strict_errors if error.code == "required_missing"]
    assert strict_missing
    assert all(error.severity == "error" for error in strict_missing)
    assert has_blocking_errors(strict_errors) is True


def test_validate_changes_keeps_unknown_and_deprecated_blocking():
    current = defaults_document()

    _, unknown = validate_changes(current, {"not.a.real.key": 1})
    assert all(error.severity == "error" for error in unknown)

    _, deprecated = validate_changes(current, {"log.level": "DEBUG"})
    assert all(error.severity == "error" for error in deprecated)


def test_validate_changes_never_mutates_nested_changes():
    current = defaults_document()
    changes = {"p2p": {"room": "mutated"}}
    snapshot = copy.deepcopy(changes)
    validate_changes(current, changes)
    assert changes == snapshot
