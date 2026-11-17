"""QQ 网关 CLI：把后端的 QQ 网关 MCP 工具包成 shell 命令。

依赖后端仓库的 `backend/services/qq_mcp_server.py`；默认按本文件位置推出项目根，
再取项目根下的 `backend/`。AI 目录不在项目根下时用环境变量覆盖：

    QQ_CLI_BACKEND                  backend 目录绝对路径
    QQ_GATEWAY_MCP_BASE_URL         网关 IPC 地址（默认 http://127.0.0.1:8770）
    QQ_GATEWAY_MCP_TOKEN_FILE       网关 token 文件（默认 /etc/qq-gateway/mcp.token）

只保留通用逻辑：命令、参数校验、输出格式化。目标群号/QQ 号一律由调用方传入。
"""

from __future__ import annotations


import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, Sequence

_BACKEND_ENV = os.environ.get("QQ_CLI_BACKEND", "").strip()
BACKEND = (
    Path(_BACKEND_ENV)
    if _BACKEND_ENV
    else Path(__file__).absolute().parents[3] / "backend"
)
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

os.environ.setdefault("QQ_GATEWAY_MCP_TOKEN_FILE", "/etc/qq-gateway/mcp.token")
os.environ.setdefault("QQ_GATEWAY_MCP_BASE_URL", "http://127.0.0.1:8770")

_TOOL_MODELS = {
    "qq_send_message": "SendMessageInput",
    "qq_get_friends": "GetFriendsInput",
    "qq_search_friend": "SearchFriendInput",
    "qq_send_file": "SendFileInput",
    "qq_get_group_msg_history": "GetGroupMsgHistoryInput",
    "qq_get_login_info": "GetLoginInfoInput",
    "qq_send_poke": "SendPokeInput",
    "qq_get_file": "GetFileInput",
    "qq_get_forward_msg": "GetForwardMsgInput",
    "qq_set_msg_emoji_like": "EmojiLikeInput",
    "qq_get_msg": "GetMsgInput",
    "qq_get_friend_msg_history": "FriendMsgHistoryInput",
    "qq_list_stickers": "ListStickersInput",
    "qq_send_sticker": "SendStickerInput",
    "qq_save_sticker": "SaveStickerInput",
    "qq_update_sticker": "UpdateStickerInput",
    "qq_delete_sticker": "DeleteStickerInput",
    "qq_get_qzone_feeds": "GetQZoneFeedsInput",
    "qq_get_qzone_comments": "GetQZoneCommentsInput",
    "qq_comment_qzone": "CommentQZoneInput",
    "qq_reply_qzone_comment": "ReplyQZoneCommentInput",
    "qq_delete_qzone_comment": "DeleteQZoneCommentInput",
    "qq_like_qzone": "LikeQZoneInput",
}


def _mcp_module():
    from services import qq_mcp_server

    return qq_mcp_server


def _tool_registry() -> dict[str, tuple[Any, Any]]:
    module = _mcp_module()
    return {
        name: (getattr(module, name), getattr(module, model_name))
        for name, model_name in _TOOL_MODELS.items()
    }


def _bounded_int(low: int, high: int) -> Callable[[str], int]:
    def parse(value: str) -> int:
        try:
            number = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(f"invalid int value: {value!r}") from exc
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(
                f"value must be between {low} and {high}: {number}"
            )
        return number

    return parse


