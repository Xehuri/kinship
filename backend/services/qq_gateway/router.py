from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .config import QQGatewayConfig


@dataclass(frozen=True)
class RouteDecision:
    kind: str
    chat_type: str
    target: str
    message_id: str
    dedupe_key: str
    deliver: bool
    reason: str


class EventRouter:
    def __init__(self, config: QQGatewayConfig) -> None:
        self.config = config

    def classify(self, event: dict[str, Any]) -> RouteDecision:
        post_type = str(event.get("post_type") or "")
        if post_type == "message":
            return self._message(event)
        if post_type == "message_sent":
            return self._message_sent(event)
        if post_type == "notice":
            return self._notice(event)
        if post_type == "request":
            return self._request(event)
        if post_type == "meta_event":
            return self._meta(event)
        return self._ignore("unknown_post_type")

    def _message(self, event: dict[str, Any]) -> RouteDecision:
        account = self.config.account.self_qq
        self_id = str(event.get("self_id") or account)
        sender = event.get("sender") or {}
        user_id = str(sender.get("user_id") or event.get("user_id") or "")
        message_type = str(event.get("message_type") or "")
        message_id = str(event.get("message_id") or "")
        if user_id == self_id and not self.config.inbound.self_messages:
            return self._ignore("self_message")
        if message_type == "private":
            if not self.config.inbound.private:
                return self._ignore("private_disabled")
            target = user_id
            allowlist = self.config.account.peer_allowlist
            if allowlist and target not in allowlist:
                return self._ignore("peer_not_allowed")
            return RouteDecision(
                kind="message",
                chat_type="private",
                target=target,
                message_id=message_id,
                dedupe_key=f"msg:{self_id}:private:{target}:{message_id}",
                deliver=self.config.inbound.enabled and self.config.inbound.deliver,
                reason="private",
            )
        if message_type == "group":
            if not self.config.inbound.groups:
                return self._ignore("group_disabled")
            target = str(event.get("group_id") or "")
            allowlist = self.config.inbound.group_allowlist
            if allowlist and target not in allowlist:
                return self._ignore("group_not_allowed")
            if self.config.inbound.require_at and not self._mentions_self(event, self_id):
                return self._ignore("group_not_mentioned")
            return RouteDecision(
                kind="message",
                chat_type="group",
                target=target,
                message_id=message_id,
                dedupe_key=f"msg:{self_id}:group:{target}:{message_id}",
                deliver=self.config.inbound.enabled and self.config.inbound.deliver,
                reason="group",
            )
        return self._ignore("unsupported_message_type")

    def _message_sent(self, event: dict[str, Any]) -> RouteDecision:
        self_id = str(event.get("self_id") or self.config.account.self_qq)
        message_type = str(event.get("message_type") or "")
        target = str(event.get("target_id") or event.get("group_id") or event.get("user_id") or "")
        message_id = str(event.get("message_id") or "")
        return RouteDecision(
            kind="message_sent",
            chat_type=message_type or "unknown",
            target=target,
            message_id=message_id,
            dedupe_key=f"sent:{self_id}:{message_type}:{target}:{message_id}",
            deliver=False,
            reason="self_sent",
        )

    def _notice(self, event: dict[str, Any]) -> RouteDecision:
        notice_type = str(event.get("notice_type") or "")
        sub_type = str(event.get("sub_type") or "")
        group_id = str(event.get("group_id") or "")
        user_id = str(event.get("user_id") or "")
        target = group_id or user_id
        if group_id and not self.config.inbound.groups:
            return self._ignore("notice_group_disabled")
        if group_id and self.config.inbound.group_allowlist and group_id not in self.config.inbound.group_allowlist:
            return self._ignore("notice_group_not_allowed")
        fingerprint = ":".join([
            notice_type, sub_type, group_id, user_id,
            str(event.get("message_id") or ""), str(event.get("time") or ""),
        ])
        return RouteDecision(
            kind="notice",
            chat_type="group" if group_id else "private",
            target=target,
            message_id=str(event.get("message_id") or ""),
            dedupe_key=f"notice:{fingerprint}",
            deliver=bool(self.config.inbound.enabled and self.config.inbound.deliver
                         and self.config.inbound.notices),
            reason=f"notice:{notice_type}",
        )

    def _request(self, event: dict[str, Any]) -> RouteDecision:
        request_type = str(event.get("request_type") or "")
        flag = str(event.get("flag") or "")
        group_id = str(event.get("group_id") or "")
        user_id = str(event.get("user_id") or "")
        target = group_id or user_id
        if group_id:
            if not self.config.inbound.groups:
                return self._ignore("request_group_disabled")
            if self.config.inbound.group_allowlist and group_id not in self.config.inbound.group_allowlist:
                return self._ignore("request_group_not_allowed")
        elif self.config.account.peer_allowlist and user_id not in self.config.account.peer_allowlist:
            return self._ignore("request_peer_not_allowed")
        return RouteDecision(
            kind="request",
            chat_type="group" if group_id else "private",
            target=target,
            message_id=flag,
            dedupe_key=f"request:{request_type}:{flag}",
            deliver=bool(self.config.inbound.enabled and self.config.inbound.deliver
                         and self.config.inbound.requests),
            reason=f"request:{request_type}",
        )

    def _meta(self, event: dict[str, Any]) -> RouteDecision:
        meta_type = str(event.get("meta_event_type") or "")
        return RouteDecision(
            kind="meta",
            chat_type="meta",
            target="",
            message_id="",
            dedupe_key="",
            deliver=False,
            reason=f"meta:{meta_type}",
        )

    def _ignore(self, reason: str) -> RouteDecision:
        return RouteDecision(
            kind="ignore",
            chat_type="",
            target="",
            message_id="",
            dedupe_key="",
            deliver=False,
            reason=reason,
        )

    @staticmethod
    def _mentions_self(event: dict[str, Any], self_id: str) -> bool:
        segments = event.get("message")
        if not isinstance(segments, list):
            return False
        for segment in segments:
            if not isinstance(segment, dict) or segment.get("type") != "at":
                continue
            data = segment.get("data") or {}
            if str(data.get("qq")) == self_id:
                return True
        return False
