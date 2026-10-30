from __future__ import annotations

from typing import Any, Awaitable, Callable, Optional

MediaResolver = Callable[[dict[str, Any], int], Awaitable[Optional[str]]]
ForwardResolver = Callable[[dict[str, Any]], Awaitable[Optional[str]]]


def segment_text(data: Any, fallback: str) -> str:
    if isinstance(data, dict):
        value = str(data.get("summary") or data.get("text") or "").strip()
        if value:
            return value
    return fallback


async def render_segments(
    segments: Any,
    media: Optional[MediaResolver] = None,
    forward: Optional[ForwardResolver] = None,
) -> str:
    if not isinstance(segments, list):
        return ""
    out: list[str] = []
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            continue
        seg_type = str(segment.get("type") or "")
        data = segment.get("data") or {}
        if seg_type == "text":
            out.append(str(data.get("text", "")))
        elif seg_type == "at":
            qq = data.get("qq")
            out.append("@全体成员" if qq == "all" else "@" + str(qq))
        elif seg_type == "image":
            path = await media(segment, index) if media else None
            label = segment_text(data, "[图片]")
            out.append(label + " " + path if path else label)
        elif seg_type in ("face", "mface", "marketface"):
            out.append(segment_text(data, "[表情]"))
        elif seg_type == "file":
            name = str(data.get("name") or data.get("file") or "")
            path = await media(segment, index) if media else None
            out.append("[文件:" + name + "] " + path if path else "[文件:" + name + "]")
        elif seg_type == "onlinefile":
            name = str(data.get("fileName") or "文件")
            size = str(data.get("fileSize") or "")
            out.append("[在线文件:" + name + ("," + size + "B" if size else "") + "]")
        elif seg_type == "flashtransfer":
            out.append("[QQ闪传:" + str(data.get("fileSetId") or "") + "]")
        elif seg_type == "record":
            out.append("[语音]")
        elif seg_type == "video":
            out.append("[视频]")
        elif seg_type == "reply":
            out.append("[引用]")
        elif seg_type in ("json", "xml"):
            out.append("[卡片]")
        elif seg_type == "forward":
            rendered = await forward(segment) if forward else None
            out.append(rendered or "[合并转发]")
        elif seg_type == "poke":
            out.append("[戳一戳]")
        else:
            out.append("[" + seg_type + "]")
    return "".join(out).strip()
