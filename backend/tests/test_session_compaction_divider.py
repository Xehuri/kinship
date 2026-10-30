# -*- coding: utf-8 -*-
"""W51：loom 历史页压缩分隔线注入契约（路由层，fail-open + 锚规则全分支）。

钉死语义：
  a) anchorMessageId 精确命中 loomEntryId → 该下标前插入（重复取页 id 恒定=前端去重幂等）
  b) 无 id 锚 / id 锚不中 → anchorTimestampMs 回退（首条 created >= 边界之前；页首同刻可插）
  c) 整页严格新于边界（首条 ts > 边界）→ 不注入（边界属更早页）
  d) 整页严格旧于边界（无条目 ts >= 边界）→ 不注入
  e) 快照 None / 取用抛异常 → 原页 + 游标规则不变（fail-open 永不阻塞历史）
  f) status=="none" → 原页
  g) 有效通道≠loom → get_session_compaction 永不被调；缺面客户端（opencode 形）零副作用
  h) 响应键集恒 {session_id, messages, count, next_cursor}，注入后 count 重算
  i) 译后空页 → 快照根本不取、分隔线不复活空页游标（W50 截断语义优先）

缝与 test_session_messages_pagination 同款（monkeypatch session_router .acquire_web_client/
.get_web_backend/_acquire_client_by_backend），零触网、零鉴权面（直调路由函数）。
"""
import asyncio
from typing import Any, Dict, List, Optional

from routers import session as session_router

SID = "sess_w51"
BASE_TS = 1_792_000_000_000
RESP_KEYS = {"session_id", "messages", "count", "next_cursor"}


def _msg(index: int, entry_id: Optional[str] = None) -> Dict[str, Any]:
    """译后形状样本（loom_messages 产出面）：升序旧→新，id=msg_hist_* 方案，可选透传键。"""
    created = BASE_TS + index * 1000
    info: Dict[str, Any] = {"id": f"msg_hist_{created}_{index}", "role": "user",
                            "sessionID": SID, "time": {"created": created}}
    if entry_id:
        info["loomEntryId"] = entry_id
    return {"info": info, "parts": [{"type": "text", "text": f"t{index}"}]}


def _page(*indices: int) -> List[Dict[str, Any]]:
    return [_msg(i, entry_id=f"e{i}") for i in indices]


def _snap(**over: Any) -> Dict[str, Any]:
    snap: Dict[str, Any] = {
        "sessionID": SID, "status": "active", "coveredCount": 337,
        "summaryText": "[auto-compacted summary of 337 earlier messages]",
        "anchorMessageId": None, "anchorTimestampMs": BASE_TS + 500,
        "tailCount": 12, "totalMessages": 349,
    }
    snap.update(over)
    return snap


class _BaseClient:
    """opencode 形客户端桩：无 get_session_compaction 面（缺面守卫的可执行证明）。"""

    def __init__(self, messages: List[Dict[str, Any]],
                 next_cursor: Optional[str] = None) -> None:
        self._messages, self._next_cursor = messages, next_cursor

    async def get_session_messages(self, session_id: str, limit: int = 50,
                                   before: Optional[str] = None) -> Dict[str, Any]:
        return {"ok": True,
                "data": {"messages": self._messages, "next_cursor": self._next_cursor}}


class _LoomClient(_BaseClient):
    """loom 形客户端桩：compaction 腿计数 + 可注入快照/异常。"""

    def __init__(self, messages, next_cursor=None, compaction=None,
                 raises: bool = False) -> None:
        super().__init__(messages, next_cursor)
        self._compaction, self._raises = compaction, raises
        self.compaction_calls = 0

    async def get_session_compaction(self, session_id: str):
        self.compaction_calls += 1
        if self._raises:
            raise RuntimeError("compaction-boom")
        return self._compaction


def _patch(monkeypatch, client, web_backend: str = "loom") -> None:
    async def _acq():
        return client

    monkeypatch.setattr(session_router, "acquire_web_client", _acq)
    monkeypatch.setattr(session_router, "get_web_backend", lambda: web_backend)


def _fetch(**kw: Any) -> Dict[str, Any]:
    kw.setdefault("limit", 50)
    return asyncio.run(session_router.get_session_messages(SID, **kw))


def _is_divider(msg: Dict[str, Any]) -> bool:
    return any(p.get("type") == "compaction" for p in msg["parts"])


def _divider(result: Dict[str, Any]) -> Dict[str, Any]:
    hits = [m for m in result["messages"] if _is_divider(m)]
    assert len(hits) == 1, f"分隔线应恰一条: {[m['info']['id'] for m in hits]}"
    return hits[0]


