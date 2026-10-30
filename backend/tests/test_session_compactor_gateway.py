# -*- coding: utf-8 -*-
"""session_compactor 现为 04:00 提醒-only：整理信息，可压缩或不压缩。

断言（源码级）：
  - 不再调用 summarize / HTTP / Token / 后端压缩接口
  - 每天 04:00 仍触发一次，但只发送主会话提醒
  - 手动压缩后端面仍存在（移动端按钮使用）
"""
from pathlib import Path

_TASK = Path(__file__).resolve().parents[2] / "ai" / "data" / "tasks" / "session_compactor.py"


def _src() -> str:
    assert _TASK.is_file(), f"任务文件不存在: {_TASK}"
    return _TASK.read_text(encoding="utf-8")


def test_no_auto_summarize():
    src = _src()
    for needle in (
        "summarize",
        "/api/screen/session/",
        "requests",
        "backend_port",
        "Authorization",
        "Bearer",
        "RELOAD_DELAY_SECONDS",
    ):
        assert needle not in src, f"session_compactor 仍含自动压缩残留: {needle}"


def test_reminder_behavior():
    src = _src()
    assert "enabled: true" in src
    assert "now.hour == 4" in src
    assert 'context.trigger_task("会话压缩器"' in src
    assert "整理信息" in src
    assert "可以压缩会话" in src
    assert "不压缩" in src


def test_backend_manual_summarize_surface_exists():
    """手动压缩后端面仍存在，供移动端按钮使用；与 04:00 提醒任务无关。"""
    gw = (Path(__file__).resolve().parents[1] / "services" / "opencode_client.py").read_text(
        encoding="utf-8"
    )
    assert "async def summarize_session" in gw
    rt = (Path(__file__).resolve().parents[1] / "routers" / "session.py").read_text(
        encoding="utf-8"
    )
    assert '@router.post("/session/{session_id}/summarize")' in rt
