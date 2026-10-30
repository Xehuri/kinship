# -*- coding: utf-8 -*-
"""Windows 按 PID 停止的归属证明测试（Linux 上打桩 Win32 层）。

被测链路是真实实现：``kernel_client._stop_kernel_process_windows`` +
``services.win_process``；只把 kernel32/ntdll/shell32 换成假对象。四项证明
（存活、创建时间差 <1s、cmdline 含 axeuh_kernel 且 --state-dir 一致、镜像名
python.exe/pythonw.exe）全部通过才允许
OpenProcess(PROCESS_TERMINATE) + TerminateProcess + WaitForSingleObject；
任一条件失败都不得调用 TerminateProcess。
"""
from __future__ import annotations

import ctypes
import json

import pytest

from services import kernel_client as kc
from services import win_process as wp

PID = 4242
PORT = 18080
CREATED_AT = 1700000000.0
_FILETIME_EPOCH_OFFSET_S = 11644473600


def _filetime(epoch: float) -> int:
    return int(round((epoch + _FILETIME_EPOCH_OFFSET_S) * 10_000_000))


class _FakeWin32:
    def __init__(self) -> None:
        self.memory: dict[int, bytes] = {}
        self.alive = True
        self.created_filetime = _filetime(CREATED_AT)
        self.image_path = r"C:\Python312\python.exe"
        self.calls: list[tuple[str, object]] = []
        self.handles: set[int] = set()
        self._next_handle = 100
        self.terminated = False

    def OpenProcess(self, access, inherit, pid):
        if int(pid) != PID:
            return 0
        handle = self._next_handle
        self._next_handle += 1
        self.handles.add(handle)
        self.calls.append(("OpenProcess", access))
        return handle

    def CloseHandle(self, handle):
        self.handles.discard(handle)
        self.calls.append(("CloseHandle", handle))
        return 1

    def GetExitCodeProcess(self, handle, code_ptr):
        value = 259 if self.alive else 0
        ctypes.cast(code_ptr, ctypes.POINTER(ctypes.c_ulong))[0] = value
        return 1

    def GetProcessTimes(self, handle, created, exited, kernel, user):
        ctypes.cast(created, ctypes.POINTER(ctypes.c_uint64))[0] = (
            self.created_filetime
        )
        return 1

    def QueryFullProcessImageNameW(self, handle, flags, buf, size_ptr):
        text = self.image_path
        ctypes.memmove(buf, text, (len(text) + 1) * ctypes.sizeof(ctypes.c_wchar))
        ctypes.cast(size_ptr, ctypes.POINTER(ctypes.c_uint32))[0] = len(text)
        return 1

    def TerminateProcess(self, handle, code):
        self.calls.append(("TerminateProcess", code))
        self.terminated = True
        self.alive = False
        return 1

    def WaitForSingleObject(self, handle, timeout_ms):
        self.calls.append(("WaitForSingleObject", timeout_ms))
        return 0 if self.terminated else 258

    def ReadProcessMemory(self, handle, address, buf, size, read_ptr):
        chunk = self.memory.get(int(address))
        if chunk is None:
            return 0
        ctypes.memmove(buf, chunk, min(int(size), len(chunk)))
        ctypes.cast(read_ptr, ctypes.POINTER(ctypes.c_size_t))[0] = int(size)
        return 1

    def NtQueryInformationProcess(self, handle, klass, info_ptr, size, returned):
        ctypes.cast(info_ptr, ctypes.POINTER(ctypes.c_void_p))[1] = 0x1000
        ctypes.cast(returned, ctypes.POINTER(ctypes.c_uint32))[0] = size
        return 0

    def LocalFree(self, ptr):
        return 0


def _install_command_line(fake: _FakeWin32, command_line: str) -> None:
    ptr_size = ctypes.sizeof(ctypes.c_void_p)
    peb = 0x1000
    params = 0x2000
    buffer = 0x3000
    params_offset = 0x20 if ptr_size == 8 else 0x10
    cmdline_offset = 0x70 if ptr_size == 8 else 0x40
    fake.memory[peb + params_offset] = params.to_bytes(ptr_size, "little")
    text = command_line.encode("utf-16-le")
    unicode_string = wp._UNICODE_STRING(
        Length=len(text), MaximumLength=len(text) + 2, Buffer=buffer
    )
    fake.memory[params + cmdline_offset] = bytes(unicode_string)
    fake.memory[buffer] = text


def _kernel_command_line(state_dir) -> str:
    return (
        '"C:\\Python312\\python.exe" -m axeuh_kernel --port 0 '
        '--state-dir "%s"' % state_dir
    )


def _write_pidfile(state_dir, *, created_at=CREATED_AT, include_created=True):
    data = {"pid": PID, "port": PORT, "api_version": "1.0.0", "token": "tok"}
    data["nonce"] = "nonce-1"
    if include_created:
        data["created_at"] = created_at
    (state_dir / "kernel.pid").write_text(json.dumps(data), encoding="utf-8")


def _forbid_spawn(*args, **kwargs):
    raise AssertionError("Windows 停止测试不允许 spawn 内核")


