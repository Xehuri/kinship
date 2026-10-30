# -*- coding: utf-8 -*-
"""K4d 外层接线测试：wake_word 两路由经内核 / 外层副作用保留 / 断连 503。

约定（docs/kernel-design.md §7 wake_word 行）:
  - POST /api/screen/wake_word/encode   -> 内核 POST /v1/kws/encode（httpx
    MockTransport 桩，绝不 spawn 真内核），响应形状与旧实现逐键一致
    {ok, keywords, items[{text,line}], message}
  - POST /api/screen/wake_word/keywords -> 编码在内核，但词表文件写入 +
    运行时目标词刷新 + 已加载模型失效三个副作用全部留在外层
  - 内核断连 -> 两路由都 503 {"error":{"code":"state.unavailable",...}}
    （/keywords 写文件必须先有 token 行，不可降级 —— 见
    test_keywords_kernel_down_503_because_write_requires_tokens）
  - 内核业务错误（model.unavailable 等）-> /encode 映射 200 ok=false、
    /keywords 映射 400 _sync_payload，保持客户端既有错误形状
"""
import httpx
import pytest

from services import kernel_client as kc

# 与 kernel/tests/test_kws_encode.py 同一 fixture（逐位一致）
FIXTURE_TEXT = "小贺同学"
FIXTURE_LINE = "x iǎo h è t óng x ué @小贺同学"


def _envelope(keywords, lines):
    """内核 /v1/kws/encode 成功信封。"""
    return {
        "schema_version": "1",
        "facts": {"keywords": keywords, "lines": lines, "count": len(lines)},
        "provenance": {
            "tokenizer": "sherpa-onnx-text2token-phone+ppinyin",
            "model_dir": "D:/x/model",
            "computed_at": "2026-09-23T00:00:00+00:00",
        },
    }


def _stub(handler):
    """构造打桩内核客户端（已连接，不 spawn）。"""
    return kc.KernelClient(
        base_url="http://kernel.test", token="t",
        transport=httpx.MockTransport(handler),
    )


def _down_client():
    def _raise(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    return _stub(_raise)


@pytest.fixture
def patch_kernel(request, monkeypatch):
    """工厂夹具：patch_kernel(handler_or_client) -> 安装内核桩（同 K2 惯例）。"""

    def _install(client_or_factory):
        client = (client_or_factory() if callable(client_or_factory)
                  else client_or_factory)
        monkeypatch.setattr(kc, "get_kernel_client", lambda: client)
        kc._reset_down_state()
        return client

    return _install


@pytest.fixture
def audio_cfg(monkeypatch, tmp_path):
    """打桩 audio 配置：model_dir 任意非空 + keywords_file 指向临时文件。

    路由在函数体内 ``from services.audio_config import ...`` 动态导入，
    patch 模块属性即生效；keywords_file 用绝对路径时 resolve_path 原样返回。
    """
    import services.audio_config as ac

    keywords_file = str(tmp_path / "keywords.txt")

    def _get():
        return {
            "wake_word": {
                "model_dir": "ai/data/wake_word/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20",
                "keywords_file": keywords_file,
            }
        }

    monkeypatch.setattr(ac, "get_audio_config", _get)
    return keywords_file


@pytest.fixture
def service_spy(monkeypatch):
    """打桩 wake_word_service 的外层副作用（刷新目标词）。"""
    from services import wake_word_service as wws

    calls = {"set": []}

    def _set(keywords):
        calls["set"].append(list(keywords))
        return list(keywords)

    monkeypatch.setattr(wws, "set_target_keywords", _set)
    return calls


# ============================================================
# 1) /encode 经内核 happy path（响应形状与旧实现一致）
# ============================================================

def test_encode_via_kernel_returns_current_shape(client, auth_headers, patch_kernel):
    seen = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/kws/encode"
        assert request.headers["Authorization"] == "Bearer t"
        import json as _json
        seen["payload"] = _json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200, json=_envelope([FIXTURE_TEXT], [FIXTURE_LINE])
        )

    patch_kernel(_stub(_handler))
    resp = client.post(
        "/api/screen/wake_word/encode",
        json={"text": FIXTURE_TEXT},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # 既有客户端契约: 四键形状不变
    assert set(body) == {"ok", "keywords", "items", "message"}
    assert body["ok"] is True
    assert body["keywords"] == FIXTURE_LINE
    assert body["items"] == [{"text": FIXTURE_TEXT, "line": FIXTURE_LINE}]
    assert body["message"] == ""
    # 外层把拆分后的词与解析出的模型目录下发内核
    assert seen["payload"]["keywords"] == [FIXTURE_TEXT]
    assert seen["payload"]["model_dir"].endswith(
        "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20"
    )


def test_encode_kernel_down_503_state_unavailable(client, auth_headers, patch_kernel):
    """内核断连 -> 503 封闭码（交互编码不降级跳过，必须 token 或明确错误）。"""
    patch_kernel(_down_client())
    resp = client.post(
        "/api/screen/wake_word/encode",
        json={"text": FIXTURE_TEXT},
        headers=auth_headers,
    )
    assert resp.status_code == 503, resp.text
    err = resp.json()["error"]
    assert err["code"] == "state.unavailable"
    assert err["retryable"] is True


def test_encode_kernel_business_error_keeps_200_ok_false_shape(
    client, auth_headers, patch_kernel
):
    """内核业务错误（如 sherpa 缺失 503）-> 200 {ok:false,message}（旧形状）。"""

    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            503,
            json={"error": {
                "code": "model.unavailable",
                "message": "sherpa-onnx 不可用: No module named 'sherpa_onnx'",
                "retryable": True,
            }},
        )

    patch_kernel(_stub(_handler))
    resp = client.post(
        "/api/screen/wake_word/encode",
        json={"text": FIXTURE_TEXT},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"ok", "keywords", "items", "message"}
    assert body["ok"] is False
    assert "sherpa-onnx 不可用" in body["message"]
    assert body["keywords"] == ""
    assert body["items"] == []


