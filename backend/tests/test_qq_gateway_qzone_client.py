from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable
from urllib.parse import parse_qsl

import httpx
import pytest

from services.qq_gateway.actions import ActionError
from services.qq_gateway.qzone_client import (
    QZoneAuth,
    QZoneClient,
    QZoneError,
    QZoneIndeterminateError,
)

AUTH = QZoneAuth(
    cookies={"uin": "o010001", "skey": "COOKIE-SECRET", "p_skey": "P-SECRET"},
    gtk="193485963",
    uin="10001",
)
TARGET = "445566"
TID = "abc123"
SECRET_CONTENT = "content-secret-你好"

LIST_URL = "https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6"
WRITE_URL = "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds"
LIKE_URL = "https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app"
DELETE_URL = (
    "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delcomment_ugc"
)


def _call(handler: Callable[[httpx.Request], httpx.Response], method: str,
          *args: Any) -> Any:
    async def scenario() -> Any:
        client = QZoneClient(transport=httpx.MockTransport(handler))
        try:
            return await getattr(client, method)(*args)
        finally:
            await client.close()

    return asyncio.run(scenario())


def _form(request: httpx.Request) -> dict[str, str]:
    return dict(parse_qsl(request.content.decode("utf-8"), keep_blank_values=True))


def _url_without_query(request: httpx.Request) -> str:
    return str(request.url).split("?", 1)[0]


def test_list_feeds_uses_exact_query_and_normalizes_jsonp() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = _url_without_query(request)
        captured["params"] = dict(request.url.params)
        captured["headers"] = dict(request.headers)
        body = (
            '_preloadCallback({"code":0,"msglist":['
            '{"tid":"feed-1","content":"hello world","createTime":1700000000,"uin":10001}]});'
        )
        return httpx.Response(200, text=body)

    feeds = _call(handler, "list_feeds", AUTH, TARGET, 7)

    assert captured["method"] == "GET"
    assert captured["url"] == LIST_URL
    assert captured["params"] == {
        "g_tk": AUTH.gtk,
        "uin": TARGET,
        "ftype": "0",
        "sort": "0",
        "pos": "0",
        "num": "7",
        "replynum": "100",
        "callback": "_preloadCallback",
        "code_version": "1",
        "format": "jsonp",
        "need_comment": "1",
        "need_private_comment": "1",
    }
    headers = captured["headers"]
    assert headers["referer"] == f"https://user.qzone.qq.com/{TARGET}"
    assert headers["origin"] == "https://user.qzone.qq.com"
    assert headers["accept"] == "*/*"
    assert "Chrome" in headers["user-agent"]
    assert "skey=COOKIE-SECRET" in headers["cookie"]
    assert [feed["tid"] for feed in feeds] == ["feed-1"]
    assert feeds[0]["content"] == "hello world"
    assert feeds[0]["uin"] == "10001"


def test_comment_posts_expected_form_and_accepts_frame_callback() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = _url_without_query(request)
        captured["params"] = dict(request.url.params)
        captured["form"] = _form(request)
        return httpx.Response(200, text='frameElement.callback({"code":0});')

    result = _call(handler, "comment", AUTH, TARGET, TID, "hello")

    assert captured["method"] == "POST"
    assert captured["url"] == WRITE_URL
    assert captured["params"] == {"g_tk": AUTH.gtk}
    form = captured["form"]
    assert form["topicId"] == f"{TARGET}_{TID}__1"
    assert form["uin"] == AUTH.uin
    assert form["hostUin"] == TARGET
    assert form["feedsType"] == "100"
    assert form["inCharset"] == "utf-8"
    assert form["outCharset"] == "utf-8"
    assert form["plat"] == "qzone"
    assert form["source"] == "ic"
    assert form["platformid"] == "52"
    assert form["format"] == "json"
    assert form["ref"] == "feeds"
    assert form["content"] == "hello"
    assert result == {
        "success": True,
        "tid": TID,
        "target_qq": TARGET,
        "content_length": 5,
        "code": 0,
    }


def test_comment_accepts_tolerant_js_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, text='frameElement.callback({code:0,subcode:0,message:""});',
        )

    result = _call(handler, "comment", AUTH, TARGET, TID, "hello")

    assert result["success"] is True
    assert result["code"] == 0


