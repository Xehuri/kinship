# -*- coding: utf-8 -*-
"""公开 /health 的服务标识基线。

GET /health 是免认证公开路径，其 service 字段对外暴露服务名。
本测试锁定服务名为 kinship-health-monitor，防止重命名回归。
"""


def test_health_service_name(client):
    """GET /health 应返回 200 且 service 为 kinship-health-monitor"""
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["service"] == "kinship-health-monitor"