def _bounded_float(low: float, high: float) -> Callable[[str], float]:
    def parse(value: str) -> float:
        try:
            number = float(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(f"invalid float value: {value!r}") from exc
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(
                f"value must be between {low} and {high}: {number}"
            )
        return number

    return parse


_DURATION_UNITS = {"s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}


def _parse_duration(value: str) -> float:
    text = value.strip().lower()
    if len(text) < 2 or text[-1] not in _DURATION_UNITS:
        raise ValueError(f"invalid duration: {value!r} (use e.g. 30s, 5m, 2h, 1d)")
    try:
        number = float(text[:-1])
    except ValueError as exc:
        raise ValueError(f"invalid duration: {value!r}") from exc
    if number < 0:
        raise ValueError(f"duration must not be negative: {value!r}")
    return number * _DURATION_UNITS[text[-1]]


def _add_target(parser: argparse.ArgumentParser) -> None:
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--group", metavar="ID", help="Group id.")
    target.add_argument("--friend", metavar="ID", help="Friend user id.")


def _add_format(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="qq", description="Query and act on the deployment's QQ gateway from the shell."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    history = sub.add_parser("history", help="Fetch group or friend message history.")
    _add_target(history)
    history.add_argument(
        "--unread", action="store_true", help="Only messages newer than the watermark."
    )
    history.add_argument("--compact", action="store_true", help="One line per message.")
    history.add_argument(
        "--mark-read", action="store_true", help="Advance the read watermark."
    )
    history.add_argument("--count", type=_bounded_int(1, 100), default=50)
    history.add_argument("--since-minutes", type=_bounded_int(1, 10080), default=None)
    _add_format(history)
    history.add_argument("--json", action="store_true", help="Shortcut for --format json.")

    tools = sub.add_parser("tools", help="List all QQ operations and their fields.")
    tools.add_argument("--json", action="store_true", help="Machine-readable output.")

    call = sub.add_parser("call", help="Call one QQ operation with a JSON params object.")
    call.add_argument("tool", help="Operation name, e.g. qq_send_poke.")
    call.add_argument(
        "--input", required=True, metavar="JSON", help='JSON object, or "-" for stdin.'
    )
    _add_format(call)

    send = sub.add_parser("send", help="Send a text or segment message.")
    _add_target(send)
    message = send.add_mutually_exclusive_group(required=True)
    message.add_argument("--text", help="Plain text message.")
    message.add_argument(
        "--input", metavar="JSON", help='JSON message array/object, or "-" for stdin.'
    )
    send.add_argument("--auto-escape", action="store_true")
    send.add_argument("--delay", type=float, default=0.0)
    _add_format(send)

    send_file = sub.add_parser("send-file", help="Send a local file.")
    _add_target(send_file)
    send_file.add_argument("--file", required=True, dest="file_path")
    send_file.add_argument("--name", dest="custom_name")
    send_file.add_argument(
        "--no-base64", action="store_false", dest="base64", help="Do not use base64 upload."
    )
    send_file.set_defaults(base64=True)
    _add_format(send_file)

    water = sub.add_parser("water", help="Manage per-group reminder (water) state.")
    water_sub = water.add_subparsers(dest="water_action", required=True)

    water_on = water_sub.add_parser("on", help="Enable score-based auto reminders.")
    water_on.add_argument("--group", required=True, metavar="ID", help="Group id.")
    water_on.add_argument(
        "--ttl", default="30m", metavar="DURATION", help="How long to stay on, e.g. 30m."
    )
    water_on.add_argument(
        "--threshold", type=_bounded_float(0.0, 100.0), default=12.0, help="Score threshold."
    )

    water_off = water_sub.add_parser("off", help="Restore mentions-only reminders.")
    water_off.add_argument("--group", required=True, metavar="ID", help="Group id.")

    water_mute = water_sub.add_parser("mute", help="Disable all reminders.")
    water_mute.add_argument("--group", required=True, metavar="ID", help="Group id.")

    water_status = water_sub.add_parser("status", help="Show one group's reminder state.")
    water_status.add_argument("--group", required=True, metavar="ID", help="Group id.")
    water_status.add_argument("--json", action="store_true", help="Machine-readable output.")

    water_list = water_sub.add_parser("list", help="List all group reminder states.")
    water_list.add_argument("--json", action="store_true", help="Machine-readable output.")

    return parser


def _read_json_input(value: str) -> Any:
    raw = sys.stdin.read() if value == "-" else value
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON input: {exc}") from exc


def _format_value(args: argparse.Namespace) -> str:
    return "json" if getattr(args, "format", "markdown") == "json" else "markdown"


async def _run_history(args: argparse.Namespace) -> str:
    module = _mcp_module()
    response_format = (
        module.ResponseFormat.JSON
        if args.format == "json" or args.json
        else module.ResponseFormat.MARKDOWN
    )
    if args.group:
        params = module.GetGroupMsgHistoryInput(
            group_id=args.group,
            count=args.count,
            unread_only=args.unread,
            mark_read=args.mark_read,
            since_minutes=args.since_minutes,
            compact=args.compact,
            response_format=response_format,
        )
        return await module.qq_get_group_msg_history(params)
    params = module.FriendMsgHistoryInput(
        user_id=args.friend,
        count=args.count,
        unread_only=args.unread,
        mark_read=args.mark_read,
        since_minutes=args.since_minutes,
        compact=args.compact,
        response_format=response_format,
    )
    return await module.qq_get_friend_msg_history(params)


def _message_from_args(args: argparse.Namespace) -> str:
    if args.text is not None:
        return args.text
    payload = _read_json_input(args.input)
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, ensure_ascii=False)


async def _run_send(args: argparse.Namespace) -> str:
    module = _mcp_module()
    params = module.SendMessageInput(
        message_type=module.MessageType.GROUP if args.group else module.MessageType.PRIVATE,
        target_id=args.group or args.friend,
        message=_message_from_args(args),
        auto_escape=args.auto_escape,
        delay_seconds=args.delay,
        response_format=_format_value(args),
    )
    return await module.qq_send_message(params)


async def _run_send_file(args: argparse.Namespace) -> str:
    module = _mcp_module()
    params = module.SendFileInput(
        message_type=module.MessageType.GROUP if args.group else module.MessageType.PRIVATE,
        target_id=args.group or args.friend,
        file_path=args.file_path,
        custom_name=args.custom_name,
        use_base64=args.base64,
        response_format=_format_value(args),
    )
    return await module.qq_send_file(params)


def _format_water_state(state: dict[str, Any]) -> str:
    return (
        f"群 {state.get('group_id')}: mode={state.get('mode')}"
        f" threshold={state.get('threshold')}"
        f" water_until={int(state.get('water_until') or 0)}"
        f" last_wake_at={int(state.get('last_wake_at') or 0)}"
    )


async def _run_water(args: argparse.Namespace) -> str:
    gateway = _mcp_module().client
    action = args.water_action
    if action == "on":
        body = {
            "group_id": args.group,
            "mode": "water",
            "threshold": args.threshold,
            "water_until": time.time() + _parse_duration(args.ttl),
        }
        data = await gateway.post("/v1/water-state", body)
    elif action == "off":
        data = await gateway.post(
            "/v1/water-state",
            {"group_id": args.group, "mode": "mentions", "water_until": 0},
        )
    elif action == "mute":
        data = await gateway.post(
            "/v1/water-state", {"group_id": args.group, "mode": "mute"}
        )
    elif action == "status":
        data = await gateway.get("/v1/water-state", {"group_id": args.group})
    elif action == "list":
        data = await gateway.get("/v1/water-state")
    else:
        raise ValueError("unknown water action: " + str(action))
    if getattr(args, "json", False):
        return json.dumps(data, ensure_ascii=False, indent=2)
    states = data if isinstance(data, list) else [data]
    if not states:
        return "(no water states)"
    return "\n".join(_format_water_state(state) for state in states)


async def _run_call(args: argparse.Namespace) -> str:
    registry = _tool_registry()
    entry = registry.get(args.tool)
    if entry is None:
        raise ValueError("unknown tool: " + args.tool + "; run `qq tools`")
    func, model = entry
    payload = _read_json_input(args.input)
    if not isinstance(payload, dict):
        raise ValueError("--input must be a JSON object")
    if "response_format" in model.model_fields:
        payload.setdefault("response_format", _format_value(args))
    try:
        params = model(**payload)
    except Exception as exc:
        raise ValueError(f"invalid params for {args.tool}: {exc}") from exc
    return await func(params)


def _run_tools(args: argparse.Namespace) -> str:
    registry = _tool_registry()
    if args.json:
        return json.dumps(
            {name: list(model.model_fields) for name, (_, model) in registry.items()},
            ensure_ascii=False,
            indent=2,
        )
    return "\n".join(
        name + "\t" + ", ".join(model.model_fields)
        for name, (_, model) in registry.items()
    )


async def _run(args: argparse.Namespace) -> str:
    if args.command == "history":
        return await _run_history(args)
    if args.command == "tools":
        return _run_tools(args)
    if args.command == "call":
        return await _run_call(args)
    if args.command == "send":
        return await _run_send(args)
    if args.command == "send-file":
        return await _run_send_file(args)
    if args.command == "water":
        return await _run_water(args)
    raise ValueError("unknown command: " + str(args.command))


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        output = asyncio.run(_run(args))
    except Exception as exc:
        print(f"qq: {exc}", file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
