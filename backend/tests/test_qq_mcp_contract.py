from __future__ import annotations

import asyncio
from typing import Any, Optional

from services import qq_mcp_server


def _params_schema(tool: Any) -> dict[str, Any]:
    schema = tool.inputSchema or {}
    params = schema["properties"]["params"]
    if "$ref" in params:
        ref = params["$ref"].split("/")[-1]
        params = schema["$defs"][ref]
    return params


def _string_pattern(prop: dict[str, Any]) -> Optional[str]:
    if "pattern" in prop:
        return prop["pattern"]
    for variant in prop.get("anyOf", []):
        if "pattern" in variant:
            return variant["pattern"]
    return None


def test_mcp_tool_contract_keeps_params_wrapper() -> None:
    async def scenario() -> None:
        tools = await qq_mcp_server.mcp.list_tools()
        names = {tool.name for tool in tools}
        expected = {
            "qq_send_message", "qq_get_friends", "qq_search_friend", "qq_send_file",
            "qq_get_group_msg_history", "qq_get_login_info", "qq_send_poke", "qq_get_file",
            "qq_get_forward_msg", "qq_set_msg_emoji_like", "qq_get_msg",
            "qq_get_friend_msg_history", "qq_list_stickers", "qq_send_sticker",
            "qq_save_sticker", "qq_update_sticker", "qq_delete_sticker",
            "qq_get_qzone_feeds", "qq_get_qzone_comments", "qq_comment_qzone",
            "qq_reply_qzone_comment", "qq_delete_qzone_comment", "qq_like_qzone",
        }
        assert names == expected
        for tool in tools:
            schema = tool.inputSchema or {}
            assert list((schema.get("properties") or {}).keys()) == ["params"]

        by_name = {tool.name: tool for tool in tools}
        send_params = _params_schema(by_name["qq_send_message"])
        assert "delay_seconds" in send_params.get("properties", {})
        save_params = _params_schema(by_name["qq_save_sticker"])
        assert {"note", "usage"} <= set(save_params.get("properties", {}))

        group_history = _params_schema(by_name["qq_get_group_msg_history"]).get("properties", {})
        friend_history = _params_schema(by_name["qq_get_friend_msg_history"]).get("properties", {})
        assert "compact" in group_history
        assert "compact" in friend_history
        for history in (group_history, friend_history):
            assert {"unread_only", "mark_read", "count_only", "since_minutes"} <= set(history)

        feeds = _params_schema(by_name["qq_get_qzone_feeds"]).get("properties", {})
        assert {"target_qq", "limit"} <= set(feeds)
        comments = _params_schema(by_name["qq_get_qzone_comments"]).get("properties", {})
        assert {"target_qq", "tid", "scan"} <= set(comments)
        comment = _params_schema(by_name["qq_comment_qzone"]).get("properties", {})
        assert {"target_qq", "tid", "content"} <= set(comment)
        reply = _params_schema(by_name["qq_reply_qzone_comment"]).get("properties", {})
        assert {
            "target_qq", "tid", "comment_id", "content", "comment_uin", "comment_nick",
        } <= set(reply)
        delete = _params_schema(by_name["qq_delete_qzone_comment"]).get("properties", {})
        assert {"target_qq", "tid", "comment_id", "comment_uin"} <= set(delete)
        like = _params_schema(by_name["qq_like_qzone"]).get("properties", {})
        assert {"target_qq", "tid"} <= set(like)
        assert _string_pattern(feeds["target_qq"]) == r"^\d{5,20}$"
        assert _string_pattern(reply["comment_uin"]) == r"^\d{5,20}$"
        assert _string_pattern(delete["target_qq"]) == r"^\d{5,20}$"
        assert _string_pattern(delete["comment_uin"]) == r"^\d{5,20}$"

    asyncio.run(scenario())
