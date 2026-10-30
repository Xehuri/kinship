# -*- coding: utf-8 -*-
"""
安全整改阶段 2 回归测试

覆盖:
- BE-SEC-H1: query token 收敛 + 一次性 ticket（含 WS 票据握手）
- BE-SEC-H2: 关闭 /docs 前缀过宽修正（setup 引导令牌见 test_auth_api_setup.py）
- BE-SEC-M1: 登录失败速率限制 / 临时锁定

注: BE-SEC-H3（/auth/revoke 显式吊销端点）随 P0 裁剪删除——端点已不存在
（吊销能力仍在 auth 层，仅 HTTP 入口移除）。

隔离说明: conftest.py 已在导入期把 auth 的配置读写替换为内存 mock；
本文件额外为限流状态提供用例级清理，避免相互污染。
"""
import auth
import routers.auth_api as auth_api


# ============================================================
# BE-SEC-H1: query token 收敛 + 一次性 ticket
# ============================================================

class TestQueryTokenConvergence:
    """仅在白名单路径接受 query token；普通 API 忽略 query token"""

    def test_query_token_ignored_on_regular_api(self, client, auth_headers):
        """普通 API 带 ?token=<有效 token> 但无 Authorization 头 -> 401"""
        token = auth_headers["Authorization"].split(" ", 1)[1]
        resp = client.get(f"/api/screen/session/list?token={token}")
        assert resp.status_code == 401, resp.text

    def test_query_token_accepted_on_whitelisted_prefix(self, client, auth_headers):
        """白名单前缀(/api/vaudit/)接受 query token，不被中间件拦截"""
        token = auth_headers["Authorization"].split(" ", 1)[1]
        resp = client.get(f"/api/vaudit/days?token={token}")
        assert resp.status_code != 401, resp.text

    def test_ws_ticket_requires_auth(self, client):
        """POST /auth/ws-ticket 无 Bearer -> 401"""
        resp = client.post("/auth/ws-ticket")
        assert resp.status_code == 401, resp.text

    def test_ws_ticket_shape(self, client, auth_headers):
        """POST /auth/ws-ticket 返回 32 字节 hex 票据与 30 秒有效期"""
        resp = client.post("/auth/ws-ticket", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert len(data["ticket"]) == 64  # 32 字节 -> 64 hex 字符
        assert data["expires_in"] == 30

    def test_ticket_single_use_on_whitelisted_prefix(self, client, auth_headers):
        """ticket 首次可用、二次使用被拒(401)"""
        ticket = client.post("/auth/ws-ticket", headers=auth_headers).json()["ticket"]

        first = client.get(f"/api/vaudit/days?ticket={ticket}")
        assert first.status_code != 401, first.text

        second = client.get(f"/api/vaudit/days?ticket={ticket}")
        assert second.status_code == 401, second.text

    def test_expired_ticket_rejected(self, client, auth_headers):
        """过期 ticket -> 401"""
        ticket, _ = auth.create_ws_ticket("Axeuh")
        # 手动把过期时间拨到过去
        with auth._ws_ticket_lock:
            auth._ws_tickets[ticket]["expires_at"] = 0

        resp = client.get(f"/api/vaudit/days?ticket={ticket}")
        assert resp.status_code == 401, resp.text

    def test_main_ws_accepts_ticket(self, client, auth_headers):
        """主 WebSocket 支持 ?ticket= 一次性握手"""
        ticket = client.post("/auth/ws-ticket", headers=auth_headers).json()["ticket"]
        with client.websocket_connect(f"/ws?ticket={ticket}") as ws:
            first = ws.receive_json()
            assert first["type"] == "connected"

    def test_main_ws_ticket_single_use(self, client, auth_headers):
        """ticket 被 WS 消费后不可重复用于建立新连接"""
        from starlette.websockets import WebSocketDisconnect
        import pytest

        ticket = client.post("/auth/ws-ticket", headers=auth_headers).json()["ticket"]
        with client.websocket_connect(f"/ws?ticket={ticket}") as ws:
            assert ws.receive_json()["type"] == "connected"

        with pytest.raises(WebSocketDisconnect) as ei:
            with client.websocket_connect(f"/ws?ticket={ticket}"):
                pass
        assert ei.value.code == 1008


# ============================================================
# BE-SEC-H2/L1: /docs 前缀过宽修正
# ============================================================

class TestDocsPrefixHardening:
    """/docsfoo 等前缀不应被误判为公开路径"""

    def test_docs_prefix_not_public(self, client):
        """GET /docsfoo 不匹配 /docs 精确公开路径 -> 401"""
        resp = client.get("/docsfoo")
        assert resp.status_code == 401, resp.text

    def test_openapi_prefix_not_public(self, client):
        """GET /openapi-whatever 不再因 /openapi 前缀被放行 -> 401"""
        resp = client.get("/openapi-whatever")
        assert resp.status_code == 401, resp.text


# ============================================================
# BE-SEC-M1: 登录速率限制
# ============================================================

class TestLoginRateLimit:
    """登录失败计数与临时锁定"""

    @staticmethod
    def _reset():
        auth_api.reset_login_rate_limit()

    def setup_method(self):
        self._reset()

    def teardown_method(self):
        self._reset()

    def test_lockout_after_repeated_failures(self, client):
        """连续 5 次失败后第 6 次返回 429"""
        user = "ratelimit_probe_1"
        for _ in range(5):
            r = client.post("/login", json={"username": user, "password": "wrong"})
            assert r.status_code == 200, r.text
            assert r.json()["success"] is False

        r6 = client.post("/login", json={"username": user, "password": "wrong"})
        assert r6.status_code == 429, r6.text
        assert "秒" in r6.json()["message"]

    def test_success_resets_failure_counter(self, client):
        """成功登录清零失败计数，避免误锁定"""
        user = "Axeuh"
        for _ in range(4):
            client.post("/login", json={"username": user, "password": "wrong"})

        ok = client.post("/login", json={"username": user, "password": "test-password-123"})
        assert ok.status_code == 200 and ok.json()["success"] is True

        # 清零后再失败 5 次才会锁，前 5 次均为 200
        for _ in range(5):
            r = client.post("/login", json={"username": user, "password": "wrong"})
            assert r.status_code == 200, r.text

    def test_other_username_not_affected(self, client):
        """锁定按 IP:用户名 隔离，不影响其他用户名"""
        locked_user = "ratelimit_probe_2"
        for _ in range(6):
            client.post("/login", json={"username": locked_user, "password": "wrong"})

        other = client.post("/login", json={"username": "Axeuh", "password": "test-password-123"})
        assert other.status_code == 200 and other.json()["success"] is True