@pytest.fixture
def win_env(monkeypatch, tmp_path):
    fake = _FakeWin32()
    _install_command_line(fake, _kernel_command_line(tmp_path))
    monkeypatch.setattr(wp, "_kernel32", fake)
    monkeypatch.setattr(wp, "_ntdll", fake)
    monkeypatch.setattr(wp, "_shell32", None)
    monkeypatch.setattr(kc, "_WINDOWS", True)
    monkeypatch.setattr(kc, "_reloading", False)
    monkeypatch.setattr(kc, "_restart_depth", 0)
    # 不写 AXEUH_KERNEL_STATE_DIR（全局 env 会被其他测试残留的后台线程读到，
    # 进而真的 spawn 内核）；只钉住本进程的 state-dir 解析。
    monkeypatch.setattr(kc, "_state_dir", lambda: tmp_path)
    monkeypatch.setattr(kc, "_popen", _forbid_spawn)
    kc.reset_kernel_client()
    kc._reset_down_state()
    _write_pidfile(tmp_path)
    yield fake, tmp_path
    # 先恢复 patch 再 reset：reset 会立刻新建客户端，若此时 _state_dir 仍钉在
    # 本用例 tmp_path，残留单例会被其他测试的后台线程拿去 spawn 真内核。
    monkeypatch.undo()
    kc.reset_kernel_client()


def _count(fake: _FakeWin32, name: str) -> int:
    return sum(1 for call, _ in fake.calls if call == name)


def test_win_process_reads_cmdline_creation_time_and_image(win_env):
    fake, state_dir = win_env
    argv = wp.cmdline(PID)

    assert argv is not None
    assert "axeuh_kernel" in argv
    assert argv[0].endswith("python.exe")
    assert kc._state_dir_arg(argv) == str(state_dir)
    assert wp.creation_time(PID) == pytest.approx(CREATED_AT, abs=1e-3)
    assert wp.image_basename(PID) == "python.exe"
    assert wp.is_alive(PID) is True


def test_stop_terminates_after_full_ownership_proof(win_env):
    fake, state_dir = win_env

    result = kc.stop_kernel_process(timeout_s=0.5)

    assert result["stopped"] is True
    assert result["signal"] == "TerminateProcess"
    assert result["pid"] == PID
    assert fake.terminated is True
    assert _count(fake, "TerminateProcess") == 1
    assert _count(fake, "WaitForSingleObject") == 1
    terminate_opens = [
        access
        for call, access in fake.calls
        if call == "OpenProcess" and access == wp.PROCESS_TERMINATE
    ]
    assert terminate_opens == [wp.PROCESS_TERMINATE]
    assert not (state_dir / "kernel.pid").exists()


def test_stop_refuses_when_creation_time_differs(win_env):
    fake, state_dir = win_env
    fake.created_filetime = _filetime(CREATED_AT + 5)

    result = kc.stop_kernel_process(timeout_s=0.5)

    assert result["stopped"] is False
    assert result["reason"].startswith("ownership_unproven:")
    assert "创建时间" in result["reason"]
    assert _count(fake, "TerminateProcess") == 0
    assert _count(fake, "WaitForSingleObject") == 0
    assert (state_dir / "kernel.pid").exists()


def test_stop_refuses_when_pidfile_has_no_created_at(win_env):
    fake, state_dir = win_env
    _write_pidfile(state_dir, include_created=False)

    result = kc.stop_kernel_process(timeout_s=0.5)

    assert result["stopped"] is False
    assert result["reason"].startswith("ownership_unproven:")
    assert _count(fake, "TerminateProcess") == 0
    assert (state_dir / "kernel.pid").exists()


def test_stop_refuses_when_cmdline_is_not_kernel(win_env):
    fake, state_dir = win_env
    _install_command_line(fake, '"C:\\Python312\\python.exe" -m other_service')

    result = kc.stop_kernel_process(timeout_s=0.5)

    assert result["stopped"] is False
    assert "cmdline 不含 axeuh_kernel" in result["reason"]
    assert _count(fake, "TerminateProcess") == 0


def test_stop_refuses_when_state_dir_differs(win_env):
    fake, state_dir = win_env
    _install_command_line(fake, _kernel_command_line(state_dir / "another-state"))

    result = kc.stop_kernel_process(timeout_s=0.5)

    assert result["stopped"] is False
    assert "--state-dir" in result["reason"]
    assert _count(fake, "TerminateProcess") == 0


def test_stop_refuses_when_image_is_not_python(win_env):
    fake, state_dir = win_env
    fake.image_path = r"C:\Windows\System32\cmd.exe"

    result = kc.stop_kernel_process(timeout_s=0.5)

    assert result["stopped"] is False
    assert "python.exe" in result["reason"]
    assert _count(fake, "TerminateProcess") == 0


def test_stop_dead_pid_cleans_pidfile_without_terminate(win_env):
    fake, state_dir = win_env
    fake.alive = False

    result = kc.stop_kernel_process(timeout_s=0.5)

    assert result["stopped"] is False
    assert result["reason"] == "not-running"
    assert _count(fake, "TerminateProcess") == 0
    assert not (state_dir / "kernel.pid").exists()


def test_stop_raises_when_terminate_fails(win_env, monkeypatch):
    fake, _ = win_env

    def _boom(pid):
        raise OSError(5, "access denied")

    monkeypatch.setattr(wp, "terminate", _boom)

    with pytest.raises(kc.KernelRestartError):
        kc.stop_kernel_process(timeout_s=0.5)
    assert _count(fake, "WaitForSingleObject") == 0


def test_stop_raises_when_wait_times_out(win_env, monkeypatch):
    win_env

    monkeypatch.setattr(wp, "wait", lambda pid, timeout_s: False)

    with pytest.raises(kc.KernelRestartError):
        kc.stop_kernel_process(timeout_s=0.5)