class TestAnchorRules:
    def test_id_anchor_inserts_at_matched_index(self, monkeypatch):
        # Given：页 [e0..e4] 升序；快照锚定 e2（id 优先，ts 锚故意放最旧条目上证明 id 赢）
        client = _LoomClient(_page(0, 1, 2, 3, 4), next_cursor="c1",
                             compaction=_snap(anchorMessageId="e2",
                                              anchorTimestampMs=BASE_TS))
        _patch(monkeypatch, client)

        # When
        result = _fetch()

        # Then：分隔线在命中条目前（下标 2），原页序相对不变，游标透传
        assert set(result.keys()) == RESP_KEYS
        assert result["count"] == 6
        assert result["next_cursor"] == "c1"
        assert client.compaction_calls == 1
        msgs = result["messages"]
        assert _is_divider(msgs[2])
        assert [m["info"]["id"] for m in msgs if not _is_divider(m)] == [
            f"msg_hist_{BASE_TS + i * 1000}_{i}" for i in (0, 1, 2, 3, 4)]

    def test_divider_shape_deterministic_and_idempotent(self, monkeypatch):
        # Given：同桩同快照取两页（模拟前端重复拉同页去重）
        client = _LoomClient(_page(0, 1, 2),
                             compaction=_snap(anchorMessageId="e1",
                                              anchorTimestampMs=BASE_TS + 1000))
        _patch(monkeypatch, client)

        r1, r2 = _fetch(), _fetch()
        d1 = _divider(r1)["info"]
        d2 = _divider(r2)["info"]

        # Then：确定性 id（前端 getStableMessageId 去重幂等）+ 契约形状逐键
        assert d1["id"] == f"msg_compaction_{SID}_337" == d2["id"]
        assert d1["role"] == "assistant" and d1["sessionID"] == SID
        assert d1["time"]["created"] == BASE_TS + 1000
        part = _divider(r1)["parts"][0]
        assert part["id"] == f"part_compaction_{SID}_337"
        assert part["type"] == "compaction" and part["messageID"] == d1["id"]
        assert part["text"] == ("上下文已压缩：前 337 条消息已合并为一份摘要"
                                "（模型侧生效，原始历史完整保留）")

    def test_ts_fallback_when_no_id_anchor(self, monkeypatch):
        # Given：无 anchorMessageId；边界=条目3 时刻 → 首条 ts>=边界 = 下标 3
        client = _LoomClient(_page(0, 1, 2, 3, 4),
                             compaction=_snap(anchorTimestampMs=BASE_TS + 3000))
        _patch(monkeypatch, client)

        result = _fetch()

        assert _is_divider(result["messages"][3])

    def test_ts_fallback_when_id_anchor_misses_page(self, monkeypatch):
        """id 锚在本页查无 → 落 ts 回退（锚条目属更早页的常态形状）。"""
        client = _LoomClient(_page(0, 1, 2, 3),
                             compaction=_snap(anchorMessageId="e999",
                                              anchorTimestampMs=BASE_TS + 2000))
        _patch(monkeypatch, client)

        assert _is_divider(_fetch()["messages"][2])

    def test_first_item_exactly_at_boundary_inserts_at_head(self, monkeypatch):
        """页首 ts == 边界（i==0 且 first_ts<=anchor）→ 允许注入下标 0。"""
        client = _LoomClient(_page(0, 1, 2),
                             compaction=_snap(anchorTimestampMs=BASE_TS))
        _patch(monkeypatch, client)

        assert _is_divider(_fetch()["messages"][0])

    def test_page_entirely_newer_than_boundary_no_insert(self, monkeypatch):
        # Given：边界早于全页（首条即 > 边界）：属更早页 → 不注入
        client = _LoomClient(_page(10, 11, 12),
                             compaction=_snap(anchorTimestampMs=BASE_TS + 10 * 1000 - 500))
        _patch(monkeypatch, client)

        result = _fetch()

        assert result["count"] == 3
        assert all(not _is_divider(m) for m in result["messages"])

    def test_page_entirely_older_than_boundary_no_insert(self, monkeypatch):
        # Given：边界晚于全页（无任何条目 ts >= 边界）→ 不注入
        client = _LoomClient(_page(0, 1, 2),
                             compaction=_snap(anchorTimestampMs=BASE_TS + 9_999_000))
        _patch(monkeypatch, client)

        result = _fetch()

        assert result["count"] == 3 and all(not _is_divider(m) for m in result["messages"])


