# -*- coding: utf-8 -*-
"""Windows 进程按 PID 查询与终止（仅 Windows 语义，POSIX 上不导入）。

本模块只被 ``kernel_client`` 的 Windows 分支惰性导入，绝不在 POSIX 启动链
上加载。所有 Win32 入口都是模块级可注入 seam（``_kernel32`` / ``_ntdll`` /
``_shell32``）：Linux 单测注入假 DLL 对象即可覆盖全部逻辑，导入模块本身
不解析任何 DLL 符号，也不依赖 ``ctypes.WinDLL`` 存在。

对外契约（归属证明的四个输入）：

- ``is_alive(pid)``       : 存活判定（PROCESS_QUERY_LIMITED_INFORMATION）
- ``creation_time(pid)``  : 进程创建时间（epoch 秒，GetProcessTimes）
- ``cmdline(pid)``        : argv 列表（NtQueryInformationProcess 读 PEB）
- ``image_basename(pid)`` : 可执行文件名（QueryFullProcessImageNameW）
- ``terminate(pid)``      : OpenProcess(PROCESS_TERMINATE) + TerminateProcess
- ``wait(pid, timeout_s)``: WaitForSingleObject

所有查询失败一律返回 ``None``/``False`` 而不是猜测：归属证明拿不到证据就
拒绝终止，避免 PID 复用导致误杀。
"""
from __future__ import annotations

import ctypes
import shlex
from typing import Any, List, Optional

PROCESS_TERMINATE = 0x0001
PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SYNCHRONIZE = 0x00100000

STILL_ACTIVE = 259
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258

# FILETIME 纪元（1601-01-01）到 Unix 纪元（1970-01-01）的秒数
_FILETIME_EPOCH_OFFSET_S = 11644473600
_FILETIME_TICKS_PER_S = 10_000_000

# PEB / RTL_USER_PROCESS_PARAMETERS 字段偏移（按目标进程指针宽度选择）
_PEB_PROCESS_PARAMETERS_OFFSET_64 = 0x20
_PEB_PROCESS_PARAMETERS_OFFSET_32 = 0x10
_PARAMS_COMMAND_LINE_OFFSET_64 = 0x70
_PARAMS_COMMAND_LINE_OFFSET_32 = 0x40
_PROCESS_BASIC_INFORMATION_CLASS = 0
_IMAGE_NAME_BUFFER_CHARS = 32768


class _FILETIME(ctypes.Structure):
    _fields_ = [
        ("dwLowDateTime", ctypes.c_uint32),
        ("dwHighDateTime", ctypes.c_uint32),
    ]


class _UNICODE_STRING(ctypes.Structure):
    _fields_ = [
        ("Length", ctypes.c_uint16),
        ("MaximumLength", ctypes.c_uint16),
        ("Buffer", ctypes.c_void_p),
    ]


class _PROCESS_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("Reserved1", ctypes.c_void_p),
        ("PebBaseAddress", ctypes.c_void_p),
        ("Reserved2_0", ctypes.c_void_p),
        ("Reserved2_1", ctypes.c_void_p),
        ("UniqueProcessId", ctypes.c_void_p),
        ("Reserved3", ctypes.c_void_p),
    ]


# 模块级 seam：单测在 Linux 上直接赋假对象；生产由 _load_* 惰性填充。
_kernel32: Any = None
_ntdll: Any = None
_shell32: Any = None


def _win_dll(name: str) -> Any:
    win_dll = getattr(ctypes, "WinDLL", None)
    if win_dll is None:
        raise OSError("win_process: 非 Windows 平台无法加载 %s" % name)
    return win_dll(name, use_last_error=True)


def _prepare_kernel32(kernel32: Any) -> Any:
    """声明 kernel32 原型（句柄必须 c_void_p，避免 64 位截断）；失败忽略。"""
    try:
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = (
            ctypes.c_uint32,
            ctypes.c_int,
            ctypes.c_uint32,
        )
        kernel32.CloseHandle.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        kernel32.GetExitCodeProcess.restype = ctypes.c_int
        kernel32.GetExitCodeProcess.argtypes = (
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_ulong),
        )
        kernel32.GetProcessTimes.restype = ctypes.c_int
        kernel32.GetProcessTimes.argtypes = (
            ctypes.c_void_p,
            ctypes.POINTER(_FILETIME),
            ctypes.POINTER(_FILETIME),
            ctypes.POINTER(_FILETIME),
            ctypes.POINTER(_FILETIME),
        )
        kernel32.QueryFullProcessImageNameW.restype = ctypes.c_int
        kernel32.QueryFullProcessImageNameW.argtypes = (
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_wchar),
            ctypes.POINTER(ctypes.c_uint32),
        )
        kernel32.ReadProcessMemory.restype = ctypes.c_int
        kernel32.ReadProcessMemory.argtypes = (
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        )
        kernel32.TerminateProcess.restype = ctypes.c_int
        kernel32.TerminateProcess.argtypes = (ctypes.c_void_p, ctypes.c_uint)
        kernel32.WaitForSingleObject.restype = ctypes.c_uint32
        kernel32.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        kernel32.LocalFree.restype = ctypes.c_void_p
        kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
    except (AttributeError, TypeError):
        pass
    return kernel32


