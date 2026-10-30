import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import mi_cloud_setup as setup


BASE_CONFIG = """# 顶部注释
server:
  https_port: 8768
health:
  primary_user: someone   # 保留我
  cloud_poll_interval_min: 30
  cloud:
    userid: "old-id"   # 旧值
    passtoken: "old-token"
# 尾部注释
"""


def test_upsert_replaces_values_and_keeps_comments():
    out = setup.upsert_cloud_config(BASE_CONFIG, "new-id", "V1:new/token+=", region="cn", lookback_days=5)

    assert 'userid: "new-id"   # 旧值' in out
    assert 'passtoken: "V1:new/token+="' in out
    assert 'region: "cn"' in out
    assert 'initial_lookback_days: "5"' in out
    assert "保留我" in out
    assert out.rstrip().endswith("# 尾部注释")


def test_upsert_inserts_missing_cloud_block():
    text = "health:\n  primary_user: someone\n"
    out = setup.upsert_cloud_config(text, "1", "t")

    assert 'userid: "1"' in out
    assert 'passtoken: "t"' in out
    assert out.index("  cloud:") > out.index("  primary_user")


def test_upsert_appends_health_section_when_absent():
    out = setup.upsert_cloud_config("server:\n  https_port: 1\n", "1", "t")

    assert out.startswith("server:")
    assert "health:\n  cloud:" in out


def test_write_config_backs_up_and_validates(tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(BASE_CONFIG, encoding="utf-8")
    new_text = setup.upsert_cloud_config(BASE_CONFIG, "new-id", "new-token")

    backup = setup.write_config(path, new_text)

    assert backup.exists()
    assert backup.read_text(encoding="utf-8") == BASE_CONFIG
    assert '"new-id"' in path.read_text(encoding="utf-8")


def test_write_config_rejects_missing_credentials(tmp_path):
    path = tmp_path / "config.yaml"
    text = "health:\n  primary_user: someone\n"
    path.write_text(text, encoding="utf-8")

    with pytest.raises(RuntimeError):
        setup.write_config(path, text)

    assert not list(tmp_path.glob("config.yaml.bak-mi-*"))


def test_mask_never_exposes_middle():
    assert setup.mask("") == "(空)"
    assert setup.mask("short") == "*****"
    masked = setup.mask("abcdefghijklmnop")
    assert masked == "abcd...mnop"
    assert "efgh" not in masked


def test_task_enabled_toggle(tmp_path, monkeypatch):
    task = tmp_path / "task.py"
    task.write_text('"""\nname: x\nenabled: false\n"""\n\nprint(1)\n', encoding="utf-8")
    monkeypatch.setattr(setup, "TASK_FILE", task)

    assert setup.task_enabled() is False
    assert setup.set_task_enabled(True) is True
    assert setup.task_enabled() is True
    assert "enabled: true" in task.read_text(encoding="utf-8")
    assert list(tmp_path.glob("task.py.bak-mi-*"))


def test_check_stdout_never_contains_full_userid(monkeypatch, capsys):
    class _Source:
        user_id = "test-cloud-user"
        pass_token = "pass-token-123456"
        region = "cn"

        def login(self):
            return None

        def fetch_key(self, key, start, now):
            return []

    monkeypatch.setattr(setup, "make_source", lambda args: _Source())

    assert setup.cmd_check(SimpleNamespace(days=3)) == 0

    out = capsys.readouterr().out
    assert "test-cloud-user" not in out
    assert "pass-token-123456" not in out
    assert "test...user" in out


def test_status_stdout_never_contains_full_userid(tmp_path, monkeypatch, capsys):
    import config.config as config_module
    import services.health_cloud_service as service_module

    class _Cfg:
        HEALTH_CLOUD_USERID = "test-cloud-user"
        HEALTH_CLOUD_PASSTOKEN = "pass-token-123456"
        HEALTH_CLOUD_REGION = "cn"
        HEALTH_CLOUD_POLL_INTERVAL_MIN = 30
        HEALTH_CLOUD_OVERLAP_DAYS = 7
        HEALTH_CLOUD_INITIAL_LOOKBACK_DAYS = 3

    class _Service:
        def status(self):
            return {
                "enabled": True,
                "phase": "ok",
                "watermark": 0,
                "consecutive_failures": 0,
                "last_error": "",
            }

    monkeypatch.setattr(config_module, "get_config", lambda: _Cfg())
    monkeypatch.setattr(
        service_module, "get_health_cloud_service", lambda: _Service()
    )
    monkeypatch.setattr(setup, "resolve_config_path", lambda: tmp_path / "config.yaml")
    monkeypatch.setattr(setup, "load_state", lambda: {})
    monkeypatch.setattr(setup, "task_enabled", lambda: True)
    monkeypatch.setattr(setup, "latest_cloud_shard", lambda: "")

    assert setup.cmd_status(SimpleNamespace()) == 0

    out = capsys.readouterr().out
    assert "test-cloud-user" not in out
    assert "test...user" in out
