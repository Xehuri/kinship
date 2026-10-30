from __future__ import annotations

from services.qq_gateway.config import QQGatewayConfig
from services.qq_gateway.router import EventRouter


def _router(**inbound: object) -> EventRouter:
    raw = {
        "account": {"self_qq": "100", "peer_allowlist": ["200"]},
        "inbound": {"groups": False, "require_at": True, **inbound},
    }
    return EventRouter(QQGatewayConfig.from_dict(raw))


def test_private_allowed_and_deduped() -> None:
    router = _router()
    event = {
        "post_type": "message", "message_type": "private", "self_id": 100,
        "message_id": 7, "sender": {"user_id": 200}, "message": [{"type": "text", "data": {"text": "hi"}}],
    }
    decision = router.classify(event)
    assert decision.kind == "message"
    assert decision.chat_type == "private"
    assert decision.target == "200"
    assert decision.deliver is True
    assert decision.dedupe_key == "msg:100:private:200:7"


def test_self_and_stranger_are_ignored() -> None:
    router = _router()
    self_event = {
        "post_type": "message", "message_type": "private", "self_id": 100,
        "message_id": 1, "sender": {"user_id": 100}, "message": [],
    }
    stranger = {
        "post_type": "message", "message_type": "private", "self_id": 100,
        "message_id": 2, "sender": {"user_id": 999}, "message": [],
    }
    assert router.classify(self_event).reason == "self_message"
    assert router.classify(stranger).reason == "peer_not_allowed"


def test_group_requires_at_and_allowlist() -> None:
    router = _router(groups=True, group_allowlist=["300"])
    base = {
        "post_type": "message", "message_type": "group", "self_id": 100,
        "group_id": 300, "message_id": 3, "sender": {"user_id": 200},
        "message": [{"type": "text", "data": {"text": "hi"}}],
    }
    assert router.classify(base).reason == "group_not_mentioned"
    base["message"] = [{"type": "at", "data": {"qq": "100"}}, {"type": "text", "data": {"text": " hi"}}]
    decision = router.classify(base)
    assert decision.kind == "message"
    assert decision.target == "300"
    assert decision.deliver is True


def test_notice_and_request() -> None:
    router = _router(groups=True)
    notice = {
        "post_type": "notice", "notice_type": "group_recall",
        "group_id": 300, "user_id": 200, "message_id": 9, "time": 10,
    }
    request = {
        "post_type": "request", "request_type": "friend", "flag": "f1", "user_id": 200,
    }
    notice_decision = router.classify(notice)
    request_decision = router.classify(request)
    assert notice_decision.kind == "notice"
    assert notice_decision.deliver is True
    assert request_decision.kind == "request"
    assert request_decision.dedupe_key == "request:friend:f1"


def test_meta_is_not_delivered() -> None:
    router = _router()
    decision = router.classify({"post_type": "meta_event", "meta_event_type": "heartbeat"})
    assert decision.kind == "meta"
    assert decision.deliver is False


def test_group_request_requires_group_policy() -> None:
    router = _router()
    decision = router.classify({
        "post_type": "request", "request_type": "group", "flag": "g1",
        "group_id": 300, "user_id": 200,
    })
    assert decision.kind == "ignore"
    assert decision.reason == "request_group_disabled"
