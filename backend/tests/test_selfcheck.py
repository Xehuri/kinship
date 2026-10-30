# -*- coding: utf-8 -*-
"""Task 10 父死亡保护测试。

Linux：用真实子进程验证 ``child_entry`` 的 PR_SET_PDEATHSIG 语义（父进程
``kill -9`` 后 2 秒内子进程消失），并用注入 ``getppid`` 覆盖"安装前父已死"
的竞态分支。Windows：不依赖 Win32，注入 mock kernel32 断言 Job Object 的
KILL_ON_JOB_CLOSE 与句柄幂等关闭。
"""
from __future__ import annotations

import ctypes
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from services.orchestrator import child_entry as ce

BACKEND_DIR = Path(__file__).resolve().parents[1]

_LINUX_ONLY = pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="PR_SET_PDEATHSIG 仅 Linux 支持",
)

_PARENT_SOURCE = '''\
import json
import subprocess
import sys
import time

backend_dir = sys.argv[1]
child_cmd = json.loads(sys.argv[2])
proc = subprocess.Popen(
    child_cmd,
    cwd=backend_dir,
    stdout=subprocess.PIPE,
    stderr=sys.stderr,
)
print(json.dumps({"event": "spawned", "child_pid": proc.pid}), flush=True)
line = proc.stdout.readline()
print(
    json.dumps(
        {
            "event": "handshake",
            "line": line.decode("utf-8", "replace").strip(),
        }
    ),
    flush=True,
)
time.sleep(60)
'''


