# -*- coding: utf-8 -*-
"""
TTS 语音合成基础测试

覆盖场景：
  - TTS 语音合成请求（需 mock 避免真实 API 调用）
"""
import pytest


class TestTTSSpeak:
    """TTS 语音合成"""

    def test_tts_speak_requires_auth(self, client):
        """POST /api/screen/tts/speak 未认证应返回 401"""
        resp = client.post("/api/screen/tts/speak", json={
            "text": "你好，我是小贺同学"
        })
        assert resp.status_code == 401

    def test_tts_speak_success(self, client, auth_headers, mock_tts_player):
        """
        POST /api/screen/tts/speak 应返回 200。
        mock_tts_player fixture 确保不调用真实的 MiMo API。
        """
        resp = client.post("/api/screen/tts/speak", headers=auth_headers, json={
            "text": "你好，我是小贺同学"
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "sent"
        assert data["message"] == "TTS请求已发送"

    def test_tts_speak_with_voice(self, client, auth_headers, mock_tts_player):
        """POST /api/screen/tts/speak 指定音色应返回 200"""
        resp = client.post("/api/screen/tts/speak", headers=auth_headers, json={
            "text": "今天天气怎么样",
            "voice": "mimo_default",
            "style": "开心"
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "sent"

    def test_tts_speak_send_audio(self, client, auth_headers, mock_tts_player):
        """POST /api/screen/tts/speak send_audio=True 应返回 200"""
        resp = client.post("/api/screen/tts/speak", headers=auth_headers, json={
            "text": "你好",
            "send_audio": True
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "sent"

