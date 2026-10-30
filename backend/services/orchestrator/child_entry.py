# -*- coding: utf-8 -*-
"""子进程父死亡保护薄入口（orchestrator 内部工具，仅 kernel / watcher 等使用）。

用法::

    python -m services.orchestrator.child_entry --target <exe> [args...]

本模块只做一件事：在**当前进程内**先安装父死亡保护，再 ``os.execvp`` 目标。
``--target`` 之后的 argv 原样传给目标（argv[0] 与全部环境变量保留，包括
``--state-dir`` 与 ``AXEUH_KERNEL_TOKEN``）；stdout/stderr 一律不重定向，内核
握手行仍由父进程从 stdout 读取。

Linux：``prctl(PR_SET_PDEATHSIG, SIGTERM)``；execve 会保留该设置（fork 出的
孙子才清除），所以 exec 后目标进程仍受保护。安装后立刻复查 ``os.getppid()``：
父进程已经消失（ppid == 1 或与安装前记录值不同）时**不 exec**，直接非零退出，
覆盖"安装前父已死"的竞态。

Windows：本入口不做自检（不调用 ``os.getppid()``）；父死亡清场由**父进程**
在 spawn 后立即创建 Job Object 完成（``create_kill_on_close_job`` +
``assign_process_to_job``，``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE``），句柄由
Orchestrator 持有，父进程退出时由内核自动清场。本模块同时导出幂等的
``JobHandle``，任务 8 负责其生命周期。

线程约束（契约，不是建议）：``PR_SET_PDEATHSIG`` 跟随的是**创建子进程的那个
父线程**，不是父进程。因此所有 spawn 必须在事件循环所在的主线程内完成，
**禁止用 ``asyncio.to_thread`` 包装 spawn**：工作线程返回后子进程会被内核
误杀。无法保证主线程 spawn 时，Windows 走父进程侧 Job Object，POSIX 需改用
独立 watchdog 方案，而不是给 spawn 加线程轮询。
"""
from __future__ import annotations

import ctypes
import os
import signal
import sys
from typing import Any, Callable, List, Optional, Sequence

PR_SET_PDEATHSIG = 1

# Windows Job Object 常量（winnt.h）
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001

_USAGE = (
    "usage: python -m services.orchestrator.child_entry "
    "--target <exe> [args...]"
)

_LIBC: Any = None
_KERNEL32: Any = None


# ─── Linux: PR_SET_PDEATHSIG ────────────────────────────────


def _load_libc() -> Any:
    """加载 libc（结果缓存）；非 Linux 平台不调用本函数。"""
    global _LIBC
    if _LIBC is None:
        try:
            _LIBC = ctypes.CDLL("libc.so.6", use_errno=True)
        except OSError:
            _LIBC = ctypes.CDLL(None, use_errno=True)
    return _LIBC


def _install_pdeathsig() -> None:
    """设置 PR_SET_PDEATHSIG=SIGTERM；失败抛 OSError。"""
    libc = _load_libc()
    libc.prctl.argtypes = [
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
    ]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(PR_SET_PDEATHSIG, int(signal.SIGTERM), 0, 0, 0) != 0:
        err = ctypes.get_errno()
        raise OSError(err or -1, "prctl(PR_SET_PDEATHSIG) failed")


def protect_parent_death(
    *,
    getppid: Optional[Callable[[], int]] = None,
    install: Optional[Callable[[], None]] = None,
) -> bool:
    """安装父死亡保护并复查父进程是否仍在；返回是否允许 exec。

    安装失败只降级告警（不阻断服务启动），但父进程消失的判定仍然生效。
    ``getppid`` / ``install`` 可注入，供单测覆盖 ppid == 1 的竞态分支。
    """
    ppid_fn = getppid or os.getppid
    parent_before = ppid_fn()
    if parent_before == 1:
        return False
    try:
        (install or _install_pdeathsig)()
    except OSError as exc:
        print(
            "child_entry: PR_SET_PDEATHSIG 设置失败，父死亡保护降级: %s" % exc,
            file=sys.stderr,
            flush=True,
        )
    parent_after = ppid_fn()
    if parent_after == 1 or parent_after != parent_before:
        return False
    return True


# ─── Windows: 父进程侧 Job Object ──────────────────────────


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _load_kernel32() -> Any:
    """加载 kernel32（仅 Windows）；非 Windows 调用直接报错。"""
    global _KERNEL32
    if _KERNEL32 is None:
        win_dll = getattr(ctypes, "WinDLL", None)
        if win_dll is None:
            raise OSError("Windows Job Object 仅在 Windows 平台可用")
        _KERNEL32 = win_dll("kernel32", use_last_error=True)
    return _KERNEL32


