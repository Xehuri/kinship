# -*- coding: utf-8 -*-
"""小米健康云后台服务单测：状态机、重叠窗口、回填与凭据失效。"""

import json
import threading
import time
from types import SimpleNamespace

import pytest

from services import health_cloud_service as hcs
from services.health.sources.cloud_pull import CloudAuthError


@pytest.fixture()
def service(tmp_path, monkeypatch):
    svc = hcs.HealthCloudService()
    state_file = tmp_path / "health_cloud_state.json"
    svc.state_path = lambda: str(state_file)
    monkeypatch.setattr(
        hcs,
        "get_config",
        lambda: type(
            "Cfg",
            (),
            {
                "HEALTH_CLOUD_STATE_PATH": str(state_file),
                "HEALTH_CLOUD_USERID": "u1",
                "HEALTH_CLOUD_PASSTOKEN": "t1",
                "HEALTH_CLOUD_REGION": "cn",
                "HEALTH_CLOUD_POLL_INTERVAL_MIN": 30,
                "HEALTH_CLOUD_INITIAL_LOOKBACK_DAYS": 3,
                "HEALTH_CLOUD_ENABLED": False,
                "HEALTH_CLOUD_OVERLAP_DAYS": 7,
            },
        )(),
    )
    return svc


class _Batch:
    def __init__(self, date):
        self.date = date


class _Store:
    primary_user = "Axeuh"
    data_root = "/tmp/does-not-exist"

    def __init__(self):
        self.written = []

    def write(self, batch):
        self.written.append(batch)


class _Source:
    def __init__(self, batches=None, error=None):
        self.batches = batches or []
        self.error = error
        self.since = None
        self.logged_in = False

    def login(self):
        if self.error:
            raise self.error
        self.logged_in = True

    def fetch(self, since, user_id=None):
        self.since = since
        if self.error:
            raise self.error
        return self.batches

    def latest_sample_ts_between(self, keys, start_ts, end_ts):
        if self.error:
            raise self.error
        return {}


def test_disabled_by_default(service):
    result = service.status()
    assert result["phase"] == hcs.STATE_DISABLED
    assert result["enabled"] is False


def test_set_enabled_persists_runtime_override(service):
    service.set_enabled(True)
    assert service.is_enabled() is True
    with open(service.state_path(), encoding="utf-8") as f:
        assert json.load(f)["enabled"] is True


def test_pull_window_uses_overlap_after_watermark(service):
    now = int(time.time())
    service._update_state(watermark=now - 3600)
    since = service._pull_window(None)
    assert since == now - 7 * 86400


def test_pull_window_first_run_uses_initial_lookback(service):
    now = int(time.time())
    since = service._pull_window(None)
    assert abs(since - (now - 3 * 86400)) <= 2


def test_backfill_uses_explicit_days(service):
    now = int(time.time())
    since = service._pull_window(30)
    assert abs(since - (now - 30 * 86400)) <= 2


def test_pull_once_writes_batches_and_updates_watermark(service, monkeypatch):
    store = _Store()
    source = _Source(batches=[_Batch("2026-10-17")])
    monkeypatch.setattr(service, "_resolve_user_id", lambda: "Axeuh")
    monkeypatch.setattr(service, "_get_source", lambda: source)
    monkeypatch.setattr(hcs, "get_health_store", lambda: store)

    result = service.pull_once(days=1)

    assert result["ok"] is True
    assert result["written"] == 1
    assert store.written[0].date == "2026-10-17"
    state = service._load_state()
    assert state["watermark"] > 0
    assert state["consecutive_failures"] == 0


def test_pull_once_auth_error_marks_failure(service, monkeypatch):
    source = _Source(error=CloudAuthError(401))
    monkeypatch.setattr(service, "_resolve_user_id", lambda: "Axeuh")
    monkeypatch.setattr(service, "_get_source", lambda: source)

    result = service.pull_once()

    assert result["ok"] is False
    assert "401" in (result["error"] or "") or "凭据" in (result["error"] or "")
    assert service._load_state()["consecutive_failures"] == 1


def test_status_reports_auth_expired_after_401(service):
    service._update_state(enabled=True, last_error="凭据失效: 401")
    assert service.status()["phase"] == hcs.STATE_AUTH_EXPIRED


def test_status_masks_userid_and_redacts_last_error(service):
    service._update_state(
        last_error="登录失败: https://api.example.test/login?token=plain-secret"
    )

    result = service.status()

    assert result["userid"] == "***"
    assert result["userid_configured"] is True
    assert "plain-secret" not in result["last_error"]
    assert "***" in result["last_error"]


def test_poll_qr_once_masks_user_id(service, monkeypatch):
    class _QrSource:
        def poll_once(self, lp):
            return ("test-cloud-user", "pass-token")

    monkeypatch.setattr(hcs, "CloudPullSource", lambda: _QrSource())
    monkeypatch.setattr(
        service,
        "apply_credentials",
        lambda user_id, pass_token, start_pull=True: None,
    )

    result = service.poll_qr_once("lp")

    assert result == {"state": "success", "user_id": "test...user"}


def test_poll_qr_once_keeps_empty_user_id_empty(service, monkeypatch):
    class _QrSource:
        def poll_once(self, lp):
            return ("", "pass-token")

    monkeypatch.setattr(hcs, "CloudPullSource", lambda: _QrSource())
    monkeypatch.setattr(
        service,
        "apply_credentials",
        lambda user_id, pass_token, start_pull=True: None,
    )

    assert service.poll_qr_once("lp")["user_id"] == ""


