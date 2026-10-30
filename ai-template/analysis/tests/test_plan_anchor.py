"""plan_anchor 的隔离测试：不触网、不读生产 config、不碰生产数据。"""

import io
import json
import re
import sys
import urllib.error
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import plan_anchor
import plan_wake

STAMP = "2026-10-28"
SYSTEMD_DIR = Path(__file__).resolve().parents[3] / "tools" / "loom-plan" / "systemd"


def _read_unit(pattern: str) -> str:
    matches = sorted(SYSTEMD_DIR.glob(pattern))
    assert matches, f"缺少 systemd 参考件: {pattern}"
    return matches[0].read_text(encoding="utf-8")


@pytest.fixture(autouse=True)
def _isolate_credentials(monkeypatch, tmp_path):
    monkeypatch.delenv(plan_anchor.DEFAULT_TOKEN_ENV, raising=False)
    monkeypatch.delenv(plan_anchor.DEFAULT_SESSION_ENV, raising=False)
    monkeypatch.setattr(
        plan_anchor,
        "DEFAULT_CREDENTIALS_FILE",
        str(tmp_path / "missing-credentials.conf"),
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


def _install_http(monkeypatch, results: list) -> list:
    calls: list[dict] = []

    def fake_urlopen(request, timeout=None):
        body = request.data
        calls.append(
            {
                "url": request.full_url,
                "body": json.loads(body.decode("utf-8")) if body else None,
                "headers": {
                    key.lower(): value for key, value in request.header_items()
                },
                "timeout": timeout,
            }
        )
        result = results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(plan_anchor.urllib.request, "urlopen", fake_urlopen)
    return calls


def _main(*extra: str) -> int:
    return plan_anchor.main(
        ["--anchor", "05:00", "--date", STAMP, "--no-config", *extra]
    )


def test_dry_run_prints_both_payloads_without_http(monkeypatch, capsys):
    def fail(*args, **kwargs):
        raise AssertionError("dry-run 不允许发 HTTP")

    monkeypatch.setattr(plan_anchor.urllib.request, "urlopen", fail)

    code = _main("--session-id", "ses_x", "--dry-run")
    document = json.loads(capsys.readouterr().out)

    assert code == 0
    assert document["anchor"] == "05:00"
    assert document["date"] == STAMP
    assert document["reconcile"]["url"] == "http://127.0.0.1:5100/plan/reconcile"
    assert document["reconcile"]["body"] == {
        "reason": "anchor-0500",
        "anchor": "05:00",
        "date": STAMP,
    }
    assert document["fallback"]["url"] == (
        "http://127.0.0.1:5100/sessions/ses_x/messages"
    )
    assert document["fallback"]["body"]["text"] == plan_wake.PLAN_TEXT


def test_reconcile_first_posts_exact_body_and_skips_fallback(monkeypatch, capsys):
    calls = _install_http(monkeypatch, [_FakeResponse(status=202)])

    code = _main("--session-id", "ses_x", "--token", "tok", "--timeout", "3")
    captured = capsys.readouterr()

    assert code == 0
    assert len(calls) == 1
    assert calls[0]["url"] == "http://127.0.0.1:5100/plan/reconcile"
    assert calls[0]["body"] == {
        "reason": "anchor-0500",
        "anchor": "05:00",
        "date": STAMP,
    }
    assert calls[0]["headers"]["authorization"] == "Bearer tok"
    assert calls[0]["timeout"] == 3
    assert json.loads(captured.out) == {
        "reconciled": True,
        "anchor": "05:00",
        "date": STAMP,
    }


@pytest.mark.parametrize("status", [200, 202, 204])
def test_any_2xx_counts_as_reconciled(monkeypatch, capsys, status):
    calls = _install_http(monkeypatch, [_FakeResponse(status=status)])

    code = _main("--session-id", "ses_x")

    assert code == 0
    assert len(calls) == 1
    assert calls[0]["url"].endswith("/plan/reconcile")
    assert json.loads(capsys.readouterr().out)["reconciled"] is True


def test_fallback_on_connection_error(monkeypatch, capsys):
    calls = _install_http(
        monkeypatch,
        [
            urllib.error.URLError(ConnectionRefusedError("refused")),
            _FakeResponse(status=202),
        ],
    )

    code = _main("--session-id", "ses_x", "--token", "tok")
    captured = capsys.readouterr()

    assert code == 0
    assert [call["url"] for call in calls] == [
        "http://127.0.0.1:5100/plan/reconcile",
        "http://127.0.0.1:5100/sessions/ses_x/messages",
    ]
    assert calls[1]["body"] == {"text": plan_wake.PLAN_TEXT}
    assert calls[1]["headers"]["authorization"] == "Bearer tok"
    assert json.loads(captured.out)["fallback"] is True
    assert "reconcile 不可用" in captured.err


def test_fallback_on_reconcile_non_2xx(monkeypatch, capsys):
    error = urllib.error.HTTPError(
        "http://127.0.0.1:5100/plan/reconcile",
        503,
        "unavailable",
        hdrs=None,
        fp=io.BytesIO(b'{"detail":"busy"}'),
    )
    calls = _install_http(monkeypatch, [error, _FakeResponse(status=202)])

    code = _main("--session-id", "ses_x")
    captured = capsys.readouterr()

    assert code == 0
    assert len(calls) == 2
    assert calls[1]["url"].endswith("/sessions/ses_x/messages")
    assert json.loads(captured.out)["reconciled"] is False


def test_fallback_failure_exits_non_zero(monkeypatch, capsys):
    _install_http(
        monkeypatch,
        [
            urllib.error.URLError(ConnectionRefusedError("refused")),
            urllib.error.URLError(ConnectionRefusedError("refused again")),
        ],
    )

    code = _main("--session-id", "ses_x")
    captured = capsys.readouterr()

    assert code == 1
    assert "回退也失败" in captured.err
    assert captured.out == ""


def test_missing_session_on_fallback_exits_2(monkeypatch, capsys):
    calls = _install_http(
        monkeypatch,
        [
            urllib.error.URLError(ConnectionRefusedError("refused")),
            urllib.error.URLError(ConnectionRefusedError("main session unavailable")),
        ],
    )

    code = _main()
    captured = capsys.readouterr()

    assert code == 2
    assert len(calls) == 2
    assert calls[1]["url"] == "http://127.0.0.1:5100/sessions/main"
    assert "主会话" in captured.err


def test_repeated_invocation_is_idempotent(monkeypatch, capsys):
    calls = _install_http(
        monkeypatch,
        [_FakeResponse(status=202), _FakeResponse(status=202)],
    )

    first = _main("--session-id", "ses_x")
    first_out = capsys.readouterr().out
    second = _main("--session-id", "ses_x")
    second_out = capsys.readouterr().out

    assert first == 0
    assert second == 0
    assert len(calls) == 2
    assert calls[0]["url"] == calls[1]["url"]
    assert calls[0]["body"] == calls[1]["body"]
    assert first_out == second_out


def test_bad_anchor_and_missing_anchor_exit_2():
    with pytest.raises(SystemExit) as invalid:
        plan_anchor.main(["--anchor", "06:00", "--no-config", "--dry-run"])
    with pytest.raises(SystemExit) as missing:
        plan_anchor.main(["--no-config", "--dry-run"])

    assert invalid.value.code == 2
    assert missing.value.code == 2


def test_invalid_date_exits_2_without_http(monkeypatch, capsys):
    calls = _install_http(monkeypatch, [])

    code = plan_anchor.main(
        [
            "--anchor",
            "05:00",
            "--date",
            "2026-1-2",
            "--no-config",
            "--session-id",
            "ses_x",
        ]
    )
    captured = capsys.readouterr()

    assert code == 2
    assert "--date" in captured.err
    assert calls == []


def test_review_anchor_dry_run_uses_review_text(monkeypatch, capsys):
    monkeypatch.setattr(
        plan_anchor.urllib.request,
        "urlopen",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("dry-run 不允许发 HTTP")
        ),
    )

    code = plan_anchor.main(
        [
            "--anchor",
            "07:30",
            "--date",
            STAMP,
            "--session-id",
            "ses_x",
            "--no-config",
            "--dry-run",
        ]
    )
    document = json.loads(capsys.readouterr().out)

    assert code == 0
    assert document["reconcile"]["body"]["reason"] == "anchor-0730"
    assert document["fallback"]["body"]["text"] == plan_wake.REVIEW_TEXT


def test_unit_files_define_both_anchors_and_no_secret_literal():
    if not SYSTEMD_DIR.is_dir():
        pytest.skip("模板独立分发时不含 tools/loom-plan/systemd 参考件")
    plan_service = _read_unit("*plan.service")
    plan_timer = _read_unit("*plan.timer")
    review_service = _read_unit("*review.service")
    review_timer = _read_unit("*review.timer")

    assert "plan_anchor.py --anchor 05:00" in plan_service
    assert "plan_anchor.py --anchor 07:30" in review_service
    for content in (plan_service, review_service):
        assert re.search(r"(?m)^EnvironmentFile=-", content)
        assert "credentials.conf" in content
        assert re.search(r"(?im)^\s*LOOM_TOKEN\s*=", content) is None
        assert re.search(r"(?im)^\s*LOOM_PLAN_SESSION_ID\s*=", content) is None
        assert "Bearer " not in content
        assert "--token " not in content

    for timer, clock in ((plan_timer, "05:00:00"), (review_timer, "07:30:00")):
        assert f"OnCalendar=*-*-* {clock}" in timer
        assert "Persistent=true" in timer
        assert "AccuracySec=1min" in timer
