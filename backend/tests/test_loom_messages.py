# -*- coding: utf-8 -*-
"""loom_messages 纯函数单测 - pi→opencode 历史形状对齐 hm 前端渲染契约（W43）。

前端证据（只读契约）：
- sseParsing.ts:60-69 part 白名单 reasoning|thought|text|tool|tool_call|tool_result，
  "thinking" 不在其列——历史 thinking 块必须发成 type=="reasoning"。
- partHandlers.ts:121-160 tool part 需 part.tool + state{status,input,output}，
  reasoning 读 part.text。
钉行为：reasoning 放行 / toolResult 按 toolCallId 页级合并回 assistant toolCall part /
孤儿合成 / 无 assistant 兜底旧壳 + logger.debug 计数 / part 稳定字段
id·callID·messageID·sessionID / 消息序保持 / tokens 与 msg_hist_* 形状不动。
"""
import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services import loom_messages as lm

SID = "s1"


def _assistant(ts, blocks, **extra):
    m = {"role": "assistant", "content": blocks, "timestamp": ts,
         "model": "m", "provider": "p", "stopReason": "stop",
         "usage": {"totalTokens": 9, "input": 5, "output": 4, "cacheRead": 1, "cacheWrite": 0}}
    m.update(extra)
    return m


def _tool_call(call_id, name="bash", arguments=None):
    return {"type": "toolCall", "id": call_id, "name": name,
            "arguments": arguments if arguments is not None else {"command": "ls"}}


def _tool_result(ts, call_id, content="输出正文", is_error=False, name="bash"):
    m = {"role": "toolResult", "toolCallId": call_id, "toolName": name,
         "content": content, "timestamp": ts}
    if is_error:
        m["isError"] = True
    return m


class TestThinkingToReasoning:
    def test_thinking_block_becomes_reasoning_part(self):
        """ThinkingContent 不再丢弃：前端白名单只认 reasoning，part.text 载 thinking 正文。"""
        out = lm.to_opencode_messages(
            [_assistant(2000, [{"type": "thinking", "thinking": "先想一步"},
                               {"type": "text", "text": "再答一句"}])], SID)
        parts = out[0]["parts"]
        assert parts[0]["type"] == "reasoning"
        assert parts[0]["text"] == "先想一步"
        assert parts[1]["type"] == "text" and parts[1]["text"] == "再答一句"

    def test_thinking_missing_text_yields_empty_string(self):
        """thinking 键缺失时 part.text 为 ""（不 KeyError、不发 None）。"""
        out = lm.to_opencode_messages([_assistant(2000, [{"type": "thinking"}])], SID)
        assert len(out[0]["parts"]) == 1
        assert out[0]["parts"][0]["type"] == "reasoning"
        assert out[0]["parts"][0]["text"] == ""


class TestStablePartFields:
    def test_user_text_part_gets_id_message_session(self):
        """每个产出 part 补 id=f"part_hist_{created}_{index}_{blockIdx}"、messageID、sessionID。"""
        out = lm.to_opencode_messages(
            [{"role": "user", "content": "提问", "timestamp": 1000}], SID)
        p = out[0]["parts"][0]
        assert p["id"] == "part_hist_1000_0_0"
        assert p["messageID"] == out[0]["info"]["id"] == "msg_hist_1000_0"
        assert p["sessionID"] == SID
        assert "callID" not in p  # 非 tool part 无 callID

    def test_tool_call_part_carries_callid_from_block_id(self):
        """toolCall 块 id → part.callID（pi-ai 的 ToolCall.id）。"""
        out = lm.to_opencode_messages([_assistant(2000, [_tool_call("call_9")])], SID)
        p = out[0]["parts"][0]
        assert p["type"] == "tool"
        assert p["callID"] == "call_9"
        assert p["id"] == "part_hist_2000_0_0"
        assert p["messageID"] == "msg_hist_2000_0"
        assert p["sessionID"] == SID
        assert p["state"] == {"status": "completed", "input": {"command": "ls"}, "output": ""}

    def test_block_index_counts_produced_parts(self):
        """blockIdx 按产出 part 顺序编号（跳过非 dict 块不占号）。"""
        out = lm.to_opencode_messages(
            [_assistant(2000, [{"type": "thinking", "thinking": "t"},
                               "坏块",
                               {"type": "text", "text": "x"},
                               _tool_call("c1")])], SID)
        ids = [p["id"] for p in out[0]["parts"]]
        assert ids == ["part_hist_2000_0_0", "part_hist_2000_0_1", "part_hist_2000_0_2"]


