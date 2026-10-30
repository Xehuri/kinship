# -*- coding: utf-8 -*-
"""N10 内核按 PID 安全停止/重启单测（RED 先行）。

契约：
  - 无 pidfile -> stop 返回 not stopped；restart 仍重建客户端并 ensure（全新 spawn）
  - 归属可证（cmdline 含 axeuh_kernel 且 --state-dir 指向同一目录）-> SIGTERM；
    进程退出后不再发 SIGKILL，且仅删除仍属本进程的 pidfile
  - 超时 -> 只对同一 PID 发 SIGKILL
  - cmdline 不匹配 / 解释器不符 / /proc 不可读 -> 绝不发信号，抛错
  - 停止期间 pidfile 被改写 -> 不 unlink
  - ensure 在 _reloading 期间 -> 抛 KernelUnavailable，不 spawn
  - eager 重启调用 ensure

全部打桩：绝不触碰真实内核进程或生产 pidfile。
"""
from __future__ import annotations

import json
import signal
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from services import kernel_client as kc

# 在 autouse fixture 替换 kc.KernelClient 之前捕获真实类（_reloading 守卫测试用）
_REAL_KERNEL_CLIENT = kc.KernelClient


class _FakeClient:
    """替代 KernelClient：记录 ensure 调用，并按需写 pidfile。"""

    instances: List["_FakeClient"] = []
    next_pid = 9001
    next_port = 59001
    write_pidfile_on_ensure = True

    def __init__(self) -> None:
        self._state_dir = kc._state_dir()
        self._connected = False
        self.ensure_calls = 0
        self.base_url = ""
        self.token = ""
        _FakeClient.instances.append(self)

    def ensure(self) -> None:
        self.ensure_calls += 1
        self._connected = True
        self.base_url = "http://127.0.0.1:%d" % _FakeClient.next_port
        if _FakeClient.write_pidfile_on_ensure:
            kc._write_pidfile(
                self._state_dir,
                {
                    "pid": _FakeClient.next_pid,
                    "port": _FakeClient.next_port,
                    "api_version": "test",
                    "token": "test-token",
                },
            )


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """每个用例独立 state-dir + 假客户端单例，杜绝真实 pidfile/进程。"""
    _FakeClient.instances = []
    _FakeClient.next_pid = 9001
    _FakeClient.next_port = 59001
    _FakeClient.write_pidfile_on_ensure = True
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("AXEUH_KERNEL_PYTHON", raising=False)
    monkeypatch.setattr(kc, "_reloading", False)
    monkeypatch.setattr(kc, "_restart_depth", 0)
    monkeypatch.setattr(kc, "KernelClient", _FakeClient)
    kc.reset_kernel_client()
    yield
    kc.reset_kernel_client()


def _write_link(state_dir: Path, pid: int = 4242, port: int = 18080) -> None:
    kc._write_pidfile(
        state_dir,
        {"pid": pid, "port": port, "api_version": "test", "token": "tok"},
    )


def _kernel_argv(state_dir: Path) -> List[str]:
    return [
        "/opt/kinship/.venv-kernel/bin/python",
        "-m",
        "axeuh_kernel",
        "--port",
        "0",
        "--state-dir",
        str(state_dir),
    ]


def _record_signals(monkeypatch) -> List[Dict[str, int]]:
    sent: List[Dict[str, int]] = []

    def _kill(pid: int, sig: int) -> None:
        sent.append({"pid": pid, "sig": sig})

    monkeypatch.setattr(kc.os, "kill", _kill)
    return sent


# ============================================================
# 1) 无 pidfile
# ============================================================

def test_stop_without_pidfile_returns_not_stopped(tmp_path):
    result = kc.stop_kernel_process(timeout_s=0.01)

    assert result["stopped"] is False
    assert result["reason"] == "no-pidfile"
    assert not (tmp_path / "kernel.pid").exists()


def test_restart_without_pidfile_resets_client_and_ensures(tmp_path):
    result = kc.restart_kernel(timeout_s=0.01, eager=True)

    assert result["status"] == "restarted"
    # 旧单例 + 重启重建的新单例；只有新单例 ensure 一次（恰好一个新内核）
    assert len(_FakeClient.instances) == 2
    assert [c.ensure_calls for c in _FakeClient.instances] == [0, 1]
    client = kc.get_kernel_client()
    assert client is _FakeClient.instances[-1]
    assert result["port"] == _FakeClient.next_port
    assert result["pid"] == _FakeClient.next_pid
    data = json.loads((tmp_path / "kernel.pid").read_text(encoding="utf-8"))
    assert (data["pid"], data["port"]) == (_FakeClient.next_pid, _FakeClient.next_port)


