"""plan_wake 的隔离测试：不触网、不读生产 config、不碰生产数据。"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import plan_wake

STAMP = "2026-10-28"


def _payload(kind: str = "plan") -> dict:
    return plan_wake.build_payload(
        kind=kind,
        date_value=STAMP,
        session_id="ses_test",
        timezone_name="Asia/Shanghai",
    )


class _FakeResponse:
    def __init__(self, status: int = 202, body: bytes = b'{"accepted":true}'):
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False


def test_plan_0500_payload_contract():
    payload = _payload("plan")

    assert payload["kind"] == "plan_wake"
    assert payload["checkpoint"] == "plan-0500"
    assert payload["date"] == STAMP
    assert payload["previous_date"] == "2026-10-27"
    assert payload["target_session"] == "ses_test"
    assert payload["timezone"] == "Asia/Shanghai"
    assert payload["scheduled_at"] == "2026-10-28T05:00:00+08:00"
    assert payload["delivery"] == "loom_session"
    assert payload["user_notification"] is False
    assert payload["text"] == (
        "【系统通知·日计划】05:00 到了。\n"
        "先读昨日计划并收口，再看今日 brief，最后 plan commit。"
    )


def test_review_0730_payload_is_plan_checkpoint_not_notification():
    payload = _payload("review")

    assert payload["kind"] == "plan_review"
    assert payload["checkpoint"] == "review-0730"
    assert payload["scheduled_at"] == "2026-10-28T07:30:00+08:00"
    assert payload["delivery"] == "loom_session"
    assert payload["user_notification"] is False
    assert payload["text"].startswith(
        "【检查点 review-0730】07:30–08:00 晨间复核。"
    )
    assert "plan read" in payload["text"]
    assert "【系统通知·日计划】" not in payload["text"]


def test_timezone_resolves_date_across_utc_midnight():
    zone = plan_wake.load_timezone("Asia/Shanghai")
    now = datetime(2026, 10, 27, 20, 30, tzinfo=timezone.utc)

    assert plan_wake.resolve_event_date(None, zone, now=now).isoformat() == STAMP
    assert (
        plan_wake.resolve_event_date("2026-10-27", zone, now=now).isoformat()
        == "2026-10-27"
    )


def test_unknown_timezone_and_invalid_date_fail_clearly():
    with pytest.raises(plan_wake.PlanWakeError, match="时区"):
        plan_wake.load_timezone("Mars/Olympus")
    with pytest.raises(plan_wake.PlanWakeError, match="--date"):
        plan_wake.parse_date("2026-1-2")


def test_missing_session_id_exits_2_without_http(monkeypatch, capsys):
    monkeypatch.delenv(plan_wake.DEFAULT_SESSION_ENV, raising=False)
    called = []
    monkeypatch.setattr(
        plan_wake.urllib.request,
        "urlopen",
        lambda *args, **kwargs: called.append((args, kwargs)),
    )

    code = plan_wake.main(["--dry-run", "--no-config", "--date", STAMP])
    captured = capsys.readouterr()

    assert code == 2
    assert "会话" in captured.err
    assert captured.out == ""
    assert called == []


def test_dry_run_prints_payload_without_http(monkeypatch, capsys):
    def fail(*args, **kwargs):
        raise AssertionError("dry-run 不允许发 HTTP")

    monkeypatch.setattr(plan_wake.urllib.request, "urlopen", fail)

    code = plan_wake.main(
        [
            "--dry-run",
            "--no-config",
            "--session-id",
            "ses_test",
            "--date",
            STAMP,
        ]
    )
    captured = capsys.readouterr()
    payload = json.loads(captured.out)

    assert code == 0
    assert payload["kind"] == "plan_wake"
    assert payload["target_session"] == "ses_test"
    assert payload["text"].startswith("【系统通知·日计划】")


def test_dry_run_review_prints_checkpoint(monkeypatch, capsys):
    monkeypatch.setattr(
        plan_wake.urllib.request,
        "urlopen",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("dry-run 不允许发 HTTP")
        ),
    )

    code = plan_wake.main(
        [
            "--dry-run",
            "--no-config",
            "--kind",
            "review",
            "--session-id",
            "ses_test",
            "--date",
            STAMP,
        ]
    )
    payload = json.loads(capsys.readouterr().out)

    assert code == 0
    assert payload["kind"] == "plan_review"
    assert payload["checkpoint"] == "review-0730"


def test_session_id_can_come_from_custom_env(monkeypatch, capsys):
    monkeypatch.setenv("PLAN_TEST_SESSION", "ses_from_env")

    code = plan_wake.main(
        [
            "--dry-run",
            "--no-config",
            "--session-id-env",
            "PLAN_TEST_SESSION",
            "--date",
            STAMP,
        ]
    )
    payload = json.loads(capsys.readouterr().out)

    assert code == 0
    assert payload["target_session"] == "ses_from_env"


def test_send_without_token_fails_before_http(monkeypatch, tmp_path, capsys):
    monkeypatch.delenv(plan_wake.DEFAULT_TOKEN_ENV, raising=False)
    monkeypatch.setattr(
        plan_wake.urllib.request,
        "urlopen",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("缺 token 不允许发 HTTP")
        ),
    )

    code = plan_wake.main(
        [
            "--no-config",
            "--session-id",
            "ses_test",
            "--date",
            STAMP,
            "--credentials-file",
            str(tmp_path / "missing.conf"),
        ]
    )
    captured = capsys.readouterr()

    assert code == 2
    assert "token" in captured.err.lower()


def test_send_posts_exact_body_and_bearer(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["headers"] = {
            key.lower(): value for key, value in request.header_items()
        }
        captured["timeout"] = timeout
        return _FakeResponse()

    monkeypatch.setattr(plan_wake.urllib.request, "urlopen", fake_urlopen)
    payload = _payload("plan")

    result = plan_wake.send_payload(
        payload,
        loom_url="http://127.0.0.1:5100/",
        token="tok",
        timeout=3,
    )

    assert captured["url"] == "http://127.0.0.1:5100/sessions/ses_test/messages"
    assert captured["body"] == {"text": payload["text"]}
    assert captured["headers"]["authorization"] == "Bearer tok"
    assert captured["timeout"] == 3
    assert result["status"] == 202


def test_send_rejects_non_202(monkeypatch):
    monkeypatch.setattr(
        plan_wake.urllib.request,
        "urlopen",
        lambda request, timeout=None: _FakeResponse(status=200),
    )

    with pytest.raises(plan_wake.PlanWakeHTTPError, match="202"):
        plan_wake.send_payload(
            _payload("plan"),
            loom_url="http://127.0.0.1:5100",
            token="tok",
        )