def test_comment_nonzero_code_raises_business_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text='frameElement.callback({"code":5});')

    with pytest.raises(QZoneError) as excinfo:
        _call(handler, "comment", AUTH, TARGET, TID, "hello")

    assert isinstance(excinfo.value, ActionError)
    assert excinfo.value.retcode == 1402
    assert not isinstance(excinfo.value, QZoneIndeterminateError)


WRITE_CALLS = [
    pytest.param("comment", (AUTH, TARGET, TID, "hello"), id="comment"),
    pytest.param(
        "reply", (AUTH, TARGET, TID, "comment-9", "thanks", "777", "Alice"), id="reply",
    ),
    pytest.param("like", (AUTH, TARGET, TID), id="like"),
    pytest.param("delete_comment", (AUTH, TARGET, TID, "comment-9"), id="delete-comment"),
]


@pytest.mark.parametrize(("method", "args"), WRITE_CALLS)
def test_write_nonzero_subcode_raises_business_error(
    method: str, args: tuple[Any, ...], caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, text='frameElement.callback({"code":0,"subcode":-12,"message":"fail"});',
        )

    with pytest.raises(QZoneError) as excinfo:
        _call(handler, method, *args)

    assert excinfo.value.retcode == 1402
    assert not isinstance(excinfo.value, QZoneIndeterminateError)
    assert "fail" not in str(excinfo.value)
    assert "fail" not in caplog.text


@pytest.mark.parametrize(("method", "args"), WRITE_CALLS)
def test_write_zero_subcode_is_success(method: str, args: tuple[Any, ...]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text='frameElement.callback({"code":0,"subcode":0});')

    result = _call(handler, method, *args)

    assert result["success"] is True


def test_reply_posts_render_prefix_and_parent_fields() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["form"] = _form(request)
        return httpx.Response(200, text='frameElement.callback({"code":0});')

    result = _call(
        handler, "reply", AUTH, TARGET, TID, "comment-9", "thanks", "777", "Ali{ce}\nX"
    )

    form = captured["form"]
    assert form["topicId"] == f"{TARGET}_{TID}__1"
    assert form["commentId"] == "comment-9"
    assert form["commentUin"] == "777"
    assert form["richtype"] == ""
    assert form["richval"] == ""
    assert form["paramstr"] == "1"
    assert form["content"] == "@{uin:777,nick:AliceX,auto:1}thanks"
    assert form["format"] == "json"
    assert result == {
        "success": True,
        "tid": TID,
        "target_qq": TARGET,
        "content_length": 6,
        "code": 0,
    }


def test_delete_comment_posts_expected_form_and_returns_success() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = _url_without_query(request)
        captured["params"] = dict(request.url.params)
        captured["form"] = _form(request)
        return httpx.Response(200, text='frameElement.callback({"code":0});')

    result = _call(handler, "delete_comment", AUTH, TARGET, TID, "comment-9")

    assert captured["method"] == "POST"
    assert captured["url"] == DELETE_URL
    assert captured["params"] == {"g_tk": AUTH.gtk}
    form = captured["form"]
    assert form["g_tk"] == AUTH.gtk
    assert form["inCharset"] == "utf-8"
    assert form["outCharset"] == "utf-8"
    assert form["plat"] == "qzone"
    assert form["source"] == "ic"
    assert form["hostUin"] == TARGET
    assert form["uin"] == AUTH.uin
    assert form["topicId"] == f"{TARGET}_{TID}__1"
    assert form["feedsType"] == "100"
    assert form["commentId"] == "comment-9"
    assert form["commentUin"] == AUTH.uin
    assert form["format"] == "fs"
    assert form["ref"] == "feeds"
    assert form["paramstr"] == "1"
    assert form["qzreferrer"] == (
        f"https://user.qzone.qq.com/{AUTH.uin}/infocenter?via=toolbar"
    )
    assert form["rand"].isdigit()
    assert result == {
        "success": True,
        "target_qq": TARGET,
        "tid": TID,
        "comment_id": "comment-9",
        "comment_uin": AUTH.uin,
        "code": 0,
    }


def test_delete_comment_uses_explicit_comment_uin() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["form"] = _form(request)
        return httpx.Response(200, text='_preloadCallback({"code":0,"subcode":0});')

    result = _call(handler, "delete_comment", AUTH, TARGET, TID, "comment-9", "777")

    assert captured["form"]["commentUin"] == "777"
    assert result["comment_uin"] == "777"


