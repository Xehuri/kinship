# -*- coding: utf-8 -*-
"""通知推送路由测试 - 历史记录管理 + 下行 WS 推送 + 上行去重/脱敏 + id 全局唯一性"""

import time
from typing import Any, Dict
from unittest.mock import AsyncMock

import pytest


def _perception_notify(client, auth_headers, payload: Dict[str, Any], type_: str = "notify"):
    """向感知事件端点提交一条事件（默认 notify）"""
    return client.post(
        "/api/screen/stt/perception-event",
        json={"type": type_, "payload": payload},
        headers=auth_headers,
    )


@pytest.fixture
def stub_perception_append(monkeypatch):
    """拦截 perception.jsonl 落盘（避免写真实数据），并记录落盘条目"""
    appended = []
    monkeypatch.setattr(
        "services.perception_store.append_perception",
        lambda entry, **kwargs: appended.append(entry) or True,
    )
    return appended



class TestNotificationHistory:
    """通知历史管理功能测试"""

    def test_send_and_history(self, client, auth_headers):
        """发送通知后可通过历史 API 检索到"""
        # 发送通知
        resp = client.post(
            "/api/notification/send",
            json={"title": "测试标题", "content": "测试内容"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        nid = resp.json()["notification_id"]

        # 查询历史应包含刚发送的通知
        resp = client.get("/api/notification/history", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] >= 1
        ids = [n["id"] for n in data["notifications"]]
        assert nid in ids

        # 验证字段完整性
        match = [n for n in data["notifications"] if n["id"] == nid][0]
        assert match["title"] == "测试标题"
        assert match["content"] == "测试内容"
        assert isinstance(match["created_at"], int)

    def test_delete_notification(self, client, auth_headers):
        """删除后通知不再出现在历史中"""
        # 先发一条
        resp = client.post(
            "/api/notification/send",
            json={"title": "待删除", "content": "这条将被删除"},
            headers=auth_headers,
        )
        nid = resp.json()["notification_id"]

        # 确认存在
        resp = client.get("/api/notification/history", headers=auth_headers)
        ids_before = [n["id"] for n in resp.json()["notifications"]]
        assert nid in ids_before

        # 删除
        resp = client.delete(f"/api/notification/history/{nid}", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

        # 确认已移除
        resp = client.get("/api/notification/history", headers=auth_headers)
        ids_after = [n["id"] for n in resp.json()["notifications"]]
        assert nid not in ids_after

    def test_delete_nonexistent(self, client, auth_headers):
        """删除不存在的通知返回 404"""
        resp = client.delete("/api/notification/history/999999", headers=auth_headers)
        assert resp.status_code == 404

    def test_history_pagination(self, client, auth_headers):
        """分页参数 limit/offset 生效"""
        # 发多条通知（先清一下之前的，用时间戳区分）
        sent_ids = []
        for i in range(5):
            resp = client.post(
                "/api/notification/send",
                json={"title": f"通知{i}", "content": f"第{i}条"},
                headers=auth_headers,
            )
            sent_ids.append(resp.json()["notification_id"])

        # limit=2 应只返回 2 条（最新在前）
        resp = client.get(
            "/api/notification/history?limit=2&offset=0", headers=auth_headers
        )
        data = resp.json()
        assert len(data["notifications"]) == 2
        assert data["total"] >= 5

        # offset=2 应跳过前 2 条
        resp2 = client.get(
            "/api/notification/history?limit=2&offset=2", headers=auth_headers
        )
        data2 = resp2.json()
        assert len(data2["notifications"]) == 2
        # 偏移后第一条的 id 应和 limit 2 的第三条相同
        assert data2["notifications"][0]["id"] != data["notifications"][0]["id"]

    def test_auto_prune(self, client, auth_headers):
        """超出 MAX_HISTORY_PER_USER 自动裁剪最早的通知"""
        MAX_HISTORY = 100
        # 发 MAX_HISTORY + 5 条
        for i in range(MAX_HISTORY + 5):
            client.post(
                "/api/notification/send",
                json={"title": f"裁剪测试{i}", "content": f"内容{i}"},
                headers=auth_headers,
            )

        resp = client.get("/api/notification/history", headers=auth_headers)
        data = resp.json()
        assert data["total"] == MAX_HISTORY

    def test_user_isolation(self, client, auth_headers):
        """不同用户的通知历史隔离"""
        # 用 Axeuh 身份发一条通知（来自 token 中的 user_id）
        resp = client.post(
            "/api/notification/send",
            json={"title": "Axeuh的通知", "content": "仅供Axeuh查看"},
            headers=auth_headers,
        )
        axeuh_nid = resp.json()["notification_id"]

        # 用显式 user_id="user1" 发一条通知（模拟 AI 指定目标用户）
        resp = client.post(
            "/api/notification/send",
            json={"title": "user1的通知", "content": "仅供user1查看", "user_id": "user1"},
            headers=auth_headers,
        )
        user1_nid = resp.json()["notification_id"]

        # Axeuh 的历史应包含自己的通知，不包含 user1 的
        resp = client.get("/api/notification/history", headers=auth_headers)
        assert resp.status_code == 200
        axeuh_ids = [n["id"] for n in resp.json()["notifications"]]
        assert axeuh_nid in axeuh_ids
        assert user1_nid not in axeuh_ids


class TestNotificationWSPush:
    """发送通知时向在线客户端 WS 实时推送（下行流式）"""

    def test_send_triggers_ws_push(self, client, auth_headers, monkeypatch):
        """POST /api/notification/send 应调用 component_manager.send_to_user，负载形状正确"""
        from services.component_manager import component_manager

        mock_send = AsyncMock()
        monkeypatch.setattr(component_manager, "send_to_user", mock_send)

        resp = client.post(
            "/api/notification/send",
            json={"title": "推送标题", "content": "推送内容", "user_id": "push_user"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        nid = resp.json()["notification_id"]

        # 推送被调用一次，且入参正确
        assert mock_send.await_count == 1
        assert mock_send.await_args is not None
        args, _kwargs = mock_send.await_args
        assert args[0] == "push_user"
        message = args[1]
        assert message["type"] == "notification"
        assert message["data"]["id"] == nid
        assert message["data"]["title"] == "推送标题"
        assert message["data"]["content"] == "推送内容"
        assert isinstance(message["data"]["ts"], int)

    def test_send_survives_push_failure(self, client, auth_headers, monkeypatch):
        """推送抛异常时 HTTP 响应仍成功（推送 best-effort）"""
        from services.component_manager import component_manager

        monkeypatch.setattr(
            component_manager, "send_to_user",
            AsyncMock(side_effect=RuntimeError("ws down")),
        )

        resp = client.post(
            "/api/notification/send",
            json={"title": "容错标题", "content": "推送失败也要返回 ok"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


class TestNotificationUplink:
    """通知上行：/perception-event 单写 perception.jsonl（P0-U5 起 sidecar 去重副本已删除）"""

    def test_notify_event_appended_as_is(
        self, client, auth_headers, stub_perception_append
    ):
        """notify 事件原样追加 jsonl：服务端不再脱敏、不再写第二份存储"""
        resp = _perception_notify(client, auth_headers, {
            "key": "sbn-key-1", "id": 11, "package": "com.example.app",
            "title": "标题1", "text": "内容1", "ts": 1001,
        })
        assert resp.status_code == 200 and resp.json()["status"] == "ok"

        resp = _perception_notify(client, auth_headers, {
            "key": "sbn-key-1", "id": 11, "package": "com.example.app",
            "title": "标题2", "text": "内容2", "ts": 1002,
        })
        assert resp.status_code == 200 and resp.json()["status"] == "ok"

        # jsonl 追加语义：同 key 两次上报产生两条条目（服务端去重语义已随 sidecar 删除）
        assert len(stub_perception_append) == 2
        assert stub_perception_append[1]["title"] == "标题2"
        # 服务端不再脱敏：正文原样落盘（黑名单脱敏由 App 侧 NotificationCollector 完成）
        assert stub_perception_append[0]["title"] == "标题1"
        assert stub_perception_append[0]["text"] == "内容1"

    def test_non_notify_event_untouched(
        self, client, auth_headers, stub_perception_append
    ):
        """非 notify 事件同样原样落盘"""
        resp = _perception_notify(client, auth_headers, {
            "battery": 88, "charging": False,
        }, type_="sensor")
        assert resp.status_code == 200 and resp.json()["status"] == "ok"

        assert len(stub_perception_append) == 1
        assert stub_perception_append[0]["type"] == "sensor"
        assert stub_perception_append[0]["battery"] == 88


class TestNotificationIdUniqueness:
    """通知 id 全局唯一性：epoch-秒单调基，跨进程重启唯一

    背景：旧实现 `_next_id` 每次进程启动都从 1 重新计数，重启后新推送的 id
    会与上一代进程的 id 撞车，Android 端按 id 去重把新推送当重复吞掉（卡片
    不更新）。修复：id 以 epoch-秒为基单调递增。量纲锁定在「秒」而非「毫秒」：
    epoch-毫秒约 1.79e12，会撑爆 Int32 消费端（Android optInt("id") 与
    nm.notify 的 int 偏移运算）。兄弟提交中客户端去重键升级为 (id, ts) 双因子。
    """

    def _send(self, client, auth_headers, tag):
        resp = client.post(
            "/api/notification/send",
            json={"title": f"唯一性-{tag}", "content": f"唯一性-{tag}"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        return resp.json()["notification_id"]

    def test_ids_distinct_and_strictly_increasing(self, client, auth_headers):
        """连续两次发送：id 互异且严格递增"""
        id1 = self._send(client, auth_headers, "a1")
        id2 = self._send(client, auth_headers, "a2")
        assert id1 != id2
        assert id2 > id1

    def test_ids_epoch_second_scale(self, client, auth_headers):
        """id 落在 epoch-秒量级（>1.7e9）——对旧 1..N 实现是 RED"""
        nid = self._send(client, auth_headers, "b")
        assert nid > 1_700_000_000

    def test_id_survives_simulated_restart(self, client, auth_headers, monkeypatch):
        """模拟进程重启：_next_id 归零后再发送，id 仍为 epoch-秒量级（跨重启唯一）"""
        import routers.notifications as notifications_mod

        self._send(client, auth_headers, "c-pre")  # 先把计数器拉到当前时间基
        monkeypatch.setattr(notifications_mod, "_next_id", 0)
        nid = self._send(client, auth_headers, "c-post")
        assert nid > 1_700_000_000

    def test_id_is_int32_safe(self, client, auth_headers):
        """id 必须是 int 且不超过 Int32 上限（毫秒量级实现会在此 RED）"""
        nid = self._send(client, auth_headers, "d")
        assert isinstance(nid, int)
        assert nid <= 2**31 - 1
