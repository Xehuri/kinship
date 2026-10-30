# -*- coding: utf-8 -*-
"""
PC 采集端下载端点测试

覆盖场景：
  - 未认证访问（无 Bearer / 无 ticket）返回 401
  - 文件存在时下载返回 200，附件名 / 大小 / SHA-256 头正确
  - 文件不存在时下载返回 404
  - /info 在文件存在 / 不存在时的字段契约
  - 一次性 ?ticket= 查询凭证可用于下载（浏览器 <a download> 场景）
  - _format_size 单位换算

文件路径通过环境变量 PC_SENSOR_EXE_PATH 注入临时文件，不依赖仓库内的真实 exe
（真实 exe 约 34MB 且被 .gitignore 忽略，CI/新克隆环境不一定存在）。
"""
import pytest

from config.config import get_config

_TEST_HOST = f"localhost:{get_config().BACKEND_HTTPS_PORT}"

# 供测试写入的伪 exe 内容（约 1.5KB，足够校验大小与哈希）
_FAKE_BYTES = b"FAKE-EXE-BYTES" * 100


def _headers(auth_headers):
    """附带 host 头（与其他后端测试保持一致）"""
    return {**auth_headers, "host": _TEST_HOST}


@pytest.fixture
def fake_exe(monkeypatch, tmp_path):
    """把 PC_SENSOR_EXE_PATH 指向临时文件，并返回该路径"""
    exe = tmp_path / "Kinship-PCSensor.exe"
    exe.write_bytes(_FAKE_BYTES)
    monkeypatch.setenv("PC_SENSOR_EXE_PATH", str(exe))
    return exe


@pytest.fixture
def missing_exe(monkeypatch, tmp_path):
    """把 PC_SENSOR_EXE_PATH 指向不存在的路径，并返回该路径"""
    exe = tmp_path / "not-built.exe"
    monkeypatch.setenv("PC_SENSOR_EXE_PATH", str(exe))
    return exe


class TestAuth:
    """未认证一律 401"""

    def test_download_requires_auth(self, client):
        resp = client.get("/api/pc-sensor/download")
        assert resp.status_code == 401

    def test_info_requires_auth(self, client):
        resp = client.get("/api/pc-sensor/info")
        assert resp.status_code == 401


class TestDownload:
    """下载端点"""

    def test_download_ok(self, client, auth_headers, fake_exe):
        resp = client.get("/api/pc-sensor/download", headers=_headers(auth_headers))
        assert resp.status_code == 200
        assert resp.content == _FAKE_BYTES
        disposition = resp.headers.get("content-disposition", "")
        assert "Kinship-PCSensor.exe" in disposition
        assert resp.headers.get("x-file-size") == str(len(_FAKE_BYTES))
        assert len(resp.headers.get("x-file-sha256", "")) == 64

    def test_download_missing_file_returns_404(self, client, auth_headers, missing_exe):
        resp = client.get("/api/pc-sensor/download", headers=_headers(auth_headers))
        assert resp.status_code == 404
        # 统一异常处理器 (core/errors.py) 会把 HTTPException 包装为 ApiResponse,
        # 因此这里只校验提示文案被透出, 不依赖 detail 字段名
        assert "未构建" in resp.text

    def test_download_with_one_time_ticket(self, client, auth_headers, fake_exe):
        """不带 Authorization，仅用一次 ?ticket= 应可下载"""
        ticket_resp = client.post("/auth/ws-ticket", headers=_headers(auth_headers))
        assert ticket_resp.status_code == 200
        ticket = ticket_resp.json()["ticket"]

        resp = client.get(
            "/api/pc-sensor/download",
            params={"ticket": ticket},
            headers={"host": _TEST_HOST},
        )
        assert resp.status_code == 200
        assert resp.content == _FAKE_BYTES

    def test_invalid_ticket_rejected(self, client, fake_exe):
        resp = client.get(
            "/api/pc-sensor/download",
            params={"ticket": "not-a-real-ticket"},
            headers={"host": _TEST_HOST},
        )
        assert resp.status_code == 401


class TestInfo:
    """文件信息端点"""

    def test_info_exists(self, client, auth_headers, fake_exe):
        resp = client.get("/api/pc-sensor/info", headers=_headers(auth_headers))
        assert resp.status_code == 200
        data = resp.json()
        assert data["exists"] is True
        assert data["filename"] == "Kinship-PCSensor.exe"
        assert data["size"] == len(_FAKE_BYTES)
        assert data["size_text"] != ""
        assert data["mtime"] > 0
        # 轻量端点不计算哈希（下载响应头才带）
        assert data["sha256"] is None

    def test_info_missing(self, client, auth_headers, missing_exe):
        resp = client.get("/api/pc-sensor/info", headers=_headers(auth_headers))
        assert resp.status_code == 200
        data = resp.json()
        assert data["exists"] is False
        assert data["size"] == 0
        assert data["size_text"] == ""
        assert "未构建" in data["hint"]


class TestDefaultPath:
    """默认路径：无环境变量/配置覆盖时指向 Kinship-PCSensor.exe"""

    def test_default_path_points_to_kinship_exe(self, monkeypatch):
        monkeypatch.delenv("PC_SENSOR_EXE_PATH", raising=False)
        path = get_config().PC_SENSOR_EXE_PATH
        assert path.endswith("desktop/pc-sensor/dist/Kinship-PCSensor.exe")


class TestFormatSize:
    """_format_size 单位换算"""

    def test_units(self):
        from routers.pc_sensor_download import _format_size

        assert _format_size(0) == ""
        assert _format_size(512) == "512 B"
        assert _format_size(2048) == "2.0 KB"
        assert _format_size(1024 * 1024) == "1.0 MB"
        assert _format_size(35566743) == "33.9 MB"