def test_probe_maps_cloud_auth_error(service, monkeypatch):
    monkeypatch.setattr(service, "_get_source", lambda: _Source(error=CloudAuthError(401)))
    phase, error = service.probe()
    assert phase == hcs.STATE_AUTH_EXPIRED
    assert "401" in error


def test_login_maps_http_401_to_cloud_auth_error(monkeypatch):
    from unittest.mock import MagicMock

    from services.health.sources.cloud_pull import CloudPullSource

    source = CloudPullSource(user_id="u1", pass_token="t1")

    class _Resp:
        status_code = 401
        text = ""

        def raise_for_status(self):
            raise AssertionError("401 必须先映射为 CloudAuthError")

    source._session = MagicMock()
    source._session.get.return_value = _Resp()

    with pytest.raises(CloudAuthError):
        source._login()


def test_latest_samples_preserves_auth_error_type(monkeypatch):
    from services.health.sources.cloud_pull import CloudPullSource

    source = CloudPullSource(user_id="u1", pass_token="t1")
    source._logged_in = True

    def _boom(*args, **kwargs):
        raise CloudAuthError(401)

    monkeypatch.setattr(source, "fetch_key", _boom)
    with pytest.raises(CloudAuthError):
        source.latest_sample_ts_between(None, 0, 1)


def test_login_collects_session_cookies(monkeypatch):
    from unittest.mock import MagicMock

    from services.health.sources.cloud_pull import CloudPullSource

    source = CloudPullSource(user_id="u1", pass_token="t1")

    class _Headers:
        def getlist(self, name):
            return ["cUserId=abc; Path=/", "serviceToken=tok; Path=/"]

    class _Raw:
        headers = _Headers()

    class _LoginResp:
        status_code = 200
        text = '&&&START&&&{"code":0,"passToken":"p","ssecurity":"c2VjcmV0","userId":"u1","location":"https://x"}'

        def raise_for_status(self):
            return None

    class _RedirectResp:
        raw = _Raw()

        def raise_for_status(self):
            return None

    source._session = MagicMock()
    source._session.get.side_effect = [_LoginResp(), _RedirectResp()]

    source._login()

    assert source._cookies == "cUserId=abc; serviceToken=tok"
    assert source._logged_in is True


class _ConfigStore:
    def __init__(self) -> None:
        self.saved = []

    def save(self, changes):
        self.saved.append(dict(changes))


def _thread_recorder():
    created = []

    class _Thread:
        def __init__(self, target=None, name=None, daemon=None):
            created.append(name or "")

        def start(self):
            raise AssertionError("引导流程不得启动拉取线程")

    return created, _Thread


def test_set_enabled_without_start_keeps_thread_idle(service, monkeypatch):
    started = []
    monkeypatch.setattr(service, "start", lambda: started.append(True))

    service.set_enabled(True, start_pull=False)

    assert service.is_enabled() is True
    assert service._thread is None
    assert started == []


def test_set_enabled_default_still_starts_thread(service, monkeypatch):
    started = []
    monkeypatch.setattr(service, "start", lambda: started.append(True))

    service.set_enabled(True)

    assert started == [True]


def test_set_enabled_false_stops_existing_thread(service):
    thread = threading.Thread(
        target=service._stop_event.wait, args=(30,), daemon=True
    )
    thread.start()
    service._thread = thread

    service.set_enabled(False)

    assert service._thread is None
    assert thread.is_alive() is False


def test_apply_credentials_without_start_skips_first_pull(service, monkeypatch):
    store = _ConfigStore()
    created, thread_cls = _thread_recorder()
    pulled = []
    monkeypatch.setattr(hcs, "get_config_store", lambda: store)
    monkeypatch.setattr(hcs, "threading", SimpleNamespace(Thread=thread_cls))
    monkeypatch.setattr(service, "pull_once", lambda: pulled.append(True))

    service.apply_credentials("u1", "t1", start_pull=False)

    assert store.saved[0]["health.cloud.passtoken"] == "t1"
    assert created == []
    assert pulled == []


def test_poll_qr_once_forwards_start_pull_flag(service, monkeypatch):
    captured = {}

    class _QrSource:
        def poll_once(self, lp):
            return ("test-cloud-user", "pass-token")

    def _apply(user_id, pass_token, start_pull=True):
        captured.update(
            user_id=user_id, pass_token=pass_token, start_pull=start_pull
        )

    monkeypatch.setattr(hcs, "CloudPullSource", lambda: _QrSource())
    monkeypatch.setattr(service, "apply_credentials", _apply)

    result = service.poll_qr_once("lp", start_pull=False)

    assert result == {"state": "success", "user_id": "test...user"}
    assert captured == {
        "user_id": "test-cloud-user",
        "pass_token": "pass-token",
        "start_pull": False,
    }


def test_poll_qr_success_without_start_saves_credentials_without_thread(
    service, monkeypatch
):
    class _QrSource:
        def poll_once(self, lp):
            return ("test-cloud-user", "pass-token")

    store = _ConfigStore()
    created, thread_cls = _thread_recorder()
    pulled = []
    monkeypatch.setattr(hcs, "CloudPullSource", lambda: _QrSource())
    monkeypatch.setattr(hcs, "get_config_store", lambda: store)
    monkeypatch.setattr(hcs, "threading", SimpleNamespace(Thread=thread_cls))
    monkeypatch.setattr(service, "pull_once", lambda: pulled.append(True))

    result = service.poll_qr_once("lp", start_pull=False)

    assert result == {"state": "success", "user_id": "test...user"}
    assert store.saved[0]["health.cloud.userid"] == "test-cloud-user"
    assert service._thread is None
    assert created == []
    assert pulled == []