def _readline_with_timeout(stream: Any, timeout: float) -> str:
    """从 stdout 读一行；超时/EOF 抛 AssertionError，避免测试挂死。"""
    holder: Dict[str, Any] = {}

    def _reader() -> None:
        try:
            holder["line"] = stream.readline()
        except Exception as exc:  # pragma: no cover - 读流异常直接上报
            holder["error"] = exc

    thread = threading.Thread(target=_reader, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        raise AssertionError("等待子进程输出超时(%.1fs)" % timeout)
    if "error" in holder:
        raise holder["error"]
    line = holder.get("line") or ""
    if not line:
        raise AssertionError("子进程输出提前 EOF")
    return str(line).strip()


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _kill_quietly(pid: Optional[int]) -> None:
    if not pid:
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _wait_gone(pid: int, timeout: float) -> float:
    """轮询等待 pid 消失，返回耗时；超时仍存活返回 > timeout。"""
    start = time.monotonic()
    while _pid_alive(pid):
        elapsed = time.monotonic() - start
        if elapsed >= timeout:
            return elapsed
        time.sleep(0.02)
    return time.monotonic() - start


class _FakeKernel32:
    """确定性 kernel32 替身（Linux 上运行，不触碰真实 Win32）。"""

    def __init__(self) -> None:
        self.create_calls = 0
        self.set_info_calls = 0
        self.info_class: Optional[int] = None
        self.limit_flags: Optional[int] = None
        self.job_handle = 0x11110000
        self.process_handle = 0x22220000
        self.open_process_args: Optional[tuple] = None
        self.assign_calls: List[tuple] = []
        self.close_calls: List[Any] = []

    def CreateJobObjectW(self, attrs: Any, name: Any) -> int:
        self.create_calls += 1
        return self.job_handle

    def SetInformationJobObject(
        self, job: Any, info_class: int, info_ptr: Any, size: int
    ) -> int:
        assert job == self.job_handle
        assert size == ctypes.sizeof(
            ce._JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        )
        self.set_info_calls += 1
        self.info_class = info_class
        info = ctypes.cast(
            info_ptr,
            ctypes.POINTER(ce._JOBOBJECT_EXTENDED_LIMIT_INFORMATION),
        ).contents
        self.limit_flags = info.BasicLimitInformation.LimitFlags
        return 1

    def OpenProcess(self, access: int, inherit: bool, pid: int) -> int:
        self.open_process_args = (access, inherit, pid)
        return self.process_handle

    def AssignProcessToJobObject(self, job: Any, proc: Any) -> int:
        self.assign_calls.append((job, proc))
        return 1

    def CloseHandle(self, handle: Any) -> int:
        self.close_calls.append(handle)
        return 1


def test_parse_target_preserves_arguments_verbatim() -> None:
    argv = [
        "--target",
        "/usr/bin/python3",
        "-m",
        "axeuh_kernel",
        "--state-dir",
        "/tmp/kernel state",
        "--port",
        "0",
    ]
    assert ce._parse_target(argv) == argv[1:]
    assert ce._parse_target(["--other", "x"]) is None
    assert ce._parse_target(["--target"]) is None


@_LINUX_ONLY
def test_child_entry_preserves_argv_env_and_stdio() -> None:
    """exec 原样传递 argv/env，stdout 不被 child_entry 重定向。"""
    target_code = (
        "import json,os,sys; "
        "print(json.dumps({'argv': sys.argv[1:], "
        "'token': os.environ.get('AXEUH_KERNEL_TOKEN'), "
        "'marker': os.environ.get('AXEUH_TASK10_MARKER')}), flush=True)"
    )
    env = dict(os.environ)
    env["AXEUH_KERNEL_TOKEN"] = "task10-token"
    env["AXEUH_TASK10_MARKER"] = "kept"
    cmd = [
        sys.executable,
        "-m",
        "services.orchestrator.child_entry",
        "--target",
        sys.executable,
        "-c",
        target_code,
        "--state-dir",
        "/tmp/kernel state",
        "tail-arg",
    ]
    proc = subprocess.run(
        cmd,
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout.strip())
    assert payload["argv"] == [
        "--state-dir",
        "/tmp/kernel state",
        "tail-arg",
    ]
    assert payload["token"] == "task10-token"
    assert payload["marker"] == "kept"


@_LINUX_ONLY
def test_parent_kill_terminates_child_within_two_seconds(
    tmp_path: Path,
) -> None:
    target_code = (
        "print('handshake', flush=True); import time; time.sleep(30)"
    )
    child_cmd = [
        sys.executable,
        "-m",
        "services.orchestrator.child_entry",
        "--target",
        sys.executable,
        "-c",
        target_code,
    ]
    script = tmp_path / "parent.py"
    script.write_text(_PARENT_SOURCE, encoding="utf-8")
    parent = subprocess.Popen(
        [
            sys.executable,
            "-u",
            str(script),
            str(BACKEND_DIR),
            json.dumps(child_cmd),
        ],
        cwd=str(BACKEND_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    child_pid: Optional[int] = None
    try:
        spawned = json.loads(_readline_with_timeout(parent.stdout, 15.0))
        assert spawned["event"] == "spawned"
        child_pid = int(spawned["child_pid"])
        handshake = json.loads(_readline_with_timeout(parent.stdout, 15.0))
        assert handshake["event"] == "handshake"
        assert handshake["line"] == "handshake"

        time.sleep(2.0)
        assert _pid_alive(child_pid), "父进程存活时子进程不应退出"

        os.kill(parent.pid, signal.SIGKILL)
        parent.wait(timeout=5)
        elapsed = _wait_gone(child_pid, timeout=2.0)
        assert not _pid_alive(child_pid), (
            "父进程被 kill -9 后 2 秒内子进程仍存活 pid=%s 等待=%.3fs"
            % (child_pid, elapsed)
        )
    finally:
        if parent.poll() is None:
            _kill_quietly(parent.pid)
        try:
            parent.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        _kill_quietly(child_pid)


@_LINUX_ONLY
def test_protect_parent_death_detects_parent_change() -> None:
    calls = {"install": 0}

    def _install() -> None:
        calls["install"] += 1

    sequence = iter([4242, 4242])
    assert ce.protect_parent_death(
        getppid=lambda: next(sequence), install=_install
    )
    assert calls["install"] == 1

    sequence = iter([4242, 4243])
    assert not ce.protect_parent_death(
        getppid=lambda: next(sequence), install=lambda: None
    )


@_LINUX_ONLY
def test_main_exits_without_exec_when_parent_gone_during_install() -> None:
    """竞态：安装期间父进程死亡（getppid 从 4242 变 1）-> 不 exec。"""
    state = {"ppid": 4242}
    events: List[Any] = []

    def _install() -> None:
        events.append("install")
        state["ppid"] = 1  # 模拟安装瞬间父进程已死

    def _exec(file: str, args: List[str]) -> None:
        events.append(("exec", file, args))

    rc = ce.main(
        ["--target", sys.executable, "-c", "print('must not run')"],
        getppid=lambda: state["ppid"],
        install=_install,
        exec_fn=_exec,
    )
    assert rc == 75
    assert events == ["install"]


@_LINUX_ONLY
def test_main_exits_immediately_when_parent_is_pid_one() -> None:
    exec_calls: List[Any] = []
    rc = ce.main(
        ["--target", sys.executable],
        getppid=lambda: 1,
        install=lambda: exec_calls.append("install"),
        exec_fn=lambda file, args: exec_calls.append(("exec", file)),
    )
    assert rc == 75
    assert exec_calls == []


def test_windows_job_object_kill_on_close_lifetime() -> None:
    """mock kernel32：KILL_ON_JOB_CLOSE + assign 一次 + 幂等 close。"""
    fake = _FakeKernel32()
    job = ce.create_kill_on_close_job(kernel32=fake)

    assert fake.create_calls == 1
    assert fake.set_info_calls == 1
    assert job.handle == fake.job_handle
    assert fake.info_class == ce.JOB_OBJECT_EXTENDED_LIMIT_INFORMATION
    assert fake.limit_flags == ce.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    assert ce.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0x2000

    ce.assign_process_to_job(job, 4321, kernel32=fake)
    assert fake.assign_calls == [(fake.job_handle, fake.process_handle)]
    assert fake.open_process_args == (
        ce.PROCESS_SET_QUOTA | ce.PROCESS_TERMINATE,
        False,
        4321,
    )
    # OpenProcess 出来的进程句柄由 assign 自己关闭
    assert fake.close_calls == [fake.process_handle]

    ce.close_job(job)
    assert fake.close_calls == [fake.process_handle, fake.job_handle]
    assert job.closed

    # 幂等：第二次 close 不再调用 CloseHandle
    ce.close_job(job)
    assert fake.close_calls == [fake.process_handle, fake.job_handle]


def test_windows_job_object_assign_existing_handle() -> None:
    """非 int（c_void_p 包裹的既有句柄）直接加入 job 且不关闭。"""
    fake = _FakeKernel32()
    job = ce.create_kill_on_close_job(kernel32=fake)
    existing = ctypes.c_void_p(0x33330000)
    ce.assign_process_to_job(job, existing, kernel32=fake)
    assert fake.assign_calls == [(fake.job_handle, existing)]
    assert fake.close_calls == []
    assert fake.open_process_args is None
