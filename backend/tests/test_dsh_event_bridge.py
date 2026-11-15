"""dsh -> 前端词表转译器单元测试（真实事件形状，无网络）。"""
import json
from typing import Any, Dict, List

from services.dsh_event_bridge import DshEventTranslator

SESSION = "ses_test_1"


def event(event_type: str, properties: Dict[str, Any]) -> Dict[str, Any]:
    return {"seq": 1, "payload": {"type": event_type, "properties": properties}}


def decode(frames: List[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for frame in frames:
        assert frame.startswith("data: ")
        assert frame.endswith("\n\n")
        out.append(json.loads(frame[len("data: "):].strip()))
    return out


def translate(translator: DshEventTranslator, event_type: str, properties: Dict[str, Any]) -> List[Dict[str, Any]]:
    return decode(translator.translate_event(event(event_type, properties)))


def live_chunk(translator: DshEventTranslator, chunk: Dict[str, Any], turn: int = 1, step: int = 1) -> List[Dict[str, Any]]:
    return translate(
        translator,
        "kinship/assistant-stream",
        {"session_id": SESSION, "frame": {"type": "chunk", "turn": turn, "step": step, "chunk": chunk}},
    )


def test_live_text_stream_accumulates_into_one_part() -> None:
    translator = DshEventTranslator(SESSION)
    start = translate(
        translator,
        "kinship/assistant-stream",
        {"session_id": SESSION, "frame": {"type": "start", "attemptId": "a1", "revision": 1, "turn": 1, "step": 1}},
    )
    assert start[0]["payload"]["type"] == "session.status"
    assert start[0]["payload"]["properties"]["status"] == {"type": "busy"}
    assert start[0]["payload"]["properties"]["sessionID"] == SESSION
    assert start[0]["payload"]["properties"]["backend"] == "dsh"

    translate(translator, "kinship/assistant-stream", {
        "session_id": SESSION,
        "frame": {"type": "chunk", "attemptId": "a1", "turn": 1, "step": 1,
                  "chunk": {"type": "block-start", "index": 0, "blockType": "text"}},
    })
    first = live_chunk(translator, {"type": "text-delta", "index": 0, "text": "hel"})
    second = live_chunk(translator, {"type": "text-delta", "index": 0, "text": "lo"})

    assert first[0]["payload"]["type"] == "message.part.updated"
    assert first[0]["payload"]["properties"]["part"] == {"id": "dsh-1-1-0", "type": "text", "text": "hel"}
    assert second[0]["payload"]["properties"]["part"]["text"] == "hello"
    assert "messageID" not in second[0]["payload"]["properties"]


def test_live_reasoning_delta_maps_to_reasoning_part() -> None:
    translator = DshEventTranslator(SESSION)
    frames = live_chunk(translator, {"type": "reasoning-delta", "index": 0, "text": "think"})
    part = frames[0]["payload"]["properties"]["part"]
    assert part == {"id": "dsh-1-1-0", "type": "reasoning", "text": "think"}


def test_live_tool_delta_then_block_end_parses_arguments() -> None:
    translator = DshEventTranslator(SESSION)
    partial = live_chunk(translator, {
        "type": "tool-call-delta", "index": 1, "id": "call-1", "name": "bash", "argumentsDelta": '{"command":',
    })
    assert partial[0]["payload"]["properties"]["part"]["id"] == "dsh-tool-call-1"
    assert partial[0]["payload"]["properties"]["part"]["state"]["status"] == "running"
    assert partial[0]["payload"]["properties"]["part"]["state"]["input"] == {"raw": '{"command":'}

    final = live_chunk(translator, {
        "type": "block-end", "index": 1,
        "block": {"type": "tool-call", "id": "call-1", "name": "bash", "arguments": '{"command":"ls"}'},
    })
    part = final[0]["payload"]["properties"]["part"]
    assert part["tool"] == "bash"
    assert part["state"]["input"] == {"command": "ls"}


def test_durable_assistant_message_reuses_streaming_part_ids_and_binds_message_id() -> None:
    translator = DshEventTranslator(SESSION)
    translate(translator, "kinship/assistant-stream", {
        "session_id": SESSION,
        "frame": {"type": "start", "attemptId": "a1", "revision": 1, "turn": 1, "step": 1},
    })
    live_chunk(translator, {"type": "text-delta", "index": 0, "text": "hello"})

    frames = translate(translator, "assistant/message", {
        "turn": 1, "step": 1,
        "message": {
            "id": "msg_a1", "role": "assistant",
            "content": [{"type": "text", "text": "hello"}],
            "source": {"kind": "model", "provider": "p", "model": "m"},
        },
        "stream": [],
        "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15, "reasoningTokens": 2},
    })
    kinds = [frame["payload"]["type"] for frame in frames]
    assert kinds == ["message.updated", "message.part.updated"]
    info = frames[0]["payload"]["properties"]["info"]
    assert info["id"] == "msg_a1" and info["role"] == "assistant"
    assert info["tokens"] == {
        "total": 15, "input": 10, "output": 5, "reasoning": 2, "cache": {"read": 0, "write": 0},
    }
    part_props = frames[1]["payload"]["properties"]
    assert part_props["messageID"] == "msg_a1"
    assert part_props["part"]["id"] == "dsh-1-1-0"
    assert part_props["part"]["text"] == "hello"


def test_tool_call_and_result_update_the_same_part() -> None:
    translator = DshEventTranslator(SESSION)
    translate(translator, "assistant/message", {
        "turn": 2, "step": 1,
        "message": {
            "id": "msg_a2", "role": "assistant",
            "content": [{"type": "tool-call", "id": "call-9", "name": "fs_read", "arguments": '{"path":"/x"}'}],
            "source": {"kind": "model", "provider": "p", "model": "m"},
        },
    })
    call = translate(translator, "tool/call", {
        "turn": 2, "step": 1, "callId": "call-9", "name": "fs_read", "arguments": '{"path":"/x"}',
    })
    assert call[0]["payload"]["properties"]["messageID"] == "msg_a2"
    assert call[0]["payload"]["properties"]["part"]["state"] == {
        "status": "running", "input": {"path": "/x"}, "output": "",
    }

    result = translate(translator, "tool/result", {
        "turn": 2, "step": 1,
        "message": {
            "id": "msg_t9", "role": "tool",
            "content": [{"type": "text", "text": "file body"}],
            "source": {"kind": "tool", "callId": "call-9"},
            "toolCallId": "call-9", "isError": False,
        },
    })
    part = result[0]["payload"]["properties"]["part"]
    assert part["id"] == "dsh-tool-call-9"
    assert part["state"] == {"status": "completed", "input": {"path": "/x"}, "output": "file body"}

    failed = translate(translator, "tool/result", {
        "turn": 2, "step": 1,
        "message": {"id": "msg_t10", "role": "tool", "content": [], "toolCallId": "call-9", "isError": True},
    })
    assert failed[0]["payload"]["properties"]["part"]["state"]["status"] == "error"


def test_user_message_and_turn_end_close_the_turn() -> None:
    translator = DshEventTranslator(SESSION)
    frames = translate(translator, "user/message", {
        "id": "msg_u1",
        "content": [{"type": "text", "text": "hi"}, {"type": "image", "url": "x"}],
        "source": {"kind": "user"},
    })
    assert [frame["payload"]["type"] for frame in frames] == ["message.updated", "message.part.updated"]
    assert frames[0]["payload"]["properties"]["info"]["role"] == "user"
    assert frames[1]["payload"]["properties"]["part"] == {
        "id": "dsh-user-msg_u1-0", "type": "text", "text": "hi",
    }

    ended = translate(translator, "turn/end", {
        "turn": 1, "reason": {"kind": "error", "error": {"message": "boom", "code": "UNKNOWN"}},
    })
    assert [frame["payload"]["type"] for frame in ended] == ["session.error", "session.status"]
    assert ended[0]["payload"]["properties"]["error"]["message"] == "boom"
    assert ended[1]["payload"]["properties"]["status"] == {"type": "idle"}


def test_compaction_and_unknown_events() -> None:
    translator = DshEventTranslator(SESSION)
    compacted = translate(translator, "compaction/summary", {"compactionId": "c1"})
    assert compacted[0]["payload"]["type"] == "session.compacted"
    assert translator.translate_event(event("step/end", {"turn": 1, "step": 1})) == []
    assert translator.translate_event(event("request/header", {"header": {}})) == []
    assert translator.translate_line("retry: 3000") == []
    assert translator.translate_line(": connected") == []
    assert translator.translate_line("data: not-json") == []


def test_live_frames_from_another_session_are_dropped() -> None:
    translator = DshEventTranslator(SESSION)
    assert translator.translate_event(event("kinship/assistant-stream", {
        "session_id": "ses_other",
        "frame": {"type": "chunk", "turn": 1, "step": 1, "chunk": {"type": "text-delta", "index": 0, "text": "x"}},
    })) == []


def test_retry_revision_resets_accumulated_text() -> None:
    translator = DshEventTranslator(SESSION)
    translate(translator, "kinship/assistant-stream", {
        "session_id": SESSION,
        "frame": {"type": "start", "attemptId": "a1", "revision": 1, "turn": 1, "step": 1},
    })
    live_chunk(translator, {"type": "text-delta", "index": 0, "text": "old"})
    # 同一 attempt 的新 revision（重试）：累积文本必须从空开始
    translate(translator, "kinship/assistant-stream", {
        "session_id": SESSION,
        "frame": {"type": "start", "attemptId": "a1", "revision": 2, "turn": 1, "step": 1},
    })
    refreshed = live_chunk(translator, {"type": "text-delta", "index": 0, "text": "new"})
    assert refreshed[0]["payload"]["properties"]["part"]["text"] == "new"
