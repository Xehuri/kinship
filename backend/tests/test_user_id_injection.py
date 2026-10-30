# -*- coding: utf-8 -*-
"""
H1 前置门禁：验证 health 路由的 user_id 确实由 AuthMiddleware 注入。

依据 health-data-source-architecture.md 风险 7：
  user_id 依赖中间件注入（auth_middleware.py:117）。若 request.state.user_id
  在 health 路由缺失，路由会退回 "default"，多用户隔离失效 —— H1 必须先验证，
  验证不通过则停止（不修改 auth 中间件或路由，H1 禁止行为变更）。

conftest.py 的 auth_headers fixture 通过 POST /login 登录用户 "Axeuh"，
故注入的 user_id 应等于 "Axeuh"。
"""


def test_health_query_injects_user_id(client, auth_headers, monkeypatch):
    """GET /api/health/query 应把认证用户名作为 user_id 传给 query_health_data。

    注意：routers/health.py 的 health_query 在函数体内执行
    ``from services.health_storage import query_health_data``，
    因此 monkeypatch 必须打在 services.health_storage.query_health_data 上
    （打 routers.health 模块属性对该局部导入无效）。
    """
    recorded = {}

    def recorder(date=None, user_id=None):
        # 记录路由层实际传给存储层的关键参数
        recorded["date"] = date
        recorded["user_id"] = user_id
        return {"status": "empty", "date": date, "message": "无数据"}

    monkeypatch.setattr(
        "services.health_storage.query_health_data", recorder
    )

    resp = client.get(
        "/api/health/query",
        params={"date": "2026-09-22"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, f"查询失败: {resp.status_code} {resp.text}"

    # 核心断言：user_id 是认证用户名，而非 "default" 回退值
    assert recorded.get("user_id") == "Axeuh", (
        f"期望 user_id='Axeuh'（auth_headers 登录的用户名），"
        f"实际为 {recorded.get('user_id')!r} —— 中间件未注入？"
    )
    assert recorded.get("user_id") is not None
    assert recorded.get("user_id") != "default"
    # 日期参数应原样透传
    assert recorded.get("date") == "2026-09-22"
