from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from urllib.parse import parse_qsl

import httpx
import pytest

from services.qq_gateway.config import OutboundConfig, QZoneConfig
from services.qq_gateway.qzone import QZoneService
from services.qq_gateway.qzone_client import QZoneError
from services.qq_gateway.qzone_parse import djb2_gtk

SELF_QQ = "10001"
SELF_COOKIE_UIN = "o010001"
OTHER_COOKIE_UIN = "o010002"
TARGET = "445566"
TID = "abc123"
CONTENT = "hello qzone"
P_SKEY = "P-SECRET"
S_SKEY = "S-SECRET"
COOKIE = f"uin={SELF_COOKIE_UIN}; p_skey={P_SKEY}; skey={S_SKEY}"

LIST_URL = "https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6"
WRITE_URL = "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds"
LIKE_URL = "https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app"
DELETE_URL = (
    "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delcomment_ugc"
)


class FakeClock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeActions:
    def __init__(self, data: Any = None) -> None:
        self.data = {"cookies": COOKIE} if data is None else data
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call(self, action: str, params: dict | None = None,
                   **_kwargs: Any) -> Any:
        self.calls.append((action, dict(params or {})))
        return self.data


class ExplodingActions:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call(self, action: str, params: dict | None = None,
                   **_kwargs: Any) -> Any:
        self.calls.append((action, dict(params or {})))
        raise AssertionError("actions must not be called")


def _qzone(**overrides: Any) -> QZoneConfig:
    values: dict[str, Any] = {
        "enabled": True,
        "mode": "http_sidecar",
        "allow_read": True,
        "allow_send": True,
        "allow_delete": False,
        "rate_per_hour": 5,
    }
    values.update(overrides)
    return QZoneConfig(**values)


def _service(actions: Any, handler: Any, *, qzone: QZoneConfig | None = None,
             outbound: OutboundConfig | None = None,
             clock: FakeClock | None = None) -> QZoneService:
    return QZoneService(
        actions,
        qzone or _qzone(),
        outbound or OutboundConfig(enabled=True),
        SELF_QQ,
        logger=logging.getLogger("services.qq_gateway.qzone"),
        http_transport=httpx.MockTransport(handler),
        clock=clock or FakeClock(),
    )


def _feed(tid: str = TID, comments: list[dict[str, Any]] | None = None,
          comment_count: int | None = None) -> dict[str, Any]:
    entries = comments or []
    return {
        "tid": tid,
        "content": "post",
        "createTime": 1700000000,
        "cmtnum": len(entries) if comment_count is None else comment_count,
        "commentlist": entries,
    }


def _comment(comment_id: str = "c-1", uin: str = "777", nick: str = "Alice",
             content: str = "parent") -> dict[str, Any]:
    return {
        "tid": comment_id,
        "uin": uin,
        "nickname": nick,
        "content": content,
        "createTime": 1700000001,
    }


def _list_body(feeds: list[dict[str, Any]] | None = None) -> str:
    payload = {"code": 0, "msglist": feeds or []}
    return "_preloadCallback(" + json.dumps(payload, ensure_ascii=False) + ");"


def _write_ok() -> str:
    return 'frameElement.callback({"code":0});'


def _form(request: httpx.Request) -> dict[str, str]:
    return dict(parse_qsl(request.content.decode("utf-8"), keep_blank_values=True))


def _url(request: httpx.Request) -> str:
    return str(request.url).split("?", 1)[0]


GATE_CASES = [
    pytest.param(
        QZoneConfig(enabled=False, mode="http_sidecar", allow_read=True, allow_send=True),
        OutboundConfig(enabled=True), "list_feeds", (TARGET,), id="disabled",
    ),
    pytest.param(
        QZoneConfig(enabled=True, mode="native", allow_read=True, allow_send=True),
        OutboundConfig(enabled=True), "list_feeds", (TARGET,), id="wrong-mode",
    ),
    pytest.param(
        QZoneConfig(enabled=True, mode="http_sidecar", allow_read=False, allow_send=True),
        OutboundConfig(enabled=True), "list_feeds", (TARGET,), id="read-off",
    ),
    pytest.param(
        QZoneConfig(enabled=True, mode="http_sidecar", allow_read=True, allow_send=False),
        OutboundConfig(enabled=True), "comment", (TARGET, TID, CONTENT), id="send-off",
    ),
    pytest.param(
        QZoneConfig(enabled=True, mode="http_sidecar", allow_read=True, allow_send=True),
        OutboundConfig(enabled=False), "like", (TARGET, TID), id="outbound-off",
    ),
    pytest.param(
        QZoneConfig(
            enabled=True, mode="http_sidecar", allow_read=True, allow_send=True,
            allow_delete=False,
        ),
        OutboundConfig(enabled=True), "delete_comment", (TARGET, TID, "c-1"),
        id="delete-off",
    ),
]


