# -*- coding: utf-8 -*-
"""P1-V4 vaudit 裁剪三端点契约测试（characterization）

锁 GET /audio/crop、GET /cohort/audio、POST /crop 的现状契约:
- 三态: 200(成功出 mp3) / 400(非法参数或 end<=start) / 404(源文件缺失)
- 响应头形状: content-type 均 audio/mpeg; 仅 POST /crop 带
  content-disposition 下载文件名（两个 GET 无 —— 各端点现状等价）
- POST /crop 的 pydantic 校验面保留: start<0 / end<=0 / 缺字段 -> 422

本文件先于合并编写（跑绿=锁现状）；V4 合并（POST 体复用 _serve_crop、
两个 GET 合一 handler）之后必须依旧全绿 = 行为零变更。
"""
import math
import struct
import wave

import pytest

import routers.voiceprint_audit as vaudit

_TEST_DATE = "2026-01-01"
_TEST_FILE = "000048_default.wav"
_CROP_WINDOW = {"start": 0, "end": 0.8}  # 1.0s fixture 内的有效窗口


def _make_wav(path: str, seconds: float = 1.0) -> str:
    """生成真实可解码的小 WAV(16k/mono/16bit 440Hz 正弦)。"""
    sample_rate = 16000
    num = int(sample_rate * seconds)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(num):
            t = i / sample_rate
            frames += struct.pack(
                "<h", int(32767 * 0.3 * math.sin(2 * math.pi * 440.0 * t)))
        wf.writeframes(bytes(frames))
    return path


@pytest.fixture
def crop_env(tmp_path, monkeypatch):
    """DATA_DIR 重定向到 tmp_path, 在 daily/{date}/audio/ 放真实 WAV。"""
    data_dir = tmp_path / "data"
    audio_dir = data_dir / "daily" / _TEST_DATE / "audio"
    audio_dir.mkdir(parents=True)
    _make_wav(str(audio_dir / _TEST_FILE), seconds=1.0)

    class _Cfg:
        DATA_DIR = str(data_dir)

    # voiceprint_audit 在模块顶层绑定了 get_config, 直接替换模块属性
    monkeypatch.setattr(vaudit, "get_config", lambda: _Cfg())
    return data_dir


def _assert_mp3_payload(resp):
    """裁剪产物可用: 非空且为 mp3 帧/ID3 头, 体量符合 64k mono 短片段。"""
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "audio/mpeg"
    body = resp.content
    assert len(body) > 500, "裁剪产物过小, 疑似 ffmpeg 失败"
    is_id3 = body[:3] == b"ID3"
    is_frame_sync = (body[0] == 0xFF and (body[1] & 0xE0) == 0xE0)
    assert is_id3 or is_frame_sync, f"非 mp3 字节形状: {body[:4]!r}"


# ============================================================
# POST /crop —— app.js L457 活调用面（前端 doCrop）
# ============================================================

