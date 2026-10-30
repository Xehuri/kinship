# -*- coding: utf-8 -*-
"""提醒板通道测试（v2 单文本板）：REST 契约（冻结）+ 持久化形状 + 校验错误。

契约点逐条锁定：
  GET  /api/reminders → 200 {"text": str, "updated_at": int}；未知 query（含遗留
    status=）一律忽略；形状非 v2（含 v1 {"next_id","items"} 与损坏 JSON）= 空板，
    不抛错、不自动迁移。
  POST /api/reminders {"text"} → 200 {"text","updated_at"}，整块覆盖；
    去首尾空白后空串 = 合法清空（updated_at 刷新）；> 2000 字符 → 400。
v1 语义废除：无 id/done、无 /{id}/done、无 DELETE。
写入隔离：配置单例 data.dir 临时指向 tmp_path（同 test_health_sync_store
sandbox_root 第 1 重防御），Store 每次操作现读 DATA_DIR，绝不写真实 ai/data。
"""
import json
import os

import pytest

import services.reminders_store as reminders_store
from services.reminders_store import MAX_TEXT_LEN, RemindersBoard

# conftest 的 auth_headers 以 "Axeuh" 登录，中间件注入的 user_id 即该用户名
TEST_USER_ID = "Axeuh"

EXPECTED_KEYS = {"text", "updated_at"}


@pytest.fixture
def reminders_root(tmp_path, monkeypatch):
    """把 DATA_DIR 重定向到 tmp_path（RemindersBoard 动态读配置即生效）。"""
    import config.config as cc
    cfg = cc.get_config()
    monkeypatch.setitem(
        cfg._data, "data", {**(cfg._data.get("data") or {}), "dir": str(tmp_path)}
    )
    return str(tmp_path)


@pytest.fixture
def cleanup(reminders_root):
    """别名 fixture：仅需根目录重定向的测试用它声明依赖顺序。"""
    return reminders_root


def _user_file(root: str, user_id: str = TEST_USER_ID) -> str:
    """断言用：约定的每用户存储路径形状。"""
    return os.path.join(root, "users", user_id, "reminders.json")