def test_encode_empty_text_skips_kernel(client, auth_headers, patch_kernel):
    """空文本 -> 旧 200 ok=false 文案，且根本不触达内核。"""

    def _handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("空文本不应调用内核")

    patch_kernel(_stub(_handler))
    resp = client.post(
        "/api/screen/wake_word/encode", json={"text": " , ， "}, headers=auth_headers
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["message"] == "未提供唤醒词文本"


# ============================================================
# 2) /keywords：编码在内核，副作用留外层（刷新目标词）
# ============================================================

def test_keywords_writes_file_and_refreshes(
    client, auth_headers, patch_kernel, audio_cfg, service_spy
):
    """happy path: 内核编码 -> 写词表文件 + 刷新目标词（两断言）。"""

    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json=_envelope([FIXTURE_TEXT], [FIXTURE_LINE])
        )

    patch_kernel(_stub(_handler))
    resp = client.post(
        "/api/screen/wake_word/keywords",
        json={"keywords": FIXTURE_TEXT},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["keywords"] == [FIXTURE_LINE]
    assert body["target"] == FIXTURE_TEXT
    # ① 词表文件落盘（覆盖写，每行一个 token 行）
    with open(audio_cfg, encoding="utf-8") as f:
        assert f.read() == FIXTURE_LINE + "\n"
    # ② 运行时目标词刷新（传入 @ 标签原文）
    assert service_spy["set"] == [[FIXTURE_TEXT]]


def test_keywords_kernel_down_503_because_write_requires_tokens(
    client, auth_headers, patch_kernel, audio_cfg, service_spy
):
    """内核断连 -> 503：写词表必须先有 token 行，无法降级，文件与副作用均不触发。"""
    patch_kernel(_down_client())
    resp = client.post(
        "/api/screen/wake_word/keywords",
        json={"keywords": FIXTURE_TEXT},
        headers=auth_headers,
    )
    assert resp.status_code == 503, resp.text
    assert resp.json()["error"]["code"] == "state.unavailable"
    # 无 token -> 不写文件、不刷新
    import os
    assert not os.path.exists(audio_cfg)
    assert service_spy["set"] == []


def test_keywords_kernel_business_error_maps_to_400_sync_payload(
    client, auth_headers, patch_kernel, audio_cfg, service_spy
):
    """内核业务错误 -> 400 {ok:false,...}（既有 _sync_payload 错误形状）。"""

    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            503,
            json={"error": {
                "code": "model.unavailable",
                "message": "模型文件缺失: D:/x/tokens.txt",
                "retryable": True,
            }},
        )

    patch_kernel(_stub(_handler))
    resp = client.post(
        "/api/screen/wake_word/keywords",
        json={"keywords": FIXTURE_TEXT},
        headers=auth_headers,
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert body["message"] == "模型文件缺失: D:/x/tokens.txt"
    assert body["keywords"] == []
    # 失败路径不触碰外层副作用
    import os
    assert not os.path.exists(audio_cfg)
    assert service_spy["set"] == []


def test_keywords_empty_skips_kernel(
    client, auth_headers, patch_kernel, audio_cfg
):
    """空词表 -> 旧 400 唤醒词为空，且不触达内核。"""

    def _handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("空词表不应调用内核")

    patch_kernel(_stub(_handler))
    resp = client.post(
        "/api/screen/wake_word/keywords", json={"keywords": ""}, headers=auth_headers
    )
    assert resp.status_code == 400
    assert resp.json()["message"] == "唤醒词为空"