@pytest.mark.parametrize(("qzone", "outbound", "method", "args"), GATE_CASES)
def test_gates_reject_before_actions_and_http(qzone: QZoneConfig,
                                              outbound: OutboundConfig,
                                              method: str,
                                              args: tuple[Any, ...]) -> None:
    async def scenario() -> None:
        actions = ExplodingActions()
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text=_write_ok())

        service = _service(actions, handler, qzone=qzone, outbound=outbound)
        with pytest.raises(QZoneError) as excinfo:
            await getattr(service, method)(*args)
        assert excinfo.value.retcode == 1403
        assert actions.calls == []
        assert requests == []

    asyncio.run(scenario())


def test_dry_run_comment_like_and_reply_skip_http_and_quota() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text=_write_ok())

        service = _service(
            actions, handler,
            qzone=_qzone(rate_per_hour=1, allow_delete=True),
            outbound=OutboundConfig(enabled=True, dry_run=True),
        )
        expected = {
            "dry_run": True,
            "action": "comment",
            "target_qq": TARGET,
            "tid": TID,
            "content_length": len(CONTENT),
        }
        assert await service.comment(TARGET, TID, CONTENT) == expected
        assert await service.comment(TARGET, TID, CONTENT) == expected
        assert await service.like(TARGET, TID) == {
            "dry_run": True, "action": "like", "target_qq": TARGET, "tid": TID,
        }
        assert await service.reply(TARGET, TID, "c-1", CONTENT) == {
            **expected, "action": "reply",
        }
        assert await service.delete_comment(TARGET, TID, "c-1") == {
            "dry_run": True,
            "action": "delete_comment",
            "target_qq": TARGET,
            "tid": TID,
            "comment_id": "c-1",
        }
        assert actions.calls == []
        assert requests == []

    asyncio.run(scenario())


def test_cookie_cache_reuses_for_ttl_then_refreshes() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        requests: list[httpx.Request] = []
        clock = FakeClock()

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text=_list_body([_feed()]))

        service = _service(actions, handler, clock=clock)
        await service.list_feeds(TARGET)
        await service.list_feeds(TARGET)
        assert len(actions.calls) == 1
        assert actions.calls[0] == ("get_cookies", {"domain": "user.qzone.qq.com"})
        assert len(requests) == 2

        clock.advance(1801)
        await service.list_feeds(TARGET)
        assert len(actions.calls) == 2
        assert len(requests) == 3
        await service.close()

    asyncio.run(scenario())


def test_gtk_prefers_bkn_then_falls_back_to_p_skey() -> None:
    async def scenario() -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(dict(request.url.params).get("g_tk", ""))
            return httpx.Response(200, text=_list_body([]))

        service = _service(FakeActions({"cookies": COOKIE, "bkn": "4242"}), handler)
        await service.list_feeds(TARGET)
        await service.close()

        service = _service(FakeActions({"cookies": COOKIE}), handler)
        await service.list_feeds(TARGET)
        await service.close()

        skey_only = f"uin={SELF_COOKIE_UIN}; skey={S_SKEY}"
        service = _service(FakeActions({"cookies": skey_only}), handler)
        await service.list_feeds(TARGET)
        await service.close()

        assert seen == ["4242", djb2_gtk(P_SKEY), djb2_gtk(S_SKEY)]

    asyncio.run(scenario())