class TestToolResultMerge:
    def test_merged_into_matching_tool_part_and_no_standalone_message(self):
        """同页匹配 callID 的 toolResult → 写回 state.output，不再产出独立 toolResult 消息。"""
        out = lm.to_opencode_messages(
            [_assistant(2000, [_tool_call("c1")]),
             _tool_result(2100, "c1", content="结果A")], SID)
        assert len(out) == 1
        assert all(m["info"]["role"] != "toolResult" for m in out)
        p = out[0]["parts"][0]
        assert p["state"]["output"] == "结果A"
        assert p["state"]["status"] == "completed"  # 非错误保持 completed
        assert p["callID"] == "c1"

    def test_is_error_flips_status_to_error(self):
        out = lm.to_opencode_messages(
            [_assistant(2000, [_tool_call("c1")]),
             _tool_result(2100, "c1", content="崩了", is_error=True)], SID)
        p = out[0]["parts"][0]
        assert p["state"]["status"] == "error"
        assert p["state"]["output"] == "崩了"

    def test_tool_call_without_result_keeps_empty_output(self):
        """无 toolResult 的 toolCall 不得编造 output：留 ""、status "completed"（与现状一致）。"""
        out = lm.to_opencode_messages([_assistant(2000, [_tool_call("c1")])], SID)
        assert out[0]["parts"][0]["state"] == {
            "status": "completed", "input": {"command": "ls"}, "output": ""}

    def test_multiple_calls_match_by_callid(self):
        """一页多 call 各自并回自己的结果（乱序到达也按 callID 对上）。"""
        out = lm.to_opencode_messages(
            [_assistant(2000, [_tool_call("c1", name="bash"), _tool_call("c2", name="read")]),
             _tool_result(2300, "c2", content="读到的", name="read"),
             _tool_result(2200, "c1", content="跑的", name="bash")], SID)
        p1, p2 = out[0]["parts"]
        assert (p1["callID"], p1["state"]["output"]) == ("c1", "跑的")
        assert (p2["callID"], p2["state"]["output"]) == ("c2", "读到的")

    def test_message_order_preserved_across_page(self):
        """合并不得打乱消息序：user/assistant/user 升序，toolResult 原位消失。"""
        out = lm.to_opencode_messages(
            [{"role": "user", "content": "早", "timestamp": 1000},
             _assistant(2000, [_tool_call("c1")]),
             _tool_result(2100, "c1"),
             {"role": "user", "content": "晚", "timestamp": 3000}], SID)
        assert [m["info"]["role"] for m in out] == ["user", "assistant", "user"]
        assert out[2]["info"]["id"] == "msg_hist_3000_3"  # 原始下标不因合并漂移
        assert out[1]["parts"][0]["state"]["output"] == "输出正文"


class TestOrphanToolResult:
    def test_orphan_kept_as_standalone_shell_at_original_position(self):
        """同页无匹配 callID → 原位独立 toolResult 壳，绝不挂最后一条 assistant。"""
        out = lm.to_opencode_messages(
            [_assistant(2000, [{"type": "text", "text": "先说话"}]),
             _assistant(3000, [_tool_call("c1")]),
             _tool_result(4000, "zz", content="孤儿输出", name="bash")], SID)
        assert len(out) == 3
        assert [m["info"]["role"] for m in out] == ["assistant", "assistant", "toolResult"]
        assert len(out[1]["parts"]) == 1  # host c1 untouched
        assert out[1]["parts"][0]["callID"] == "c1"
        shell = out[2]
        assert shell["info"]["id"] == "msg_hist_4000_2"
        syn = shell["parts"][0]
        assert syn["type"] == "tool" and syn["tool"] == "bash"
        assert syn["callID"] == "zz"
        assert syn["state"] == {"status": "completed", "input": {}, "output": "孤儿输出"}
        assert syn["id"] == "part_hist_4000_2_0"
        assert syn["messageID"] == "msg_hist_4000_2"
        assert syn["sessionID"] == SID

    def test_orphan_before_final_text_stays_before_it(self):
        """生产回归：20 条分页截断 read toolCall 时，read 结果不得挂到后面的最终纯文本。"""
        out = lm.to_opencode_messages(
            [_assistant(1000, [{"type": "text", "text": "前文"}]),
             _tool_result(2000, "read-orphan", content="Read image file [image/jpeg]", name="read"),
             _assistant(3000, [{"type": "text", "text": "最终回复"}])], SID)
        assert [m["info"]["role"] for m in out] == ["assistant", "toolResult", "assistant"]
        final = out[2]
        assert len(final["parts"]) == 1
        assert final["parts"][0]["type"] == "text"
        assert final["parts"][0]["text"] == "最终回复"
        shell = out[1]
        assert shell["parts"][0]["tool"] == "read"
        assert shell["parts"][0]["callID"] == "read-orphan"

    def test_orphan_error_status(self):
        out = lm.to_opencode_messages(
            [_assistant(2000, [{"type": "text", "text": "x"}]),
             _tool_result(2100, "zz", content="炸", is_error=True)], SID)
        assert len(out) == 2
        assert out[1]["info"]["role"] == "toolResult"
        assert out[1]["parts"][0]["state"]["status"] == "error"

    def test_fallback_shell_when_page_has_no_assistant(self):
        """整页连一条 assistant 都没有才保留旧壳（兜底），原位保持消息序 + logger.debug 计数。"""
        out = lm.to_opencode_messages(
            [{"role": "user", "content": "早", "timestamp": 1000},
             _tool_result(1500, "zz", content="无宿主输出"),
             {"role": "user", "content": "晚", "timestamp": 2000}], SID)
        assert [m["info"]["role"] for m in out] == ["user", "toolResult", "user"]
        shell = out[1]
        assert shell["info"]["id"] == "msg_hist_1500_1"
        p = shell["parts"][0]
        assert p["type"] == "tool" and p["tool"] == "bash"
        assert p["callID"] == "zz"
        assert p["state"]["output"] == "无宿主输出"
        assert p["id"] == "part_hist_1500_1_0"
        assert p["messageID"] == "msg_hist_1500_1"
        assert p["sessionID"] == SID

    def test_fallback_and_orphan_debug_counts(self, caplog):
        """兜底壳与孤儿合成两个计数走 logger.debug（观测面，不影响返回值）。"""
        with caplog.at_level(logging.DEBUG, logger="services.loom_messages"):
            lm.to_opencode_messages(
                [_assistant(2000, [{"type": "text", "text": "x"}]),
                 _tool_result(2100, "zz"),
                 _tool_result(2200, "yy")], SID)
        assert "orphan_shell=2" in caplog.text
        caplog.clear()
        with caplog.at_level(logging.DEBUG, logger="services.loom_messages"):
            lm.to_opencode_messages([_tool_result(1500, "zz")], SID)
        assert "orphan_shell=1" in caplog.text

    def test_clean_page_logs_nothing(self, caplog):
        """全部正常合并/无孤儿时不打兜底 debug（防刷屏）。"""
        with caplog.at_level(logging.DEBUG, logger="services.loom_messages"):
            lm.to_opencode_messages(
                [_assistant(2000, [_tool_call("c1")]), _tool_result(2100, "c1")], SID)
        assert "orphan_shell" not in caplog.text