def test_delete_comment_nonzero_code_raises_business_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text='frameElement.callback({"code":5});')

    with pytest.raises(QZoneError) as excinfo:
        _call(handler, "delete_comment", AUTH, TARGET, TID, "comment-9")

    assert excinfo.value.retcode == 1402
    assert not isinstance(excinfo.value, QZoneIndeterminateError)


def test_delete_comment_timeout_is_indeterminate() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    with pytest.raises(QZoneIndeterminateError) as excinfo:
        _call(handler, "delete_comment", AUTH, TARGET, TID, "comment-9")

    assert excinfo.value.retcode == 0


def test_like_posts_expected_form() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = _url_without_query(request)
        captured["params"] = dict(request.url.params)
        captured["form"] = _form(request)
        return httpx.Response(200, text='_preloadCallback({"code":0});')

    result = _call(handler, "like", AUTH, TARGET, TID)

    assert captured["url"] == LIKE_URL
    assert captured["params"] == {"g_tk": AUTH.gtk}
    form = captured["form"]
    mood_url = f"http://user.qzone.qq.com/{TARGET}/mood/{TID}"
    assert form["qzreferrer"] == f"https://user.qzone.qq.com/{AUTH.uin}"
    assert form["opuin"] == AUTH.uin
    assert form["unikey"] == mood_url
    assert form["curkey"] == mood_url
    assert form["appid"] == "311"
    assert form["from"] == "1"
    assert form["typeid"] == "0"
    assert form["abstime"].isdigit()
    assert form["fid"] == TID
    assert form["active"] == "0"
    assert form["format"] == "json"
    assert form["fupdate"] == "1"
    assert result == {"success": True, "tid": TID, "target_qq": TARGET}


@pytest.mark.parametrize(
    ("status", "retcode"),
    [(302, 1401), (401, 1401), (403, 1402), (429, 1200), (500, 1402)],
)
def test_list_feeds_maps_http_status_to_retcode(status: int, retcode: int) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, headers={"Location": "https://example.invalid/login"})

    with pytest.raises(QZoneError) as excinfo:
        _call(handler, "list_feeds", AUTH, TARGET)

    assert excinfo.value.retcode == retcode


def test_list_feeds_malformed_payload_is_business_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not a jsonp payload")

    with pytest.raises(QZoneError) as excinfo:
        _call(handler, "list_feeds", AUTH, TARGET)

    assert excinfo.value.retcode == 1402


def test_comment_malformed_payload_is_business_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>oops</html>")

    with pytest.raises(QZoneError) as excinfo:
        _call(handler, "comment", AUTH, TARGET, TID, "hello")

    assert excinfo.value.retcode == 1402


def test_write_timeout_is_indeterminate() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    with pytest.raises(QZoneIndeterminateError) as excinfo:
        _call(handler, "comment", AUTH, TARGET, TID, "hello")

    assert excinfo.value.retcode == 0


def test_read_timeout_is_determinate_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    with pytest.raises(QZoneError) as excinfo:
        _call(handler, "list_feeds", AUTH, TARGET)

    assert excinfo.value.retcode == 0
    assert not isinstance(excinfo.value, QZoneIndeterminateError)


def test_invalid_input_uses_retcode_1400() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text='{"code":0}')

    with pytest.raises(QZoneError) as excinfo:
        _call(handler, "list_feeds", AUTH, "")

    assert excinfo.value.retcode == 1400


def test_close_is_idempotent_without_requests() -> None:
    async def scenario() -> None:
        client = QZoneClient(transport=httpx.MockTransport(lambda request: httpx.Response(200)))
        await client.close()
        await client.close()

    asyncio.run(scenario())


def test_errors_and_logs_do_not_leak_sensitive_values(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text='frameElement.callback({"code":9});')

    with pytest.raises(QZoneError) as excinfo:
        _call(handler, "comment", AUTH, TARGET, TID, SECRET_CONTENT)

    message = str(excinfo.value)
    logs = caplog.text
    for secret in (SECRET_CONTENT, "COOKIE-SECRET", "P-SECRET", TARGET,
                   AUTH.uin, "frameElement"):
        assert secret not in message
        assert secret not in logs