def _prepare_kernel32(kernel32: Any) -> Any:
    """声明 Win32 原型（句柄按 c_void_p 返回，避免 64 位截断）；失败忽略。"""
    try:
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.CreateJobObjectW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p)
        kernel32.SetInformationJobObject.restype = ctypes.c_int
        kernel32.SetInformationJobObject.argtypes = (
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
        )
        kernel32.AssignProcessToJobObject.restype = ctypes.c_int
        kernel32.AssignProcessToJobObject.argtypes = (
            ctypes.c_void_p,
            ctypes.c_void_p,
        )
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = (
            ctypes.c_uint32,
            ctypes.c_int,
            ctypes.c_uint32,
        )
        kernel32.CloseHandle.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
    except (AttributeError, TypeError):
        pass
    return kernel32


def _win_error(kernel32: Any, what: str) -> OSError:
    try:
        getter = getattr(ctypes, "get_last_error", None)
        code = int(getter()) if getter is not None else int(
            kernel32.GetLastError()
        )
    except Exception:
        code = 0
    return OSError(code, "%s failed" % what)


class JobHandle:
    """Job Object 句柄包装；``close()`` 幂等，由 Orchestrator（任务 8）持有。"""

    def __init__(self, handle: Any, *, kernel32: Any = None) -> None:
        self._handle = handle
        self._kernel32 = kernel32
        self._closed = False

    @property
    def handle(self) -> Any:
        return self._handle

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        k32 = self._kernel32 or _load_kernel32()
        k32.CloseHandle(self._handle)
        self._handle = None

    def __enter__(self) -> "JobHandle":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()


def create_kill_on_close_job(*, kernel32: Any = None) -> JobHandle:
    """创建 Job Object 并置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE，返回句柄。"""
    k32 = _prepare_kernel32(kernel32 or _load_kernel32())
    handle = k32.CreateJobObjectW(None, None)
    if not handle:
        raise _win_error(k32, "CreateJobObjectW")
    info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = (
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    )
    ok = k32.SetInformationJobObject(
        handle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        ctypes.byref(info),
        ctypes.sizeof(info),
    )
    if not ok:
        k32.CloseHandle(handle)
        raise _win_error(k32, "SetInformationJobObject")
    return JobHandle(handle, kernel32=k32)


def assign_process_to_job(
    job: Any, pid_or_handle: Any, *, kernel32: Any = None
) -> None:
    """把 pid（int）或已有进程句柄加入 Job Object。

    int 一律按 PID 处理；已打开的原始 Win32 句柄（同样是 int）需用
    ``ctypes.c_void_p(handle)`` 包裹，才能走"已有句柄"分支。
    """
    if isinstance(job, JobHandle):
        k32 = kernel32 or job._kernel32 or _load_kernel32()
        job_handle = job.handle
    else:
        k32 = kernel32 or _load_kernel32()
        job_handle = job
    k32 = _prepare_kernel32(k32)
    opened = False
    if isinstance(pid_or_handle, int):
        process_handle = k32.OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE,
            False,
            pid_or_handle,
        )
        if not process_handle:
            raise _win_error(
                k32, "OpenProcess(pid=%s)" % pid_or_handle
            )
        opened = True
    else:
        process_handle = pid_or_handle
    try:
        if not k32.AssignProcessToJobObject(job_handle, process_handle):
            raise _win_error(k32, "AssignProcessToJobObject")
    finally:
        if opened:
            k32.CloseHandle(process_handle)


def close_job(job: Any, *, kernel32: Any = None) -> None:
    """关闭 Job Object 句柄；对 JobHandle 幂等，重复调用不重复 CloseHandle。"""
    if isinstance(job, JobHandle):
        job.close()
        return
    JobHandle(job, kernel32=kernel32 or _load_kernel32()).close()


# ─── 入口 ──────────────────────────────────────────────────


def _parse_target(argv: Sequence[str]) -> Optional[List[str]]:
    """取 ``--target`` 之后的全部参数；缺失或为空返回 None。"""
    args = list(argv)
    try:
        index = args.index("--target")
    except ValueError:
        return None
    target = args[index + 1:]
    return target or None


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    getppid: Optional[Callable[[], int]] = None,
    install: Optional[Callable[[], None]] = None,
    exec_fn: Optional[Callable[[str, List[str]], Any]] = None,
) -> int:
    """薄入口：解析 argv -> 父死亡保护（Linux）-> execvp 目标。"""
    args = list(sys.argv[1:] if argv is None else argv)
    target = _parse_target(args)
    if target is None:
        print(_USAGE, file=sys.stderr, flush=True)
        return 2
    if sys.platform.startswith("linux"):
        if not protect_parent_death(getppid=getppid, install=install):
            print(
                "child_entry: 父进程已消失，拒绝 exec（竞态保护）",
                file=sys.stderr,
                flush=True,
            )
            return 75
    runner = exec_fn or os.execvp
    try:
        runner(target[0], target)
    except OSError as exc:
        print(
            "child_entry: exec 失败: %s" % exc, file=sys.stderr, flush=True
        )
        return 127
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