def test_cookie_string_dict_and_missing_gtk_paths() -> None:
    async def scenario() -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(dict(request.url.params).get("g_tk", ""))
            return httpx.Response(200, text=_list_body([]))

        service = _service(FakeActions({"cookies": COOKIE}), handler)
        await service.list_feeds(TARGET)
        await service.close()

        mapping = {"uin": SELF_COOKIE_UIN, "p_skey": P_SKEY}
        service = _service(FakeActions(mapping), handler)
        await service.list_feeds(TARGET)
        await service.close()

        nested = {"cookies": {"p_uin": SELF_COOKIE_UIN, "p_skey": P_SKEY}}
        service = _service(FakeActions(nested), handler)
        await service.list_feeds(TARGET)
        await service.close()

        assert seen == [djb2_gtk(P_SKEY)] * 3

        requests: list[httpx.Request] = []

        def unused(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text=_list_body([]))

        service = _service(FakeActions({"cookies": f"uin={SELF_COOKIE_UIN}"}), unused)
        with pytest.raises(QZoneError) as excinfo:
            await service.list_feeds(TARGET)
        assert excinfo.value.retcode == 1401
        assert requests == []

    asyncio.run(scenario())


def test_read_302_refreshes_cookies_and_retries_once() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(302, headers={"Location": "https://example.invalid/login"})
            return httpx.Response(200, text=_list_body([_feed()]))

        service = _service(actions, handler)
        result = await service.list_feeds(TARGET)
        assert result["target_qq"] == TARGET
        assert result["count"] == 1
        assert result["feeds"][0]["tid"] == TID
        assert len(requests) == 2
        assert len(actions.calls) == 2
        await service.close()

    asyncio.run(scenario())


def test_write_302_makes_one_attempt_and_does_not_retry() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(302, headers={"Location": "https://example.invalid/login"})

        service = _service(actions, handler)
        with pytest.raises(QZoneError) as excinfo:
            await service.comment(TARGET, TID, CONTENT)
        assert excinfo.value.retcode == 1401
        assert len(requests) == 1
        assert len(actions.calls) == 1
        await service.close()

    asyncio.run(scenario())


WRITE_CALLS = [
    pytest.param("comment", (TARGET, TID, CONTENT), id="comment"),
    pytest.param("reply", (TARGET, TID, "c-1", CONTENT, "777", "Bob"), id="reply"),
    pytest.param("like", (TARGET, TID), id="like"),
    pytest.param("delete_comment", (TARGET, TID, "c-1"), id="delete-comment"),
]


@pytest.mark.parametrize(("method", "args"), WRITE_CALLS)
def test_write_1401_invalidates_cookie_cache(method: str, args: tuple[Any, ...]) -> None:
    async def scenario() -> None:
        actions = FakeActions()
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(302, headers={"Location": "https://example.invalid/login"})
            return httpx.Response(200, text=_list_body([_feed()]))

        service = _service(actions, handler, qzone=_qzone(allow_delete=True))
        with pytest.raises(QZoneError) as excinfo:
            await getattr(service, method)(*args)
        assert excinfo.value.retcode == 1401
        assert len(actions.calls) == 1

        await service.list_feeds(TARGET)
        assert len(actions.calls) == 2
        assert len(requests) == 2
        await service.close()

    asyncio.run(scenario())


def test_write_rate_limit_rejects_second_write_before_http() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        requests: list[httpx.Request] = []
        clock = FakeClock()

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text=_write_ok())

        service = _service(actions, handler, qzone=_qzone(rate_per_hour=1), clock=clock)
        await service.comment(TARGET, TID, CONTENT)
        with pytest.raises(QZoneError) as excinfo:
            await service.like(TARGET, TID)
        assert excinfo.value.retcode == 1200
        assert len(requests) == 1
        assert len(actions.calls) == 1

        clock.advance(3601)
        await service.like(TARGET, TID)
        assert len(requests) == 2
        await service.close()

    asyncio.run(scenario())


def test_read_rate_limit_is_thirty_per_minute() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text=_list_body([_feed()]))

        service = _service(actions, handler)
        for _ in range(30):
            await service.list_feeds(TARGET)
        with pytest.raises(QZoneError) as excinfo:
            await service.list_feeds(TARGET)
        assert excinfo.value.retcode == 1200
        assert len(requests) == 30
        assert len(actions.calls) == 1
        await service.close()

    asyncio.run(scenario())


def test_reply_with_provided_comment_info_skips_scan() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        requests: list[httpx.Request] = []
        forms: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            forms.append(_form(request))
            return httpx.Response(200, text=_write_ok())

        service = _service(actions, handler)
        result = await service.reply(TARGET, TID, "c-9", CONTENT,
                                    comment_uin="888", comment_nick="Bob")
        assert [request.method for request in requests] == ["POST"]
        assert _url(requests[0]) == WRITE_URL
        assert forms[0]["commentId"] == "c-9"
        assert forms[0]["commentUin"] == "888"
        assert forms[0]["content"] == "@{uin:888,nick:Bob,auto:1}" + CONTENT
        assert result == {
            "success": True,
            "target_qq": TARGET,
            "tid": TID,
            "comment_id": "c-9",
            "content_length": len(CONTENT),
            "code": 0,
        }
        await service.close()

    asyncio.run(scenario())


