from __future__ import annotations

import asyncio

from services.qq_gateway.stickers import StickerService


class FakeActions:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.sent: list[tuple[str, str, list]] = []
        self.items = [{
            "resId": "r1", "eId": "e1", "emoId": 0, "epId": 9, "desc": "",
            "md5": "MD5A", "url": "https://example/a.gif", "emoPath": "/tmp/a.gif",
            "isMarkFace": False, "isAPNG": False,
        }]

    async def call(self, action: str, params: dict, mutating=None, timeout=None):
        self.calls.append((action, dict(params)))
        if action == "fetch_custom_face_detail":
            return [dict(item) for item in self.items]
        if action == "get_msg":
            return {"message": [{"type": "mface", "data": {
                "emoji_id": "e1", "emoji_package_id": 9, "key": "k",
                "summary": "[动画表情]", "url": "https://example/a.gif",
            }}]}
        if action == "add_custom_face":
            self.items.insert(0, {
                "resId": "r2", "eId": "e1", "emoId": 0, "epId": 9, "desc": "",
                "md5": "MD5NEW", "url": "https://example/new.gif",
                "emoPath": "/tmp/new.gif", "isMarkFace": False, "isAPNG": False,
            })
            return {"result": 0, "errMsg": "", "isExist": 0}
        if action == "set_custom_face_desc":
            for item in self.items:
                if item["resId"] == params.get("res_id"):
                    item["desc"] = params.get("desc", "")
            return {"result": 0}
        if action == "delete_custom_face":
            self.items = [item for item in self.items if item["resId"] != params.get("res_id")]
            return {"result": 0}
        return {"ok": True}

    async def send_message(self, message_type, target_id, message, auto_escape=False, delay_seconds=0):
        self.sent.append((message_type, str(target_id), message))
        return {"message_id": 1}

    async def get_msg(self, message_id):
        return await self.call("get_msg", {"message_id": message_id})


class FakeMedia:
    async def fetch(self, segment, index, message_id, call_action=None):
        return "/tmp/downloaded.gif"


class FakeStore:
    def __init__(self) -> None:
        self.meta: dict[str, dict[str, str]] = {}

    async def set_sticker_meta(self, res_id, md5, note, usage):
        self.meta[res_id] = {"md5": md5, "note": note, "usage": usage}

    async def all_sticker_meta(self):
        return dict(self.meta)

    async def delete_sticker_meta(self, res_id):
        self.meta.pop(res_id, None)


def test_list_normalizes_favorites() -> None:
    async def scenario() -> None:
        service = StickerService(FakeActions(), FakeMedia())
        items = await service.list(10)
        assert items[0]["res_id"] == "r1"
        assert items[0]["emoji_id"] == "e1"
        assert items[0]["package_id"] == "9"
        assert items[0]["path"] == "/tmp/a.gif"

    asyncio.run(scenario())


def test_list_merges_note_and_usage() -> None:
    async def scenario() -> None:
        store = FakeStore()
        store.meta["r1"] = {"md5": "MD5A", "note": "开心", "usage": "打招呼"}
        service = StickerService(FakeActions(), FakeMedia(), store)
        items = await service.list(10)
        assert items[0]["note"] == "开心"
        assert items[0]["usage"] == "打招呼"

    asyncio.run(scenario())


def test_send_by_source_message_copies_mface() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        service = StickerService(actions, FakeMedia())
        await service.send("private", "200", source_message_id="m1")
        assert actions.sent[0][0] == "private"
        assert actions.sent[0][2][0]["type"] == "mface"

    asyncio.run(scenario())


def test_send_by_res_id_uses_image_url() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        service = StickerService(actions, FakeMedia())
        await service.send("private", "200", res_id="r1")
        segment = actions.sent[0][2][0]
        assert segment["type"] == "image"
        assert segment["data"]["file"] == "https://example/a.gif"

    asyncio.run(scenario())


def test_save_sets_note_and_usage() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        store = FakeStore()
        service = StickerService(actions, FakeMedia(), store)
        result = await service.save(source_message_id="m1", note="开心", usage="打招呼")
        assert result["note_applied"] is True
        assert result["sticker"]["res_id"] == "r2"
        assert any(action == "add_custom_face" for action, _ in actions.calls)
        assert any(action == "set_custom_face_desc" for action, _ in actions.calls)
        assert store.meta["r2"] == {"md5": "MD5NEW", "note": "开心", "usage": "打招呼"}

    asyncio.run(scenario())


def test_update_changes_note_and_usage() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        store = FakeStore()
        service = StickerService(actions, FakeMedia(), store)
        result = await service.update("r1", note="新备注", usage="新用法")
        assert result["note_applied"] is True
        assert result["note"] == "新备注"
        assert store.meta["r1"] == {"md5": "MD5A", "note": "新备注", "usage": "新用法"}

    asyncio.run(scenario())


def test_delete_removes_favorite_and_meta() -> None:
    async def scenario() -> None:
        actions = FakeActions()
        store = FakeStore()
        store.meta["r1"] = {"md5": "MD5A", "note": "x", "usage": "y"}
        service = StickerService(actions, FakeMedia(), store)
        result = await service.delete("r1")
        assert result["deleted"] is True
        assert actions.items == []
        assert "r1" not in store.meta

    asyncio.run(scenario())