def _seed_file(root: str, content: str, user_id: str = TEST_USER_ID) -> str:
    """预置用户文件原始字节（legacy/损坏形状注入用），返回路径。"""
    path = _user_file(root, user_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


class _SteppingClock:
    """可控时钟替身：每次 time() 前进 1 秒，使跨写入 updated_at 严格递增可断言
    （真实 int(time.time()) 秒级分辨率下同秒两次写入会相等，无法验证递增）。"""

    def __init__(self, start: float = 1_760_000_000.0):
        self._t = start

    def time(self) -> float:
        self._t += 1.0
        return self._t


class TestBoardReadEmpty:
    """GET 空板（契约主体）"""

    def test_get_empty_board_shape(self, client, auth_headers, cleanup):
        """从未写入 → 200 且恰为 {"text":"", "updated_at":0}，无多余键。"""
        resp = client.get("/api/reminders", headers=auth_headers)
        assert resp.status_code == 200
        body = resp.json()
        assert set(body.keys()) == EXPECTED_KEYS
        assert body["text"] == ""
        assert body["updated_at"] == 0

    def test_get_ignores_unknown_query_params(self, client, auth_headers, cleanup):
        """未知 query 参数（含遗留 status= 与任意新键）一律忽略，返回 200 v2 形状。"""
        resp = client.get("/api/reminders?status=active&foo=bar", headers=auth_headers)
        assert resp.status_code == 200
        assert set(resp.json().keys()) == EXPECTED_KEYS


class TestBoardWriteOverwrite:
    """POST 整块覆盖"""

    def test_write_then_get_roundtrip_preserves_newlines(self, client, auth_headers, cleanup):
        """写入含换行全文 → 响应与回读逐字符一致（内部换行/空格原样保留）。"""
        text = "明天下午三点取快递\n  记得带购物袋  \n晚上九点给妈妈打电话"
        post = client.post("/api/reminders", json={"text": text}, headers=auth_headers)
        assert post.status_code == 200
        assert set(post.json().keys()) == EXPECTED_KEYS
        assert post.json()["text"] == text
        got = client.get("/api/reminders", headers=auth_headers).json()
        assert got["text"] == text
        assert got["updated_at"] == post.json()["updated_at"]

    def test_overwrite_replaces_fully(self, client, auth_headers, cleanup):
        """再次 POST 整块覆盖：旧全文消失，只剩新全文。"""
        client.post("/api/reminders", json={"text": "旧内容第一行\n旧内容第二行"},
                    headers=auth_headers)
        resp = client.post("/api/reminders", json={"text": "只有新内容"},
                           headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["text"] == "只有新内容"
        assert client.get("/api/reminders", headers=auth_headers).json()["text"] == "只有新内容"

    def test_strip_leading_trailing_whitespace(self, client, auth_headers, cleanup):
        """写入值去首尾空白后落盘，内部空白不动。"""
        resp = client.post("/api/reminders", json={"text": "\n  带空白  \n"},
                           headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["text"] == "带空白"

    def test_whitespace_only_clears_board(self, client, auth_headers, cleanup):
        """去首尾空白后为空 = 合法清空：200、text=""，板内容被抹掉。"""
        client.post("/api/reminders", json={"text": "将被清空的内容"}, headers=auth_headers)
        resp = client.post("/api/reminders", json={"text": "  "}, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["text"] == ""
        assert client.get("/api/reminders", headers=auth_headers).json()["text"] == ""

    def test_empty_string_clears_board(self, client, auth_headers, cleanup):
        """显式空串同样清空（200）。"""
        client.post("/api/reminders", json={"text": "内容"}, headers=auth_headers)
        resp = client.post("/api/reminders", json={"text": ""}, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {"text": "", "updated_at": resp.json()["updated_at"]}
        assert client.get("/api/reminders", headers=auth_headers).json()["text"] == ""


class TestBoardValidation:
    """长度校验（400 侧契约）"""

    def test_exactly_2000_ok(self, client, auth_headers, cleanup):
        """去空白后恰 2000 字符 → 200（边界放行）。"""
        resp = client.post("/api/reminders", json={"text": "字" * 2000},
                           headers=auth_headers)
        assert resp.status_code == 200
        assert len(resp.json()["text"]) == MAX_TEXT_LEN == 2000

    def test_2000_after_strip_ok(self, client, auth_headers, cleanup):
        """两侧空白包裹的 2000 字符：去空白后恰好合规 → 200。"""
        resp = client.post("/api/reminders", json={"text": " \n" + "字" * 2000 + " \n"},
                           headers=auth_headers)
        assert resp.status_code == 200
        assert len(resp.json()["text"]) == 2000

    def test_over_2000_400(self, client, auth_headers, cleanup):
        """去空白后 2001 字符 → 400。"""
        resp = client.post("/api/reminders", json={"text": "字" * 2001},
                           headers=auth_headers)
        assert resp.status_code == 400

    def test_400_detail_is_chinese_valueerror(self, cleanup):
        """存储层 ValueError 消息为中文（路由层原样映射 400 detail）。"""
        board = RemindersBoard(data_root=cleanup)
        with pytest.raises(ValueError) as ei:
            board.put_board(TEST_USER_ID, "字" * 2001)
        assert "2000" in str(ei.value)
        with pytest.raises(ValueError):
            board.put_board(TEST_USER_ID, None)  # 非字符串拒绝


class TestBoardTimestamps:
    """updated_at 服务端语义"""

    def test_updated_at_strictly_increases_across_writes(
        self, client, auth_headers, cleanup, monkeypatch
    ):
        """替身时钟每次前进 1 秒：三次写入的 updated_at 严格递增。"""
        monkeypatch.setattr(reminders_store, "time", _SteppingClock())
        stamps = []
        for i in range(3):
            resp = client.post("/api/reminders", json={"text": f"第{i}版"},
                               headers=auth_headers)
            assert resp.status_code == 200
            stamps.append(resp.json()["updated_at"])
        assert stamps == sorted(stamps) and len(set(stamps)) == 3

    def test_clear_also_bumps_updated_at(self, client, auth_headers, cleanup, monkeypatch):
        """清空同样刷新 updated_at（合法清空不是拒绝写入）。"""
        monkeypatch.setattr(reminders_store, "time", _SteppingClock())
        first = client.post("/api/reminders", json={"text": "内容"},
                            headers=auth_headers).json()["updated_at"]
        cleared = client.post("/api/reminders", json={"text": "   "},
                              headers=auth_headers).json()
        assert cleared["text"] == ""
        assert cleared["updated_at"] > first


class TestBoardLegacyAndCorrupt:
    """非 v2 形状文件 = 空板（不抛错、不自动迁移）"""

    def test_legacy_v1_list_shape_reads_as_empty_board(self, client, auth_headers, cleanup):
        """v1 {"next_id","items"} 清单文件：GET 返回空板形状；读侧零副作用不改写文件。"""
        legacy = {
            "next_id": 3,
            "items": [
                {"id": 1, "text": "旧提醒一", "created_at": 1, "done": False, "done_at": None},
                {"id": 2, "text": "旧提醒二", "created_at": 2, "done": True, "done_at": 2},
            ],
        }
        path = _seed_file(cleanup, json.dumps(legacy, ensure_ascii=False))
        resp = client.get("/api/reminders", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {"text": "", "updated_at": 0}
        # 读侧不自动迁移：原文件字节仍是 v1 形状
        with open(path, encoding="utf-8") as f:
            assert set(json.load(f).keys()) == {"next_id", "items"}

    def test_corrupt_json_reads_as_empty_board(self, client, auth_headers, cleanup):
        """损坏 JSON 文件：GET 返回空板形状，不 500。"""
        _seed_file(cleanup, "{这不是 合法JSON ...")
        resp = client.get("/api/reminders", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {"text": "", "updated_at": 0}

    def test_non_v2_dict_shape_reads_as_empty_board(self, client, auth_headers, cleanup):
        """合法 JSON 但形状不对（text 非 str / updated_at 非 int）：同样空板。"""
        _seed_file(cleanup, json.dumps({"text": 123, "updated_at": "x"}))
        resp = client.get("/api/reminders", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {"text": "", "updated_at": 0}

    def test_first_v2_write_overwrites_legacy_file(self, client, auth_headers, cleanup):
        """legacy 文件上首次成功写入：原子覆盖为 v2 形状（v1 内容自然消失）。"""
        _seed_file(cleanup, json.dumps({"next_id": 3, "items": []}))
        resp = client.post("/api/reminders", json={"text": "v2 新板"},
                           headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["text"] == "v2 新板"
        assert client.get("/api/reminders", headers=auth_headers).json()["text"] == "v2 新板"


class TestBoardPersistence:
    """落盘形状与重启可见性"""

    def test_on_disk_shape_is_v2_only_keys(self, client, auth_headers, cleanup):
        """落盘文件解析后恰为 {"text","updated_at"} 两键，无 v1 残留键。"""
        client.post("/api/reminders", json={"text": "形状断言"}, headers=auth_headers)
        path = _user_file(cleanup)
        assert os.path.exists(path)
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        assert set(raw.keys()) == EXPECTED_KEYS
        assert raw["text"] == "形状断言"
        assert isinstance(raw["updated_at"], int)

    def test_survives_board_reinstantiation(self, client, auth_headers, cleanup):
        """新建 Board 实例（模拟进程重启的加载路径）即可见既有全文。"""
        client.post("/api/reminders", json={"text": "重启后还在\n第二行"},
                    headers=auth_headers)
        fresh = RemindersBoard()  # data_root 动态读配置（已被重定向到 tmp）
        assert fresh.get_board(TEST_USER_ID)[0] == "重启后还在\n第二行"

    def test_module_singleton_shares_file_state(self, client, auth_headers, cleanup):
        """路由（单例）写入与独立新实例读取同源于文件——无进程内私有状态。"""
        client.post("/api/reminders", json={"text": "共享真值"}, headers=auth_headers)
        text, updated_at = RemindersBoard(data_root=cleanup).get_board(TEST_USER_ID)
        assert text == "共享真值"
        assert updated_at > 0

    def test_unknown_user_gets_empty_board(self, client, auth_headers, cleanup):
        """未认证注入的其他用户目录互不串板（按 user_id 分文件）。"""
        client.post("/api/reminders", json={"text": "本人内容"}, headers=auth_headers)
        assert RemindersBoard(data_root=cleanup).get_board("Other") == ("", 0)