def test_reply_without_info_scans_latest_feeds_and_resolves_comment() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        requests: list[httpx.Request] = []
        forms: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.method == "GET":
                feed = _feed(comments=[_comment("c-2", "999", "Carol")])
                return httpx.Response(200, text=_list_body([feed]))
            forms.append(_form(request))
            return httpx.Response(200, text=_write_ok())

        service = _service(actions, handler)
        result = await service.reply(TARGET, TID, "c-2", CONTENT)
        assert [request.method for request in requests] == ["GET", "POST"]
        assert dict(requests[0].url.params)["num"] == "10"
        assert forms[0]["commentUin"] == "999"
        assert forms[0]["content"] == "@{uin:999,nick:Carol,auto:1}" + CONTENT
        assert result["success"] is True
        assert result["comment_id"] == "c-2"
        await service.close()

    asyncio.run(scenario())


def test_reply_without_info_not_found_is_1404_and_keeps_write_quota() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.method == "GET":
                feed = _feed(comments=[_comment("other")])
                return httpx.Response(200, text=_list_body([feed]))
            return httpx.Response(200, text=_write_ok())

        service = _service(actions, handler, qzone=_qzone(rate_per_hour=1))
        with pytest.raises(QZoneError) as excinfo:
            await service.reply(TARGET, TID, "missing", CONTENT)
        assert excinfo.value.retcode == 1404
        assert [request.method for request in requests] == ["GET"]

        await service.like(TARGET, TID)
        assert [request.method for request in requests] == ["GET", "POST"]
        await service.close()

    asyncio.run(scenario())


def test_cookie_account_mismatch_is_1409_without_qq_numbers(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG, logger="services.qq_gateway.qzone")

    async def scenario() -> None:
        actions = FakeActions({"cookies": f"uin={OTHER_COOKIE_UIN}; p_skey={P_SKEY}"})
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text=_list_body([]))

        service = _service(actions, handler)
        with pytest.raises(QZoneError) as excinfo:
            await service.list_feeds(TARGET)
        assert excinfo.value.retcode == 1409
        message = str(excinfo.value)
        for number in (SELF_QQ, "10001", OTHER_COOKIE_UIN, TARGET):
            assert number not in message
            assert number not in caplog.text
        assert requests == []

    asyncio.run(scenario())


def test_logs_do_not_contain_content_cookies_or_target(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG, logger="services.qq_gateway.qzone")
    secret_content = "内容-secret-42"

    async def scenario() -> None:
        actions = FakeActions()
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.method == "GET":
                return httpx.Response(200, text=_list_body([_feed()]))
            return httpx.Response(200, text=_write_ok())

        service = _service(actions, handler)
        await service.list_feeds(TARGET)
        await service.comment(TARGET, TID, secret_content)
        await service.close()

    asyncio.run(scenario())

    for value in (secret_content, P_SKEY, S_SKEY, SELF_COOKIE_UIN, SELF_QQ, TARGET):
        assert value not in caplog.text


def test_status_reports_effective_flags_without_secrets() -> None:
    service = _service(FakeActions(), lambda request: httpx.Response(200))
    assert service.status() == {
        "enabled": True,
        "mode": "http_sidecar",
        "read": True,
        "send": True,
        "delete": False,
        "write_limit_per_hour": 5,
    }
    assert P_SKEY not in str(service.status())

    delete_enabled = _service(
        FakeActions(),
        lambda request: httpx.Response(200),
        qzone=_qzone(allow_delete=True),
    )
    assert delete_enabled.status()["delete"] is True

    disabled = _service(
        FakeActions(),
        lambda request: httpx.Response(200),
        qzone=QZoneConfig(enabled=False, mode="off", allow_read=True, allow_send=True),
    )
    status = disabled.status()
    assert status["enabled"] is False
    assert status["read"] is False
    assert status["send"] is False
    assert status["delete"] is False


