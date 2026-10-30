# -*- coding: utf-8 -*-
import json
from pathlib import Path

import pytest

from config.config import get_config

_TEST_HOST = f"localhost:{get_config().BACKEND_HTTPS_PORT}"


@pytest.fixture(autouse=True)
def _seed_mobile_data_root():
    """在隔离的 DATA_DIR 下生成文件浏览测试所需的最小样本。"""
    data_root = Path(get_config().DATA_DIR)
    day = data_root / "daily" / "2026-06-06"
    day.mkdir(parents=True, exist_ok=True)
    (day / "health.json").write_text(
        json.dumps({"date": "2026-06-06", "samples": []}), encoding="utf-8"
    )
    (day / "perception.jsonl").write_text(
        json.dumps({"ts": 1, "text": "sample"}) + "\n", encoding="utf-8"
    )

"""
手机端文件浏览 API 测试

覆盖场景：
  - 列出根目录
  - 按日期列出目录
  - 不存在的路径返回 404
  - 目录穿越被拒绝返回 403
  - 读取 JSON 文件内容
  - 读取 JSONL 文件内容
  - 不存在的文件返回 404
  - 公开路径无需认证
"""


class TestListFiles:
    """列出目录内容"""

    def _auth_headers(self, client, auth_headers):
        return {**auth_headers, "host": _TEST_HOST}

    def test_list_root(self, client, auth_headers):
        """GET /api/mobile/files?path= 应返回根目录列表"""
        resp = client.get("/api/mobile/files", params={"path": ""}, headers=self._auth_headers(client, auth_headers))
        assert resp.status_code == 200
        data = resp.json()
        assert "entries" in data
        assert isinstance(data["entries"], list)
        # 根目录应包含 daily 数据子目录
        names = [e["name"] for e in data["entries"]]
        assert "daily" in names

    def test_list_by_date(self, client, auth_headers):
        """GET /api/mobile/files?path=daily/2026-06-06 应返回该日目录下的文件"""
        resp = client.get("/api/mobile/files", params={"path": "daily/2026-06-06"}, headers=self._auth_headers(client, auth_headers))
        assert resp.status_code == 200
        data = resp.json()
        assert "entries" in data
        names = [e["name"] for e in data["entries"]]
        assert "health.json" in names or "perception.jsonl" in names or "profile.json" in names
        # 验证所有条目都有必需字段
        for entry in data["entries"]:
            assert "name" in entry
            assert "type" in entry
            assert "mtime" in entry
            assert entry["type"] in ("dir", "json", "jsonl", "txt", "md", "wav", "jpg", "png", "file")

    def test_list_nonexistent(self, client, auth_headers):
        """GET /api/mobile/files?path=daily/2099-99-99 不存在的路径应返回空列表"""
        resp = client.get("/api/mobile/files", params={"path": "daily/2099-99-99"}, headers=self._auth_headers(client, auth_headers))
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data.get("entries"), list)

    def test_list_path_traversal(self, client, auth_headers):
        """GET /api/mobile/files?path=../../../etc 目录穿越应返回 403"""
        resp = client.get("/api/mobile/files", params={"path": "../../../etc"},
                          headers=self._auth_headers(client, auth_headers))
        assert resp.status_code == 403
        data = resp.json()
        assert "error" in data and data["error"]["code"] == "FORBIDDEN"
        assert "拒绝" in data["error"]["message"] or "禁止" in data["error"]["message"]

    def test_list_file_path_not_directory(self, client, auth_headers):
        """GET /api/mobile/files?path=daily/2026-06-06/health.json 路径是文件不是目录应返回 400"""
        resp = client.get("/api/mobile/files", params={"path": "daily/2026-06-06/health.json"},
                          headers=self._auth_headers(client, auth_headers))
        assert resp.status_code == 400
        data = resp.json()
        assert "error" in data and data["error"]["code"] == "INTERNAL_ERROR"

    def test_list_requires_auth(self, client):
        """安全加固: GET /api/mobile/files 无 token 应返回 401"""
        resp = client.get("/api/mobile/files", params={"path": ""}, headers={"host": _TEST_HOST})
        assert resp.status_code == 401