class TestAnchorWindowAcrossPages:
    """显式回归：同一快照沿历史回翻三页，分隔线只属于含锚页。

    事故形状：锚 00:14，最新页全为 00:46+；旧实现 initial 回退 index=0 把分隔线
    钉在最新页页首（显示在更晚消息之后）。现约定：
      - 最新页（initial，全部比锚新）→ 零条
      - 含锚页 → 恰一条，位于首条 created >= 锚的条目前
      - 更旧页（全部比锚旧）→ 零条
    """

    ANCHOR_TS = BASE_TS + 1500  # 介于 msg1(+1000) 与 msg2(+2000) 之间

    def _client(self, page: List[Dict[str, Any]], next_cursor: Optional[str]) -> _LoomClient:
        return _LoomClient(page, next_cursor=next_cursor,
                           compaction=_snap(anchorTimestampMs=self.ANCHOR_TS))

    def test_initial_newest_page_all_newer_gets_zero_dividers(self, monkeypatch):
        # Given：初始页（before=None）全部条目晚于锚
        client = self._client(_page(10, 11, 12), next_cursor="c_newer")
        _patch(monkeypatch, client)

        # When
        result = _fetch()

        # Then：锚不在本页 → 零分隔线，原页与游标不变
        assert result["count"] == 3
        assert result["next_cursor"] == "c_newer"
        assert all(not _is_divider(m) for m in result["messages"])

    def test_page_containing_anchor_gets_exactly_one_at_anchor(self, monkeypatch):
        # Given：回翻页 [e0..e4]，锚落在 msg1 与 msg2 之间
        client = self._client(_page(0, 1, 2, 3, 4), next_cursor="c_contain")
        _patch(monkeypatch, client)

        # When
        result = _fetch(before="c_newer")

        # Then：恰一条，紧邻首条 created >= 锚（msg2）之前
        divider = _divider(result)
        msgs = result["messages"]
        assert _is_divider(msgs[2])
        assert divider["info"]["time"]["created"] == self.ANCHOR_TS
        assert all(msgs[i]["info"]["time"]["created"] < self.ANCHOR_TS for i in range(2))
        assert msgs[3]["info"]["time"]["created"] >= self.ANCHOR_TS

    def test_older_page_all_older_gets_zero_dividers(self, monkeypatch):
        # Given：更旧页全部条目早于锚
        client = self._client(_page(-5, -4, -3), next_cursor=None)
        _patch(monkeypatch, client)

        # When
        result = _fetch(before="c_contain")

        # Then：锚不在本页 → 零分隔线，原页不变
        assert result["count"] == 3
        assert result["next_cursor"] is None
        assert all(not _is_divider(m) for m in result["messages"])


class TestFailOpen:
    def test_snapshot_none_keeps_page_and_cursor(self, monkeypatch):
        client = _LoomClient(_page(0, 1), next_cursor="c1", compaction=None)
        _patch(monkeypatch, client)

        result = _fetch()

        assert set(result.keys()) == RESP_KEYS
        assert result["count"] == 2 and result["next_cursor"] == "c1"
        assert client.compaction_calls == 1  # 取用了，但 None → 原页

    def test_snapshot_raises_swallowed(self, monkeypatch):
        client = _LoomClient(_page(0, 1), next_cursor="c1", raises=True)
        _patch(monkeypatch, client)

        result = _fetch()

        assert result["count"] == 2 and result["next_cursor"] == "c1"

    def test_status_none_keeps_page(self, monkeypatch):
        client = _LoomClient(_page(0, 1),
                             compaction=_snap(status="none", anchorMessageId="e0"))
        _patch(monkeypatch, client)

        result = _fetch()

        assert result["count"] == 2 and all(not _is_divider(m) for m in result["messages"])

    def test_malformed_snapshot_swallowed(self, monkeypatch):
        """快照缺 anchorTimestampMs 且 id 锚不中 → 无边界可锚，原页（不 KeyError 穿透）。"""
        client = _LoomClient(_page(0, 1),
                             compaction=_snap(anchorMessageId="e777",
                                              anchorTimestampMs=None))
        _patch(monkeypatch, client)
        client._compaction.pop("anchorTimestampMs")

        assert _fetch()["count"] == 2

    def test_client_without_compaction_api_untouched(self, monkeypatch):
        """opencode 形客户端（无该面）+ 通道错配场景：getattr 守卫零副作用原页。"""
        client = _BaseClient(_page(0, 1), next_cursor="c9")
        _patch(monkeypatch, client, web_backend="loom")

        result = _fetch()

        assert result["count"] == 2 and result["next_cursor"] == "c9"


class TestChannelGating:
    def test_opencode_channel_never_calls_compaction(self, monkeypatch):
        client = _LoomClient(_page(0, 1), compaction=_snap(anchorMessageId="e1"))
        _patch(monkeypatch, client, web_backend="opencode")

        result = _fetch()

        assert client.compaction_calls == 0
        assert result["count"] == 2 and all(not _is_divider(m) for m in result["messages"])

    def test_explicit_loom_backend_leg_injects_without_web_probe(self, monkeypatch):
        """显式 backend=loom 腿：走 _acquire_client_by_backend 缝，注入生效。"""
        client = _LoomClient(_page(0, 1, 2), compaction=_snap(anchorMessageId="e1"))

        async def _acq(backend):
            assert backend == "loom"
            return client

        monkeypatch.setattr(session_router, "_acquire_client_by_backend", _acq)

        result = _fetch(backend="loom")

        assert result["count"] == 4 and _is_divider(result["messages"][1])

    def test_empty_page_never_fetches_never_resurrects_cursor(self, monkeypatch):
        """W50 优先：译后空页游标截断后，快照不取、分隔线不得复活该页。"""
        client = _LoomClient([], next_cursor="cX",
                             compaction=_snap(anchorMessageId="e0"))
        _patch(monkeypatch, client)

        result = _fetch()

        assert result["messages"] == [] and result["count"] == 0
        assert result["next_cursor"] is None
        assert client.compaction_calls == 0
