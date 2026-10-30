# -*- coding: utf-8 -*-
"""
静态文件路径穿越 (CWE-22) 防护测试

覆盖 main.py 的 _resolve_within 辅助函数，以及 /mobile/ 静态路由的
HTTP 层行为。核心目标：`/mobile/../../../<abs>` 之类的穿越请求不得读取
served root 之外的文件，必须返回 404。

说明：httpx 在构造 URL 时会对明文的 `..` 段做 RFC3986 归一化，因此
`/mobile/../../../Windows/win.ini` 可能被提前规整为 `/Windows/win.ini`
（路由不匹配 -> 404）。百分号编码的 `..%2f` 不会被 URL 归一化，能真正
到达路由处理器，从而验证_handler_ 层的防护逻辑。
"""
from pathlib import Path

from config.config import get_config
from main import _resolve_within

_TEST_HOST = f"localhost:{get_config().BACKEND_HTTPS_PORT}"

# served root: frontend/mobile/dist
_MOBILE_DIR = Path(__file__).resolve().parent.parent.parent / "frontend" / "mobile" / "dist"


class TestResolveWithinHelper:
    """直接对 _resolve_within 做单元测试"""

    def test_rejects_parent_traversal(self):
        """`../../../Windows/win.ini` 越界，返回 None"""
        assert _resolve_within(_MOBILE_DIR, "../../../Windows/win.ini") is None

    def test_rejects_absolute_posix_path(self):
        """绝对路径 `/etc/passwd` 返回 None"""
        assert _resolve_within(_MOBILE_DIR, "/etc/passwd") is None

    def test_rejects_absolute_windows_path(self):
        """绝对路径 `C:\\Windows\\win.ini` 返回 None"""
        assert _resolve_within(_MOBILE_DIR, r"C:\Windows\win.ini") is None

    def test_rejects_relative_parent(self):
        """`../x.txt` 越界，返回 None"""
        assert _resolve_within(_MOBILE_DIR, "../x.txt") is None

    def test_accepts_normal_asset(self):
        """正常相对路径 `assets/app.js` 解析后位于 base 内"""
        resolved = _resolve_within(_MOBILE_DIR, "assets/app.js")
        assert resolved is not None
        base_resolved = _MOBILE_DIR.resolve(strict=False)
        assert resolved == base_resolved or base_resolved in resolved.parents

    def test_accepts_base_itself(self):
        """空相对路径解析为 base 自身"""
        assert _resolve_within(_MOBILE_DIR, "") == _MOBILE_DIR.resolve(strict=False)


class TestMobileStaticTraversalHttp:
    """HTTP 层验证静态路由不再穿越"""

    def _headers(self, auth_headers):
        return {**auth_headers, "host": _TEST_HOST}

    def test_encoded_traversal_returns_404(self, client, auth_headers):
        """编码斜杠 `..%2f` 绕过 URL 归一化，直达处理器 -> 404（非 200/401）"""
        resp = client.get(
            "/mobile/..%2f..%2f..%2f..%2fWindows%2fwin.ini",
            headers=self._headers(auth_headers),
        )
        assert resp.status_code == 404, resp.text

    def test_plain_traversal_returns_404(self, client, auth_headers):
        """明文 `..` 会被 httpx 归一化，最终同样不得返回 200"""
        resp = client.get(
            "/mobile/../../../Windows/win.ini",
            headers=self._headers(auth_headers),
        )
        assert resp.status_code == 404, resp.text

    def test_normal_index_html(self, client, auth_headers):
        """正常 index.html：dist 存在则 200，否则 404"""
        idx = _MOBILE_DIR / "index.html"
        resp = client.get("/mobile/index.html", headers=self._headers(auth_headers))
        if idx.exists():
            assert resp.status_code == 200, resp.text
            assert "text/html" in resp.headers.get("content-type", "")
        else:
            assert resp.status_code == 404, resp.text