def _prepare_ntdll(ntdll: Any) -> Any:
    try:
        ntdll.NtQueryInformationProcess.restype = ctypes.c_long
        ntdll.NtQueryInformationProcess.argtypes = (
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_uint32),
        )
    except (AttributeError, TypeError):
        pass
    return ntdll


def _prepare_shell32(shell32: Any) -> Any:
    try:
        shell32.CommandLineToArgvW.restype = ctypes.POINTER(ctypes.c_wchar_p)
        shell32.CommandLineToArgvW.argtypes = (
            ctypes.c_wchar_p,
            ctypes.POINTER(ctypes.c_int),
        )
    except (AttributeError, TypeError):
        pass
    return shell32


def _load_kernel32() -> Any:
    global _kernel32
    if _kernel32 is None:
        _kernel32 = _prepare_kernel32(_win_dll("kernel32"))
    return _kernel32


def _load_ntdll() -> Any:
    global _ntdll
    if _ntdll is None:
        _ntdll = _prepare_ntdll(_win_dll("ntdll"))
    return _ntdll


def _load_shell32() -> Any:
    global _shell32
    if _shell32 is None:
        _shell32 = _prepare_shell32(_win_dll("shell32"))
    return _shell32


def _last_error(kernel32: Any) -> int:
    try:
        getter = getattr(ctypes, "get_last_error", None)
        if getter is not None:
            return int(getter())
        return int(kernel32.GetLastError())
    except Exception:
        return 0


def _close(handle: Any) -> None:
    try:
        _load_kernel32().CloseHandle(handle)
    except Exception:
        pass


def _open_process(pid: int, access: int) -> Any:
    return _load_kernel32().OpenProcess(access, False, int(pid))


def is_alive(pid: int) -> bool:
    """进程是否存活（句柄探测；不查进程名、不发信号）。"""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    kernel32 = _load_kernel32()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        code = ctypes.c_ulong(0)
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return int(code.value) == STILL_ACTIVE
    finally:
        _close(handle)


def creation_time(pid: int) -> Optional[float]:
    """进程创建时间（epoch 秒）；打不开句柄或读取失败返回 None。"""
    kernel32 = _load_kernel32()
    handle = kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid)
    )
    if not handle:
        return None
    try:
        created = _FILETIME()
        exited = _FILETIME()
        kernel = _FILETIME()
        user = _FILETIME()
        ok = kernel32.GetProcessTimes(
            handle,
            ctypes.byref(created),
            ctypes.byref(exited),
            ctypes.byref(kernel),
            ctypes.byref(user),
        )
        if not ok:
            return None
        ticks = (int(created.dwHighDateTime) << 32) | int(created.dwLowDateTime)
        if ticks <= 0:
            return None
        return ticks / _FILETIME_TICKS_PER_S - _FILETIME_EPOCH_OFFSET_S
    finally:
        _close(handle)


def image_basename(pid: int) -> Optional[str]:
    """可执行文件名（不含目录，小写）；读取失败返回 None。"""
    kernel32 = _load_kernel32()
    handle = kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid)
    )
    if not handle:
        return None
    try:
        buf = ctypes.create_unicode_buffer(_IMAGE_NAME_BUFFER_CHARS)
        size = ctypes.c_uint32(_IMAGE_NAME_BUFFER_CHARS)
        ok = kernel32.QueryFullProcessImageNameW(
            handle, 0, buf, ctypes.byref(size)
        )
        if not ok:
            return None
        path = buf.value or ""
        if not path:
            return None
        return path.replace("/", "\\").rsplit("\\", 1)[-1].lower()
    finally:
        _close(handle)


def _read_remote(handle: Any, address: int, size: int) -> Optional[bytes]:
    kernel32 = _load_kernel32()
    buf = ctypes.create_string_buffer(max(int(size), 1))
    read = ctypes.c_size_t(0)
    ok = kernel32.ReadProcessMemory(
        handle,
        int(address),
        buf,
        int(size),
        ctypes.byref(read),
    )
    if not ok or int(read.value) != int(size):
        return None
    return buf.raw[: int(size)]


def _pointer_size() -> int:
    return ctypes.sizeof(ctypes.c_void_p)


