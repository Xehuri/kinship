# -*- coding: utf-8 -*-
"""
阶段 1.5 中危速修回归测试

覆盖:
- M1.5-2 = BE-SEC-M5: /api/mimo/audio/ 短 TTL 签名 URL + commonpath 越界校验
- M1.5-3 = BE-SEC-M6: WebSocket 先鉴权后 accept（无效 token -> 1008）

注: M1.5-1（upload-db 加固）随 P0 裁剪删除——/api/health/upload-db 端点已不存在。
注: M1.5-4（preview 本地模型单例双检锁）随 B3 切线删除——preview 已无本地
模型单例，算法全部经内核（见 tests/test_kernel_wiring.py 的 preview 缝测试）。
"""
import time

import pytest
from fastapi import HTTPException
from starlette.websockets import WebSocketDisconnect

from config.config import get_config
import mimo_signing
import routers.mimo as mimo_router

_TEST_HOST = f"localhost:{get_config().BACKEND_HTTPS_PORT}"
_HEADERS = {"host": _TEST_HOST}


# ============================================================
# M1.5-2 = BE-SEC-M5: MiMo 音频签名 URL
# ============================================================

class TestMimoSignedAudio:
    """音频端点改为短 TTL 签名 URL 后的访问控制"""

    @pytest.fixture
    def mimo_env(self, tmp_path, monkeypatch):
        """把 DATA_DIR 指到临时目录并准备一个音频文件。"""
        data_dir = tmp_path / "data"
        audio_dir = data_dir / "cache" / "mimo_audio"
        audio_dir.mkdir(parents=True)
        (audio_dir / "clip.wav").write_bytes(b"RIFF-fake-audio")

        class _Cfg:
            DATA_DIR = str(data_dir)

        # mimo.py 在模块顶层绑定了 get_config，需直接替换该模块属性
        monkeypatch.setattr(mimo_router, "get_config", lambda: _Cfg())
        return audio_dir

    def test_valid_signature_ok(self, client, mimo_env):
        """有效签名在 TTL 内可正常访问"""
        path = mimo_signing.build_signed_path("clip.wav")
        resp = client.get(path, headers=_HEADERS)
        assert resp.status_code == 200, resp.text
        assert resp.content == b"RIFF-fake-audio"

    def test_missing_signature_forbidden(self, client, mimo_env):
        """无签名 -> 403"""
        resp = client.get("/api/mimo/audio/clip.wav", headers=_HEADERS)
        assert resp.status_code == 403, resp.text

    def test_tampered_signature_forbidden(self, client, mimo_env):
        """签名被篡改 -> 403"""
        exp = int(time.time()) + 60
        resp = client.get(
            "/api/mimo/audio/clip.wav?exp=%d&sig=deadbeef" % exp,
            headers=_HEADERS,
        )
        assert resp.status_code == 403, resp.text

    def test_expired_gone(self, client, mimo_env):
        """签名有效但已过期 -> 410"""
        # exp 落在过去（now 回拨 1000s + ttl 1s）
        path = mimo_signing.build_signed_path("clip.wav", ttl=1, now=time.time() - 1000)
        resp = client.get(path, headers=_HEADERS)
        assert resp.status_code == 410, resp.text

    def test_valid_signature_missing_file_404(self, client, mimo_env):
        """签名有效但文件不存在 -> 404"""
        path = mimo_signing.build_signed_path("nope.wav")
        resp = client.get(path, headers=_HEADERS)
        assert resp.status_code == 404, resp.text

    def test_commonpath_blocks_parent_escape(self, mimo_env):
        """`..` 经 realpath+commonpath 判定为越界 -> 403（不靠字符串前缀）"""
        with pytest.raises(HTTPException) as ei:
            mimo_router._resolve_audio_path("..")
        assert ei.value.status_code == 403

    def test_verify_expired_reason(self):
        """verify_signed_params 对过期返回 'expired'，对篡改返回 'invalid'"""
        exp = int(time.time()) - 5
        sig = mimo_signing._sign("clip.wav", exp)
        assert mimo_signing.verify_signed_params("clip.wav", exp, sig) == "expired"
        assert mimo_signing.verify_signed_params("clip.wav", exp, "bad") == "invalid"
        assert mimo_signing.verify_signed_params("clip.wav", None, None) == "invalid"


# ============================================================
# M1.5-3 = BE-SEC-M6: WebSocket 先鉴权后 accept
# ============================================================

class TestWebSocketAuthBeforeAccept:
    """无效 token 不完成握手，以 1008 关闭"""

    def test_main_ws_invalid_token_1008(self, client):
        with pytest.raises(WebSocketDisconnect) as ei:
            with client.websocket_connect("/ws?token=invalid-token"):
                pass
        assert ei.value.code == 1008

    def test_main_ws_valid_token_connects(self, client, auth_headers):
        token = auth_headers["Authorization"].split(" ", 1)[1]
        with client.websocket_connect("/ws?token=%s" % token) as ws:
            first = ws.receive_json()
            assert first["type"] == "connected"