class TestPostCropContract:

    def test_200_mp3_with_download_filename(self, client, auth_headers, crop_env):
        resp = client.post("/api/vaudit/crop", headers=auth_headers, json={
            "date": _TEST_DATE, "file": _TEST_FILE, **_CROP_WINDOW})
        _assert_mp3_payload(resp)
        cd = resp.headers.get("content-disposition", "")
        # 现状: POST 带 Content-Disposition 附件名（GET 无）
        assert "attachment" in cd
        assert f"crop_{_TEST_DATE}_{_TEST_FILE}_0.0-0.8.mp3" in cd

    def test_400_bad_date_format(self, client, auth_headers, crop_env):
        resp = client.post("/api/vaudit/crop", headers=auth_headers, json={
            "date": "2026-1-1", "file": _TEST_FILE, **_CROP_WINDOW})
        assert resp.status_code == 400, resp.text

    def test_400_bad_filename(self, client, auth_headers, crop_env):
        resp = client.post("/api/vaudit/crop", headers=auth_headers, json={
            "date": _TEST_DATE, "file": "bad name.wav", **_CROP_WINDOW})
        assert resp.status_code == 400, resp.text

    def test_400_end_le_start(self, client, auth_headers, crop_env):
        # 两值均过 pydantic(ge=0/gt=0) 但 end<=start → 裁剪层 400
        resp = client.post("/api/vaudit/crop", headers=auth_headers, json={
            "date": _TEST_DATE, "file": _TEST_FILE, "start": 0.5, "end": 0.2})
        assert resp.status_code == 400, resp.text

    def test_404_missing_source(self, client, auth_headers, crop_env):
        resp = client.post("/api/vaudit/crop", headers=auth_headers, json={
            "date": _TEST_DATE, "file": "no_such_file.wav", **_CROP_WINDOW})
        assert resp.status_code == 404, resp.text

    @pytest.mark.parametrize("bad_body", [
        {"date": _TEST_DATE, "file": _TEST_FILE, "start": -1, "end": 0.5},  # ge=0
        {"date": _TEST_DATE, "file": _TEST_FILE, "start": 0, "end": 0},     # gt=0
        {"date": _TEST_DATE, "start": 0, "end": 0.5},                        # 缺 file
    ])
    def test_422_pydantic_surface_kept(self, client, auth_headers, crop_env, bad_body):
        resp = client.post("/api/vaudit/crop", headers=auth_headers, json=bad_body)
        assert resp.status_code == 422, resp.text


# ============================================================
# GET /audio/crop —— daily 页 audio_url 下发模板驱动
# ============================================================

class TestGetAudioCropContract:

    def test_200_mp3_no_content_disposition(self, client, auth_headers, crop_env):
        resp = client.get("/api/vaudit/audio/crop", headers=auth_headers,
                          params={"date": _TEST_DATE, "file": _TEST_FILE,
                                  **_CROP_WINDOW})
        _assert_mp3_payload(resp)
        # 现状: 该 GET 不带下载文件名
        assert "content-disposition" not in resp.headers

    def test_400_missing_params(self, client, auth_headers, crop_env):
        resp = client.get("/api/vaudit/audio/crop", headers=auth_headers)
        assert resp.status_code == 400, resp.text

    def test_400_end_le_start(self, client, auth_headers, crop_env):
        resp = client.get("/api/vaudit/audio/crop", headers=auth_headers,
                          params={"date": _TEST_DATE, "file": _TEST_FILE,
                                  "start": 0.5, "end": 0.2})
        assert resp.status_code == 400, resp.text

    def test_404_missing_source(self, client, auth_headers, crop_env):
        resp = client.get("/api/vaudit/audio/crop", headers=auth_headers,
                          params={"date": _TEST_DATE, "file": "no_such_file.wav",
                                  **_CROP_WINDOW})
        assert resp.status_code == 404, resp.text


# ============================================================
# GET /cohort/audio —— cohort 页 audio_url 下发模板驱动(参数名 src)
# ============================================================

class TestGetCohortAudioContract:

    def test_200_mp3_no_content_disposition(self, client, auth_headers, crop_env):
        resp = client.get("/api/vaudit/cohort/audio", headers=auth_headers,
                          params={"date": _TEST_DATE, "src": _TEST_FILE,
                                  **_CROP_WINDOW})
        _assert_mp3_payload(resp)
        assert "content-disposition" not in resp.headers

    def test_400_missing_params(self, client, auth_headers, crop_env):
        resp = client.get("/api/vaudit/cohort/audio", headers=auth_headers)
        assert resp.status_code == 400, resp.text

    def test_400_end_le_start(self, client, auth_headers, crop_env):
        resp = client.get("/api/vaudit/cohort/audio", headers=auth_headers,
                          params={"date": _TEST_DATE, "src": _TEST_FILE,
                                  "start": 0.5, "end": 0.2})
        assert resp.status_code == 400, resp.text

    def test_404_missing_source(self, client, auth_headers, crop_env):
        resp = client.get("/api/vaudit/cohort/audio", headers=auth_headers,
                          params={"date": _TEST_DATE, "src": "no_such_file.wav",
                                  **_CROP_WINDOW})
        assert resp.status_code == 404, resp.text