class TestReadFile:
    """读取文件内容"""

    def test_read_json(self, client, auth_headers):
        """GET /api/mobile/files/content?path=daily/2026-06-06/health.json 应返回 {content} 包裹的原始文本"""
        headers = {**auth_headers, "host": _TEST_HOST}
        resp = client.get("/api/mobile/files/content", params={"path": "daily/2026-06-06/health.json"},
                          headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        # 现在返回 {content: raw_text}，不再直接返回解析后的 JSON 对象
        assert "content" in data
        assert isinstance(data["content"], str)
        assert "type" in data
        assert data["type"] == "json"
        parsed = json.loads(data["content"])
        assert "date" in parsed
        assert parsed["date"] == "2026-06-06"
        assert "samples" in parsed
        assert isinstance(parsed["samples"], list)

    def test_read_jsonl(self, client, auth_headers):
        """GET /api/mobile/files/content?path=daily/2026-06-06/perception.jsonl 应返回对象数组"""
        headers = {**auth_headers, "host": _TEST_HOST}
        resp = client.get("/api/mobile/files/content", params={"path": "daily/2026-06-06/perception.jsonl"},
                          headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "objects" in data
        assert "total_lines" in data
        assert "parse_errors" in data
        assert isinstance(data["objects"], list)
        assert data["total_lines"] > 0
        assert data["parse_errors"] == 0

    def test_read_file_not_found(self, client, auth_headers):
        """GET /api/mobile/files/content?path=nonexistent/file.json 不存在的文件应返回 404"""
        headers = {**auth_headers, "host": _TEST_HOST}
        resp = client.get("/api/mobile/files/content", params={"path": "nonexistent/file.json"},
                          headers=headers)
        assert resp.status_code == 404
        data = resp.json()
        assert "error" in data and data["error"]["code"] == "NOT_FOUND"

    def test_read_path_traversal(self, client, auth_headers):
        """GET /api/mobile/files/content?path=../../../etc/passwd 目录穿越应返回 403"""
        headers = {**auth_headers, "host": _TEST_HOST}
        resp = client.get("/api/mobile/files/content", params={"path": "../../../etc/passwd"},
                          headers=headers)
        assert resp.status_code == 403
        data = resp.json()
        assert "error" in data and data["error"]["code"] == "FORBIDDEN"
        assert "拒绝" in data["error"]["message"] or "禁止" in data["error"]["message"]


class TestAuth:
    """认证检查"""

    def test_requires_auth(self, client):
        """
        安全加固: /api/mobile/files 不再是无认证公开路径。
        所有数据端点均需 token 认证。
        """
        resp = client.get("/api/mobile/files")
        assert resp.status_code == 401


class TestSecretFileDenylist:
    """文件浏览 API 不得列出或读取密钥/凭证类路径。"""

    SECRET_TEXT = "sk-live-DO-NOT-LEAK-0123456789"

    @pytest.fixture()
    def secret_files(self):
        data_root = Path(get_config().DATA_DIR)
        ai_root = Path(get_config().AI_ROOT)

        tasks_dir = data_root / "tasks"
        tasks_dir.mkdir(parents=True, exist_ok=True)
        (tasks_dir / "deepseek_key.txt").write_text(self.SECRET_TEXT, encoding="utf-8")
        (tasks_dir / "keep.txt").write_text("ordinary", encoding="utf-8")

        loom_dir = ai_root / ".loom"
        loom_dir.mkdir(parents=True, exist_ok=True)
        (loom_dir / "config.yaml").write_text(
            f"token: {self.SECRET_TEXT}\n", encoding="utf-8"
        )
        return data_root, ai_root

    def _auth_headers(self, auth_headers):
        return {**auth_headers, "host": _TEST_HOST}

    def test_list_hides_secret_entries(self, client, auth_headers, secret_files):
        headers = self._auth_headers(auth_headers)
        resp = client.get("/api/mobile/files", params={"path": "tasks"}, headers=headers)
        assert resp.status_code == 200
        names = [entry["name"] for entry in resp.json()["entries"]]
        assert "deepseek_key.txt" not in names
        assert "keep.txt" in names
        assert self.SECRET_TEXT not in resp.text

    def test_read_secret_file_denied(self, client, auth_headers, secret_files):
        headers = self._auth_headers(auth_headers)
        resp = client.get(
            "/api/mobile/files/content",
            params={"path": "tasks/deepseek_key.txt"},
            headers=headers,
        )
        assert resp.status_code == 403
        assert self.SECRET_TEXT not in resp.text

    def test_raw_secret_file_denied(self, client, auth_headers, secret_files):
        headers = self._auth_headers(auth_headers)
        resp = client.get(
            "/api/mobile/files/raw",
            params={"path": "tasks/deepseek_key.txt"},
            headers=headers,
        )
        assert resp.status_code == 403
        assert self.SECRET_TEXT not in resp.text

    def test_read_loom_config_denied(self, client, auth_headers, secret_files):
        headers = self._auth_headers(auth_headers)
        for path in (".loom", ".loom/config.yaml"):
            resp = client.get(
                "/api/mobile/files/content",
                params={"path": path, "scope": "root"},
                headers=headers,
            )
            assert resp.status_code == 403
            assert self.SECRET_TEXT not in resp.text

    def test_list_loom_directory_denied(self, client, auth_headers, secret_files):
        headers = self._auth_headers(auth_headers)
        resp = client.get(
            "/api/mobile/files", params={"path": ".loom", "scope": "root"}, headers=headers
        )
        assert resp.status_code == 403
        assert self.SECRET_TEXT not in resp.text