def _strip_outer_quotes(token: str) -> str:
    if len(token) >= 2 and token[0] == token[-1] and token[0] in ('"', "'"):
        return token[1:-1]
    return token


def _split_command_line(line: str) -> Optional[List[str]]:
    """把命令行走 CommandLineToArgvW 拆成 argv；不可用时退回 shlex。

    解析失败返回 None（归属证明按“无法读取”处理，拒绝终止）。
    """
    try:
        shell32 = _load_shell32()
    except Exception:
        shell32 = None
    if shell32 is not None:
        try:
            argc = ctypes.c_int(0)
            argv = shell32.CommandLineToArgvW(
                ctypes.c_wchar_p(line), ctypes.byref(argc)
            )
            if argv:
                try:
                    return [argv[index] for index in range(argc.value)]
                finally:
                    _load_kernel32().LocalFree(argv)
        except Exception:
            pass
    try:
        tokens = shlex.split(line, posix=False)
    except ValueError:
        return None
    return [_strip_outer_quotes(token) for token in tokens]


def cmdline(pid: int) -> Optional[List[str]]:
    """读取目标进程 argv（PEB -> RTL_USER_PROCESS_PARAMETERS -> UNICODE_STRING）。

    读不到（权限/进程已退出/WOW64 布局不符）返回 None；空命令行返回 []。
    """
    kernel32 = _load_kernel32()
    ntdll = _load_ntdll()
    handle = kernel32.OpenProcess(
        PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, int(pid)
    )
    if not handle:
        return None
    try:
        info = _PROCESS_BASIC_INFORMATION()
        returned = ctypes.c_uint32(0)
        status = ntdll.NtQueryInformationProcess(
            handle,
            _PROCESS_BASIC_INFORMATION_CLASS,
            ctypes.byref(info),
            ctypes.sizeof(info),
            ctypes.byref(returned),
        )
        if status != 0 or not info.PebBaseAddress:
            return None
        ptr_size = _pointer_size()
        params_offset = (
            _PEB_PROCESS_PARAMETERS_OFFSET_64
            if ptr_size == 8
            else _PEB_PROCESS_PARAMETERS_OFFSET_32
        )
        raw = _read_remote(
            handle, int(info.PebBaseAddress) + params_offset, ptr_size
        )
        if raw is None:
            return None
        params = int.from_bytes(raw, "little")
        if not params:
            return None
        cmdline_offset = (
            _PARAMS_COMMAND_LINE_OFFSET_64
            if ptr_size == 8
            else _PARAMS_COMMAND_LINE_OFFSET_32
        )
        raw = _read_remote(
            handle, params + cmdline_offset, ctypes.sizeof(_UNICODE_STRING)
        )
        if raw is None:
            return None
        unicode_string = _UNICODE_STRING.from_buffer_copy(raw)
        length = int(unicode_string.Length or 0)
        if length <= 0 or not unicode_string.Buffer:
            return []
        raw = _read_remote(handle, int(unicode_string.Buffer), length)
        if raw is None:
            return None
        line = raw.decode("utf-16-le", errors="replace")
        return _split_command_line(line)
    finally:
        _close(handle)


def terminate(pid: int) -> bool:
    """按 PID 终止进程（调用方必须先完成归属证明）；失败抛 OSError。"""
    kernel32 = _load_kernel32()
    handle = kernel32.OpenProcess(PROCESS_TERMINATE, False, int(pid))
    if not handle:
        raise OSError(
            _last_error(kernel32),
            "OpenProcess(PROCESS_TERMINATE) failed pid=%s" % pid,
        )
    try:
        if not kernel32.TerminateProcess(handle, 1):
            raise OSError(
                _last_error(kernel32),
                "TerminateProcess failed pid=%s" % pid,
            )
        return True
    finally:
        _close(handle)


def wait(pid: int, timeout_s: float) -> bool:
    """等待进程退出；True=已退出，False=超时或无法等待。"""
    kernel32 = _load_kernel32()
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, int(pid))
    if not handle:
        # 打不开通常是进程已退出；再用存活探测确认，避免把权限问题当成功。
        return not is_alive(pid)
    try:
        timeout_ms = max(0, int(float(timeout_s) * 1000))
        return int(kernel32.WaitForSingleObject(handle, timeout_ms)) == WAIT_OBJECT_0
    finally:
        _close(handle)


__all__ = [
    "PROCESS_QUERY_INFORMATION",
    "PROCESS_QUERY_LIMITED_INFORMATION",
    "PROCESS_TERMINATE",
    "PROCESS_VM_READ",
    "STILL_ACTIVE",
    "SYNCHRONIZE",
    "WAIT_OBJECT_0",
    "WAIT_TIMEOUT",
    "cmdline",
    "creation_time",
    "image_basename",
    "is_alive",
    "terminate",
    "wait",
]
