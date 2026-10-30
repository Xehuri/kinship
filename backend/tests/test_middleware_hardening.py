# -*- coding: utf-8 -*-
"""
E2 中间件加固测试

覆盖本次加固的 5 项内容：
  1. 根路径 / 重定向到 /mobile/
  2. CORS 允许来源从配置派生 (不再写死 8768)
  3. GZip 响应压缩生效
  4. 非 CSP 安全响应头存在 (D6: 本任务不引入 CSP)
  5. 两份静态扩展名白名单刻意保持独立 (D9, 用途不同, 不合并)

说明：
  - 配置来源 config.yaml: http_port=8769 / https_port=8768。
  - _ASSET_EXTS 位于 main.py（SPA fallback 判定）;
    _STATIC_EXTS 位于 middleware/auth_middleware.py（认证豁免判定）。
"""
from pathlib import Path

from config.config import get_config
from main import _ASSET_EXTS
from middleware.auth_middleware import _STATIC_EXTS as _AUTH_STATIC_EXTS

_TEST_HOST = f"localhost:{get_config().BACKEND_HTTPS_PORT}"

# 前端构建产物目录（GZip 大响应验证用）
_DIST_ASSETS = (
    Path(__file__).resolve().parent.parent.parent
    / "frontend" / "mobile" / "dist" / "assets"
)


class TestRootRedirect:
    """根路径 / 应重定向到 /mobile/ 而不是 404"""

    def test_root_redirects_to_mobile(self, client):
        resp = client.get("/", follow_redirects=False, headers={"host": _TEST_HOST})
        assert resp.status_code in (307, 308), f"期望重定向, 实际 {resp.status_code}"
        assert resp.headers.get("location") == "/mobile/"

    def test_root_is_public(self, client):
        """根路径无需认证(位于 PUBLIC_PATHS), 不应返回 401"""
        resp = client.get("/", follow_redirects=False, headers={"host": _TEST_HOST})
        assert resp.status_code != 401


class TestCorsOrigins:
    """CORS 白名单来源由配置端口派生"""

    def _cfg(self):
        return get_config()

    def test_configured_http_origin_allowed(self, client):
        """配置的 http_port 来源应被允许(历史 bug: 写死 8768 与 8769 不一致)"""
        origin = f"http://localhost:{self._cfg().BACKEND_HTTP_PORT}"
        resp = client.get(
            "/health",
            headers={"Origin": origin, "host": _TEST_HOST},
        )
        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") == origin

    def test_configured_https_origin_allowed(self, client):
        """配置的 https_port 来源也应被允许"""
        origin = f"https://127.0.0.1:{self._cfg().BACKEND_HTTPS_PORT}"
        resp = client.get(
            "/health",
            headers={"Origin": origin, "host": _TEST_HOST},
        )
        assert resp.headers.get("access-control-allow-origin") == origin

    def test_unknown_origin_not_allowed(self, client):
        """未列入白名单的来源不应拿到 ACAO 头"""
        resp = client.get(
            "/health",
            headers={"Origin": "http://evil.example.com", "host": _TEST_HOST},
        )
        assert "access-control-allow-origin" not in resp.headers


class TestSecurityHeaders:
    """非 CSP 安全响应头 (D6)"""

    def test_health_has_security_headers(self, client):
        resp = client.get("/health", headers={"host": _TEST_HOST})
        assert resp.status_code == 200
        h = resp.headers
        assert h.get("X-Content-Type-Options") == "nosniff"
        assert h.get("X-Frame-Options") == "SAMEORIGIN"
        assert h.get("Referrer-Policy") == "strict-origin-when-cross-origin"
        assert h.get("Permissions-Policy") == "camera=(), microphone=(), geolocation=()"

    def test_no_csp_header(self, client):
        """D6 约定: 本任务不引入 CSP"""
        resp = client.get("/health", headers={"host": _TEST_HOST})
        assert "Content-Security-Policy" not in resp.headers

    def test_unauthorized_response_also_has_headers(self, client):
        """401 响应也应带安全头(安全头中间件位于认证中间件外层)"""
        resp = client.get("/api/screen/session/list", headers={"host": _TEST_HOST})
        assert resp.status_code == 401
        assert resp.headers.get("X-Content-Type-Options") == "nosniff"


class TestGZipCompression:
    """GZip 响应压缩"""

    def test_large_asset_is_gzipped(self, client):
        js_files = sorted(_DIST_ASSETS.glob("*.js"))
        assert js_files, f"前端构建产物缺失: {_DIST_ASSETS}"
        name = js_files[0].name
        resp = client.get(
            f"/mobile/assets/{name}",
            headers={"host": _TEST_HOST, "Accept-Encoding": "gzip"},
        )
        assert resp.status_code == 200
        assert resp.headers.get("content-encoding") == "gzip"

    def test_small_response_not_gzipped(self, client):
        """小于 minimum_size(1KB) 的 /health 不应被压缩"""
        resp = client.get(
            "/health",
            headers={"host": _TEST_HOST, "Accept-Encoding": "gzip"},
        )
        assert resp.status_code == 200
        assert resp.headers.get("content-encoding") != "gzip"


class TestStaticExtensionWhitelists:
    """D9: 两份白名单用途不同, 刻意保持独立(不合并)"""

    @staticmethod
    def _as_str_set(exts: tuple[str, ...]) -> set[str]:
        """归一为 set[str], 避免两处 Literal 元组做集合差集时的类型噪声。"""
        return {str(ext) for ext in exts}

    def test_both_cover_core_assets(self):
        for ext in (".js", ".css", ".png", ".svg", ".woff2"):
            assert ext in _ASSET_EXTS, f"main._ASSET_EXTS 缺少核心资源 {ext}"
            assert ext in _AUTH_STATIC_EXTS, f"auth._STATIC_EXTS 缺少核心资源 {ext}"

    def test_whitelists_are_not_identical(self):
        """不同用途 -> 不应完全相同; 若将来被合并, 本测试会失败提醒"""
        assert _ASSET_EXTS != _AUTH_STATIC_EXTS

    def test_main_only_exts(self):
        """main._ASSET_EXTS 独有: SPA fallback 关注的媒体/数据类扩展名"""
        main_only = self._as_str_set(_ASSET_EXTS) - self._as_str_set(_AUTH_STATIC_EXTS)
        for ext in (".jpg", ".jpeg", ".gif", ".json", ".wasm"):
            assert ext in main_only

    def test_auth_only_exts(self):
        """auth._STATIC_EXTS 独有: 认证豁免关注的构建产物扩展名"""
        auth_only = self._as_str_set(_AUTH_STATIC_EXTS) - self._as_str_set(_ASSET_EXTS)
        for ext in (".html", ".map", ".webmanifest", ".txt"):
            assert ext in auth_only