# ============================================================
# 2) SIGTERM 后正常退出：不升 SIGKILL，删除本进程 pidfile
# ============================================================

def test_stop_sigterm_exit_leaves_no_sigkill_and_removes_owned_pidfile(
    monkeypatch, tmp_path
):
    _write_link(tmp_path, pid=4242)
    sent = _record_signals(monkeypatch)
    monkeypatch.setattr(kc, "_pid_alive", lambda pid: not sent)
    monkeypatch.setattr(kc, "_proc_cmdline", lambda pid: _kernel_argv(tmp_path))
    spawn_calls: list = []

    def _no_spawn(*args, **kwargs):  # pragma: no cover - 命中即失败
        spawn_calls.append(args)
        raise AssertionError("停止路径绝不允许 spawn 替代内核")

    monkeypatch.setattr(kc, "_popen", _no_spawn)

    result = kc.stop_kernel_process(timeout_s=0.05)

    assert result == {
        "stopped": True,
        "pid": 4242,
        "signal": "SIGTERM",
        "pidfile_removed": True,
    }
    assert sent == [{"pid": 4242, "sig": signal.SIGTERM}]
    assert spawn_calls == []
    assert _FakeClient.instances and all(
        c.ensure_calls == 0 for c in _FakeClient.instances
    ), "停止路径不得 ensure/spawn 任何新内核"
    assert not (tmp_path / "kernel.pid").exists()


# ============================================================
# 3) 超时：只对同一 PID 补 SIGKILL
# ============================================================

def test_stop_timeout_escalates_to_sigkill_on_same_pid(monkeypatch, tmp_path):
    _write_link(tmp_path, pid=4243)
    sent = _record_signals(monkeypatch)

    def _alive(pid: int) -> bool:
        return not any(item["sig"] == signal.SIGKILL for item in sent)

    monkeypatch.setattr(kc, "_pid_alive", _alive)
    monkeypatch.setattr(kc, "_proc_cmdline", lambda pid: _kernel_argv(tmp_path))

    result = kc.stop_kernel_process(timeout_s=0.01)

    assert [item["sig"] for item in sent] == [signal.SIGTERM, signal.SIGKILL]
    assert all(item["pid"] == 4243 for item in sent)
    assert result["stopped"] is True
    assert result["signal"] == "SIGKILL"
    assert not (tmp_path / "kernel.pid").exists()


# ============================================================
# 4) 归属无法证明：绝不发信号
# ============================================================

@pytest.mark.parametrize(
    "argv_shape, argv0, kernel_python",
    [
        # cmdline 不含 axeuh_kernel（PID 已被复用）
        ("foreign", None, None),
        # --state-dir 指向别处（同机另一个内核实例）
        ("other_state", None, None),
        # 解释器与 AXEUH_KERNEL_PYTHON 不符
        ("kernel", "/usr/bin/python3", "/opt/kinship/.venv-kernel/bin/python"),
    ],
)
def test_stop_refuses_without_proven_ownership(
    monkeypatch, tmp_path, argv_shape, argv0, kernel_python
):
    _write_link(tmp_path, pid=4245)
    sent = _record_signals(monkeypatch)
    monkeypatch.setattr(kc, "_pid_alive", lambda pid: True)

    if argv_shape == "foreign":
        argv = ["/usr/bin/python3", "-m", "some_other_service"]
    elif argv_shape == "other_state":
        argv = _kernel_argv(tmp_path / "another-state-dir")
    else:
        argv = _kernel_argv(tmp_path)
    monkeypatch.setattr(kc, "_proc_cmdline", lambda pid: argv)
    if kernel_python is not None:
        monkeypatch.setenv("AXEUH_KERNEL_PYTHON", kernel_python)
    monkeypatch.setattr(kc, "_proc_argv0", lambda pid: argv0)

    with pytest.raises(kc.KernelRestartError):
        kc.stop_kernel_process(timeout_s=0.01)

    assert sent == []
    assert (tmp_path / "kernel.pid").exists()


