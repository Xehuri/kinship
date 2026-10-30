from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Any, Optional

from .actions import ActionError, ActionService
from .media import MediaFetcher
from .store import EventStore


def _file_md5(path: str) -> str:
    digest = hashlib.md5()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


class StickerService:
    def __init__(self, actions: ActionService, media: MediaFetcher,
                 store: Optional[EventStore] = None) -> None:
        self.actions = actions
        self.media = media
        self.store = store

    async def list(self, count: int = 48) -> list[dict[str, Any]]:
        data = await self.actions.call(
            "fetch_custom_face_detail",
            {"count": max(1, min(200, int(count)))},
        )
        if isinstance(data, list):
            raw_items = data
        elif isinstance(data, dict):
            raw_items = data.get("emojiInfoList") or data.get("emoji_info_list") or []
        else:
            raw_items = []
        items = [self._normalize(item) for item in raw_items if isinstance(item, dict)]
        if self.store is not None:
            meta = await self.store.all_sticker_meta()
            for item in items:
                entry = meta.get(item["res_id"]) or meta.get(item["md5"]) or {}
                item["note"] = entry.get("note") or item["name"]
                item["usage"] = entry.get("usage") or ""
        else:
            for item in items:
                item["note"] = item["name"]
                item["usage"] = ""
        return items

    @staticmethod
    def _normalize(item: dict[str, Any]) -> dict[str, Any]:
        return {
            "res_id": str(item.get("resId") or ""),
            "emoji_id": str(item.get("eId") or item.get("emoId") or ""),
            "emo_id": item.get("emoId") or 0,
            "package_id": str(item.get("epId") or ""),
            "md5": str(item.get("md5") or ""),
            "name": str(item.get("desc") or ""),
            "url": str(item.get("url") or ""),
            "path": str(item.get("emoOriginalPath") or item.get("emoPath") or ""),
            "is_mark_face": bool(item.get("isMarkFace")),
            "is_apng": bool(item.get("isAPNG")),
        }

    async def send(self, message_type: str, target_id: str,
                   res_id: Optional[str] = None,
                   source_message_id: Optional[str] = None,
                   file_path: Optional[str] = None) -> Any:
        segment = await self._resolve_segment(res_id, source_message_id, file_path)
        return await self.actions.send_message(message_type, target_id, [segment])

    async def save(self, source_message_id: Optional[str] = None,                   file_path: Optional[str] = None, url: Optional[str] = None,
                   is_mark_face: bool = False, note: str = "",
                   usage: str = "") -> Any:
        before = {item["res_id"] for item in await self.list(200)}
        emoji_id = ""
        package_id = ""
        segment: Optional[dict[str, Any]] = None
        if source_message_id:
            segment = await self._segment_from_message(source_message_id)
            data = segment.get("data") or {}
            emoji_id = str(data.get("emoji_id") or "")
            package_id = str(data.get("emoji_package_id") or "")
            local = data.get("file")
            if local and Path(str(local)).is_file():
                file_path = str(local)
            elif data.get("url"):
                url = str(data["url"])
        if not file_path and url:
            segment = {"type": "image", "data": {"url": url}}
        if not file_path:
            if segment is None:
                raise ActionError("save_sticker", "source_message_id, file_path or url required", 1400)
            file_path = await self.media.fetch(segment, 0, source_message_id or "sticker", self.actions.call)
        if not file_path:
            raise ActionError("save_sticker", "failed to resolve sticker file", 1400)
        md5 = await asyncio.to_thread(_file_md5, file_path) if Path(file_path).is_file() else ""
        params: dict[str, Any] = {
            "file": file_path,
            "is_mark_face": is_mark_face,
            "is_origin": True,
        }
        if emoji_id:
            params["emoji_id"] = emoji_id
        if package_id:
            params["package_id"] = package_id
        result = await self.actions.call("add_custom_face", params, mutating=True)

        after = await self.list(200)
        target = next((item for item in after if item["res_id"] not in before), None)
        if target is None and md5:
            target = next((item for item in after if item["md5"] == md5), None)
        note_applied = False
        if target is not None and note:
            try:
                await self.actions.call("set_custom_face_desc", {
                    "emoji_id": int(target.get("emo_id") or 0),
                    "res_id": target["res_id"],
                    "md5": target.get("md5") or md5,
                    "desc": note,
                }, mutating=True)
                note_applied = True
            except Exception:
                note_applied = False
        if self.store is not None:
            key = target["res_id"] if target is not None else (md5 or file_path)
            await self.store.set_sticker_meta(
                key,
                target.get("md5", md5) if target else md5,
                note,
                usage,
            )
        return {
            "result": result,
            "sticker": target,
            "note": note,
            "usage": usage,
            "note_applied": note_applied,
        }

    async def update(self, res_id: str, note: Optional[str] = None,
                     usage: Optional[str] = None) -> dict[str, Any]:
        target = await self._find(res_id)
        note_value = target.get("note", "") if note is None else note
        usage_value = target.get("usage", "") if usage is None else usage
        note_applied = True
        if note is not None:
            try:
                await self.actions.call("set_custom_face_desc", {
                    "emoji_id": int(target.get("emo_id") or 0),
                    "res_id": target["res_id"],
                    "md5": target.get("md5") or "",
                    "desc": note,
                }, mutating=True)
            except Exception:
                note_applied = False
        if self.store is not None:
            await self.store.set_sticker_meta(
                target["res_id"], target.get("md5") or "", note_value, usage_value
            )
        return {
            "sticker": target,
            "note": note_value,
            "usage": usage_value,
            "note_applied": note_applied,
        }

    async def delete(self, res_id: str) -> dict[str, Any]:
        target = await self._find(res_id)
        result = await self.actions.call(
            "delete_custom_face", {"res_id": target["res_id"]}, mutating=True
        )
        if self.store is not None:
            await self.store.delete_sticker_meta(target["res_id"])
            if target.get("md5"):
                await self.store.delete_sticker_meta(target["md5"])
        return {"deleted": True, "sticker": target, "result": result}

    async def _resolve_segment(self, res_id: Optional[str],
                               source_message_id: Optional[str],
                               file_path: Optional[str]) -> dict[str, Any]:
        if source_message_id:
            return await self._segment_from_message(source_message_id)
        if res_id:
            item = await self._find(res_id)
            path = item.get("url") or item.get("path")
            if not path:
                raise ActionError("send_sticker", f"sticker {res_id} has no path/url", 1402)
            return {"type": "image", "data": {"file": path, "summary": item.get("note") or item.get("name") or ""}}
        if file_path:
            return {"type": "image", "data": {"file": file_path}}
        raise ActionError("send_sticker", "res_id, source_message_id or file_path required", 1400)

    async def _find(self, res_id: str) -> dict[str, Any]:
        for item in await self.list(200):
            if item["res_id"] == str(res_id):
                return item
        raise ActionError("send_sticker", f"sticker not found: {res_id}", 1402)

    async def _segment_from_message(self, message_id: str) -> dict[str, Any]:
        message = await self.actions.get_msg(message_id)
        if isinstance(message, dict):
            segments = message.get("message") or message.get("content") or []
        else:
            segments = []
        for segment in segments if isinstance(segments, list) else []:
            if isinstance(segment, dict) and segment.get("type") in ("mface", "image"):
                return segment
        raise ActionError("sticker", f"no mface/image in message {message_id}", 1402)