def test_get_comments_found_and_missing() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        feed = _feed(comments=[_comment()], comment_count=1)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text=_list_body([feed]))

        service = _service(actions, handler)
        found = await service.get_comments(TARGET, TID, 10)
        assert found["found"] is True
        assert found["comment_count"] == 1
        assert found["comments"][0]["comment_id"] == "c-1"

        missing = await service.get_comments(TARGET, "missing", 5)
        assert missing == {
            "target_qq": TARGET,
            "tid": "missing",
            "found": False,
            "comments": [],
            "scanned": 5,
        }
        await service.close()

    asyncio.run(scenario())


def test_input_validation_returns_1400_before_actions_and_http() -> None:
    async def scenario() -> None:
        actions = ExplodingActions()
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(500)

        service = _service(actions, handler)
        checks = [
            lambda: service.list_feeds(""),
            lambda: service.list_feeds("12ab"),
            lambda: service.list_feeds(TARGET, True),
            lambda: service.list_feeds(TARGET, 1.5),
            lambda: service.comment(TARGET, " ", CONTENT),
            lambda: service.comment(TARGET, TID, "   "),
            lambda: service.comment(TARGET, TID, "x" * 1001),
            lambda: service.reply(TARGET, TID, "", CONTENT, "777", "Bob"),
            lambda: service.like("12x", TID),
            lambda: service.delete_comment("12x", TID, "c-1"),
            lambda: service.delete_comment(TARGET, " ", "c-1"),
            lambda: service.delete_comment(TARGET, TID, ""),
            lambda: service.delete_comment(TARGET, TID, "c-1", "abc"),
        ]
        for factory in checks:
            with pytest.raises(QZoneError) as excinfo:
                await factory()
            assert excinfo.value.retcode == 1400
        assert actions.calls == []
        assert requests == []

    asyncio.run(scenario())


def test_list_limit_is_clamped_to_one_through_twenty() -> None:
    async def scenario() -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(dict(request.url.params)["num"])
            return httpx.Response(200, text=_list_body([]))

        service = _service(FakeActions(), handler)
        await service.list_feeds(TARGET, 100)
        await service.list_feeds(TARGET, 0)
        assert seen == ["20", "1"]
        await service.close()

    asyncio.run(scenario())


def test_close_is_idempotent() -> None:
    async def scenario() -> None:
        service = _service(FakeActions(), lambda request: httpx.Response(200))
        await service.close()
        await service.close()

    asyncio.run(scenario())


def test_delete_comment_posts_to_delete_endpoint_and_returns_envelope() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []
        forms: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            forms.append(_form(request))
            return httpx.Response(200, text=_write_ok())

        service = _service(FakeActions(), handler, qzone=_qzone(allow_delete=True))
        result = await service.delete_comment(TARGET, TID, "c-1", "777")
        assert [request.method for request in requests] == ["POST"]
        assert _url(requests[0]) == DELETE_URL
        assert forms[0]["commentId"] == "c-1"
        assert forms[0]["commentUin"] == "777"
        assert result == {
            "success": True,
            "target_qq": TARGET,
            "tid": TID,
            "comment_id": "c-1",
            "comment_uin": "777",
            "code": 0,
        }
        await service.close()

    asyncio.run(scenario())


def test_delete_comment_consumes_write_rate_limit() -> None:
    async def scenario() -> None:
        clock = FakeClock()
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text=_write_ok())

        service = _service(
            FakeActions(), handler,
            qzone=_qzone(rate_per_hour=1, allow_delete=True), clock=clock,
        )
        await service.delete_comment(TARGET, TID, "c-1")
        with pytest.raises(QZoneError) as excinfo:
            await service.like(TARGET, TID)
        assert excinfo.value.retcode == 1200
        assert len(requests) == 1

        clock.advance(3601)
        await service.like(TARGET, TID)
        assert len(requests) == 2
        await service.close()

    asyncio.run(scenario())


def test_like_posts_to_like_endpoint() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, text='_preloadCallback({"code":0});')

        service = _service(FakeActions(), handler)
        result = await service.like(TARGET, TID)
        assert [request.method for request in requests] == ["POST"]
        assert _url(requests[0]) == LIKE_URL
        assert dict(requests[0].url.params)["g_tk"] == djb2_gtk(P_SKEY)
        assert result == {"success": True, "target_qq": TARGET, "tid": TID}
        await service.close()

    asyncio.run(scenario())