def test_stop_refuses_when_proc_cmdline_unreadable(monkeypatch, tmp_path):
    _write_link(tmp_path, pid=4246)
    sent = _record_signals(monkeypatch)
    monkeypatch.setattr(kc, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(kc, "_proc_cmdline", lambda pid: None)

    with pytest.raises(kc.KernelRestartError):
        kc.stop_kernel_process(timeout_s=0.01)

    assert sent == []
    assert (tmp_path / "kernel.pid").exists()


# ============================================================
# 5) 停止期间 pidfile 被改写：不 unlink
# ============================================================

def test_stop_skips_unlink_when_pidfile_pid_changed(monkeypatch, tmp_path, caplog):
    _write_link(tmp_path, pid=4247)
    sent = _record_signals(monkeypatch)
    monkeypatch.setattr(kc, "_pid_alive", lambda pid: not sent)
    monkeypatch.setattr(kc, "_proc_cmdline", lambda pid: _kernel_argv(tmp_path))

    reads: List[Path] = []

    def _read(path: Path) -> Optional[Dict[str, Any]]:
        reads.append(path)
        if len(reads) == 1:
            return {"pid": 4247, "port": 18080}
        return {"pid": 7777, "port": 18081}

    monkeypatch.setattr(kc, "_read_pidfile", _read)

    result = kc.stop_kernel_process(timeout_s=0.05)

    assert result["stopped"] is True
    assert result.get("pidfile_removed") is False
    assert (tmp_path / "kernel.pid").exists()
    assert "不删除 pidfile" in caplog.text


# ============================================================
# 6) _reloading 期间 ensure 拒绝 spawn
# ============================================================

def test_ensure_rejects_spawn_while_reloading(monkeypatch, tmp_path):
    monkeypatch.setattr(kc, "_reloading", True)

    def _popen(*args, **kwargs):
        raise AssertionError("reloading 期间不得 spawn")

    monkeypatch.setattr(kc, "_popen", _popen)
    client = _REAL_KERNEL_CLIENT(state_dir=tmp_path)

    with pytest.raises(kc.KernelUnavailable) as excinfo:
        client.ensure()

    assert "reloading" in str(excinfo.value) or "重启" in str(excinfo.value)


# ============================================================
# 7) eager 语义
# ============================================================

def test_restart_eager_calls_ensure(monkeypatch, tmp_path):
    _write_link(tmp_path, pid=4248)
    sent = _record_signals(monkeypatch)
    monkeypatch.setattr(kc, "_pid_alive", lambda pid: not sent)
    monkeypatch.setattr(kc, "_proc_cmdline", lambda pid: _kernel_argv(tmp_path))

    result = kc.restart_kernel(timeout_s=0.05, eager=True)

    assert result["status"] == "restarted"
    client = kc.get_kernel_client()
    assert client.ensure_calls == 1
    assert result["port"] == _FakeClient.next_port
    assert result["pid"] == _FakeClient.next_pid
    assert kc._reloading is False


def test_restart_not_eager_skips_ensure(monkeypatch, tmp_path):
    _write_link(tmp_path, pid=4249)
    sent = _record_signals(monkeypatch)
    monkeypatch.setattr(kc, "_pid_alive", lambda pid: not sent)
    monkeypatch.setattr(kc, "_proc_cmdline", lambda pid: _kernel_argv(tmp_path))

    result = kc.restart_kernel(timeout_s=0.05, eager=False)

    assert result["status"] == "stopped"
    assert kc.get_kernel_client().ensure_calls == 0
    assert kc._reloading is False


def test_restart_clears_reloading_when_stop_aborts(monkeypatch, tmp_path):
    _write_link(tmp_path, pid=4250)
    sent = _record_signals(monkeypatch)
    monkeypatch.setattr(kc, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(kc, "_proc_cmdline", lambda pid: ["/usr/bin/python3", "-m", "foreign"])

    result = kc.restart_kernel(timeout_s=0.05, eager=True)

    assert result["status"] == "error"
    assert "error" in result
    assert sent == []
    assert kc._reloading is False


# ============================================================
# 8) Windows：停止已实现（四项归属证明见 test_kernel_stop_windows.py）
#    本节只锁无 pidfile 的 Windows 语义
# ============================================================

def test_stop_windows_without_pidfile(monkeypatch, tmp_path):
    monkeypatch.setattr(kc, "_WINDOWS", True)
    sent = _record_signals(monkeypatch)

    result = kc.stop_kernel_process(timeout_s=0.01)

    assert result == {"stopped": False, "reason": "no-pidfile"}
    assert sent == []


def test_restart_windows_without_pidfile_ensures_new_kernel(monkeypatch, tmp_path):
    monkeypatch.setattr(kc, "_WINDOWS", True)

    result = kc.restart_kernel(timeout_s=0.01, eager=True)

    assert result["status"] == "restarted"
    assert kc.get_kernel_client().ensure_calls == 1