class TestUnchangedShapes:
    def test_tokens_and_info_shape_untouched(self):
        """tokens 六字段（含 reasoning:0）与 info 形状是前端硬契约，形状不动。"""
        out = lm.to_opencode_messages([_assistant(2000, [{"type": "text", "text": "y"}])], SID)
        info = out[0]["info"]
        assert info["tokens"] == {"total": 9, "input": 5, "output": 4, "reasoning": 0,
                                  "cache": {"read": 1, "write": 0}}
        assert info["id"] == "msg_hist_2000_0"
        assert info["model"] == "m" and info["provider"] == "p" and info["stopReason"] == "stop"

    def test_user_content_list_normalized(self):
        """user content TextContent 块拼接、ImageContent 跳过（既有行为回归钉）。"""
        out = lm.to_opencode_messages(
            [{"role": "user", "timestamp": 1000,
              "content": [{"type": "text", "text": "a"}, {"type": "image"},
                          {"type": "text", "text": "b"}]}], SID)
        assert out[0]["parts"][0]["text"] == "ab"

    def test_non_dict_messages_skipped_without_index_drift(self):
        """非 dict 条目照旧跳过，但原始下标占位不漂移（id 稳定性的前提）。"""
        out = lm.to_opencode_messages(
            [None, {"role": "user", "content": "x", "timestamp": 1000}], SID)
        assert len(out) == 1
        assert out[0]["info"]["id"] == "msg_hist_1000_1"

    def test_empty_page(self):
        assert lm.to_opencode_messages([], SID) == []


class TestEntryIdPassthroughW51:
    """W51：raw 条目 id → info["loomEntryId"] 透传（压缩分隔线锚匹配消费面）。

    纯增量键：raw 无 "id"/假值 id 不建键；msg_hist_* 方案逐字节不变。"""

    def test_user_item_id_stamped(self):
        out = lm.to_opencode_messages(
            [{"role": "user", "content": "问", "timestamp": 1000, "id": "entry_1"}], SID)
        assert out[0]["info"]["loomEntryId"] == "entry_1"
        assert out[0]["info"]["id"] == "msg_hist_1000_0"  # 旧 id 方案不动

    def test_assistant_item_id_stamped(self):
        out = lm.to_opencode_messages(
            [_assistant(2000, [{"type": "text", "text": "答"}], id="entry_2")], SID)
        assert out[0]["info"]["loomEntryId"] == "entry_2"
        assert out[0]["info"]["id"] == "msg_hist_2000_0"

    def test_toolresult_shell_id_stamped(self):
        """兜底旧壳（整页无 assistant）同样透传——分隔线锚可指向任意历史条目。"""
        raw = _tool_result(3000, "c1")
        raw["id"] = "entry_3"
        out = lm.to_opencode_messages([raw], SID)
        assert out[0]["info"]["role"] == "toolResult"
        assert out[0]["info"]["loomEntryId"] == "entry_3"

    def test_missing_or_falsy_id_adds_no_key(self):
        """无 id 键 / 空串 / None → 不建 loomEntryId（形状与 W51 前逐字节一致）。"""
        base = {"role": "user", "content": "x", "timestamp": 1000}
        for raw in (base, {**base, "id": ""}, {**base, "id": None}):
            out = lm.to_opencode_messages([raw], SID)
            assert "loomEntryId" not in out[0]["info"]
