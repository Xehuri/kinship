# -*- coding: utf-8 -*-
"""外层内核客户端（K2）：spawn/握手/pidfile 归属 + Bearer HTTP 请求面。

设计契约（docs/kernel-design.md §4.6/§4.7）：
  - spawn: ``python -m axeuh_kernel --port 0 --state-dir <dir>``（cwd=kernel/），
    token 只经环境变量 AXEUH_KERNEL_TOKEN 传递，绝不进 argv（命令行会进进程列表）
  - 握手: 内核 stdout 恰好输出一行 JSON ``{port, pid, api_version}``，外层读它完成对接
  - 归属: ``{state_dir}/kernel.pid`` 持久化 {port,pid,api_version,token,nonce,created_at}。
    **绝不自动复用**：pidfile 里的 pid 存活 -> 抛 ``stale_kernel_detected``（说明
    上一次外层退出时内核没被停掉，由运维显式处置）；只有 pid 已死才 spawn 新实例。
    后端在线时的运维脚本用 ``adopt_kernel(pid)`` 显式只读挂接，adopt 客户端
    ``stop()`` 为 no-op，绝不误杀非本实例进程
  - 请求: httpx base_url=http://127.0.0.1:{port} + ``Authorization: Bearer <token>``
  - 断连: 连接失败/超时 -> KernelUnavailable（路由层映射 503
    ``{"error":{"code":"state.unavailable",...}}``，封闭码见内核 errors.py）；
    内核业务错误原样抛 KernelHttpError(status, body) 透传，绝不吞、绝不改写
  - 配置: 环境变量 AXEUH_KERNEL_STATE_DIR / AXEUH_KERNEL_TOKEN；state-dir 缺省
    自 V14 起读 config.KERNEL_STATE_DIR（默认 backend/data/kernel_state，值不变）；
    token 仍为纯环境变量，不进 argv
  - 模型缓存: 显式 config kernel.model_dir 覆盖 AXEUH_KERNEL_MODEL_DIR；其余
    AXEUH_KERNEL_MODEL_DOWNLOAD_DIR / MODELSCOPE_CACHE / HF_HOME / HF_HUB_CACHE /
    HUGGINGFACE_HUB_CACHE / TRANSFORMERS_CACHE / TORCH_HOME 优先保留调用方已有的
    非空环境值，否则注入 <models_root>/.cache/...（见 services.kernel_model_paths）

spawn 与健康探针抽成模块级函数 ``_popen`` / ``_probe_health``，供单测打桩。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional
from urllib.parse import quote

import httpx

from config.paths import backend_dir, kernel_dir
from services.kernel_model_paths import apply_model_env

logger = logging.getLogger(__name__)

_KERNEL_DIR = kernel_dir()

_PIDFILE_NAME = "kernel.pid"
_HEALTH_TIMEOUT = 1.5
_CONNECT_TIMEOUT = 5.0
_DEFAULT_TIMEOUT = 30.0
# 注册/识别等重操作（模型懒加载首调可能分钟级），沿用外层原 120s 口径
HEAVY_TIMEOUT = 120.0
_HANDSHAKE_TIMEOUT_S = 120.0

# WS 流通道（T6: /v1/stream 桥接）握手探测窗口：内核鉴权失败在 accept 后
# 立即回 error 帧（回环毫秒级），0.5s 足够；健康路径无首帧 -> 超时即就绪
_WS_HANDSHAKE_TIMEOUT = 0.5
# WS TCP+升级超时（本机回环，含偶发调度延迟）
_WS_CONNECT_TIMEOUT = 5.0


# ─── 按 PID 停止/重启（N10）────────────────────────────────
# 换进程期间置位，ensure() 据此拒绝 spawn 第二实例；restart 在 finally 清零。
_reloading = False
_restart_depth = 0
_restart_lock = threading.RLock()
_WINDOWS = os.name == "nt"
_STOP_POLL_INTERVAL_S = 0.05
_SIGKILL_GRACE_S = 2.0


class KernelUnavailable(Exception):
    """内核不可达（未 spawn 成功/连接失败/超时）。

    路由层捕获后映射 HTTP 503 + ``{"error":{"code":"state.unavailable",...}}``。
    """


class KernelHttpError(Exception):
    """内核返回业务错误（4xx/5xx），body 原样透传（封闭错误码不改写）。"""

    def __init__(self, status: int, body: Any) -> None:
        self.status = status
        self.body = body
        super().__init__("kernel HTTP %s: %s" % (status, str(body)[:300]))


class KernelRestartError(RuntimeError):
    """按 PID 停止/重启内核的前置条件不满足（归属无法证明/进程杀不死）。"""


def _state_dir() -> Path:
    """内核状态根：env AXEUH_KERNEL_STATE_DIR > config.KERNEL_STATE_DIR（V14 收编）。

    config 默认 backend/data/kernel_state，与原内置缺省逐字节等价（等价断言见 V14 证据）；
    env 优先级保留在本函数——spawn 参数与 pidfile 读点语义不变。
    """
    env = os.environ.get("AXEUH_KERNEL_STATE_DIR", "").strip()
    if env:
        return Path(env)
    from config.config import get_config
    return Path(get_config().KERNEL_STATE_DIR)


def _expected_kernel_python() -> Optional[str]:
    """内核专用解释器（AXEUH_KERNEL_PYTHON）；空值返回 None（Windows/回退兼容）。"""
    return os.environ.get("AXEUH_KERNEL_PYTHON", "").strip() or None


def _proc_argv0(pid: int) -> Optional[str]:
    """读 /proc/<pid>/cmdline 的 argv0（实际启动路径）；异常/非 Linux 一律 None。"""
    if sys.platform != "linux":
        return None
    try:
        raw = Path("/proc/%d/cmdline" % pid).read_bytes()
        return raw.split(b"\0", 1)[0].decode("utf-8", errors="replace")
    except (OSError, ValueError):
        return None


def _same_path(left: str, right: str) -> bool:
    """按规范化绝对路径比较；不用 realpath（保留 venv 符号链接差异）。"""
    return os.path.normcase(os.path.normpath(os.path.abspath(left))) == os.path.normcase(
        os.path.normpath(os.path.abspath(right))
    )


def _same_interpreter(actual: str, expected: str) -> bool:
    """按规范化绝对路径比较解释器启动路径。"""
    return _same_path(actual, expected)


def _pid_alive(pid: int) -> bool:
    """进程存活探测（跨平台，不发信号、不查进程名）。

    Linux 优先读 ``/proc/<pid>/stat``：state ``Z`` 表示已退出但父进程尚未
    ``waitpid`` 回收——``os.kill(pid, 0)`` 对它仍返回成功。停止路径若把僵尸
    当活进程，会白等满 SIGTERM 超时再补无效 SIGKILL（F1 A3：12.23s/15s 预算）。
    /proc 不可用（非 Linux、权限受限）时退回 ``os.kill(pid, 0)``。
    """
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid)
        )
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/%d/stat" % pid, "rb") as handle:
                data = handle.read()
        except FileNotFoundError:
            return False
        except OSError:
            pass
        else:
            fields = data.rpartition(b")")[2].strip()
            return not fields.startswith(b"Z")
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _float_or_none(value: Any) -> Optional[float]:
    """把 pidfile 里的数值字段收敛为 float；缺失/畸形返回 None。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _posix_process_creation_time(pid: int) -> Optional[float]:
    """Linux 进程创建时间（epoch 秒）：/proc/<pid>/stat 第 22 列 + /proc/stat btime。

    第 22 列 starttime 是自开机起的时钟滴答数，按 SC_CLK_TCK 换算成秒再加
    btime。comm 字段可能含空格/括号，按最后一个 ``)`` 切分。读不到返回 None。
    """
    if sys.platform != "linux":
        return None
    try:
        raw = Path("/proc/%d/stat" % pid).read_text(encoding="utf-8", errors="replace")
        tail = raw[raw.rindex(")") + 2:].split()
        start_ticks = int(tail[19])
    except (OSError, ValueError, IndexError):
        return None
    try:
        hz = float(os.sysconf("SC_CLK_TCK"))
    except (ValueError, OSError, AttributeError):
        hz = 100.0
    boot_time = 0
    try:
        for line in Path("/proc/stat").read_text(encoding="utf-8").splitlines():
            if line.startswith("btime "):
                boot_time = int(line.split()[1])
                break
    except (OSError, ValueError):
        return None
    if boot_time <= 0 or hz <= 0:
        return None
    return boot_time + start_ticks / hz


def _process_creation_time(pid: int) -> Optional[float]:
    """进程创建时间（epoch 秒）；Windows 走 win_process，POSIX 读 /proc。"""
    if os.name == "nt":
        return _win_process().creation_time(int(pid))
    return _posix_process_creation_time(int(pid))


def _win_process() -> Any:
    """惰性导入 Windows 进程工具（POSIX 启动链绝不加载 ctypes.windll）。"""
    from services import win_process

    return win_process


def _probe_health(port: int, timeout: float = _HEALTH_TIMEOUT) -> bool:
    """GET /v1/health（免鉴权）探活内核。"""
    try:
        resp = httpx.get(
            "http://127.0.0.1:%d/v1/health" % port, timeout=timeout
        )
        return resp.status_code == 200
    except Exception:
        return False


def _spawn_creationflags() -> Dict[str, int]:
    """Windows spawn 标志（隐藏控制台 + 独立进程组）；POSIX 返回空 dict。"""
    if not _WINDOWS:
        return {}
    flags = 0
    for name in ("CREATE_NO_WINDOW", "CREATE_NEW_PROCESS_GROUP"):
        flags |= int(getattr(subprocess, name, 0) or 0)
    return {"creationflags": flags} if flags else {}


def _popen(cmd, cwd=None, env=None, **kwargs):
    """spawn 子进程（单测打桩点）；Windows 隐藏控制台并建独立进程组。"""
    if _WINDOWS and "creationflags" not in kwargs:
        kwargs.update(_spawn_creationflags())
    return subprocess.Popen(cmd, cwd=cwd, env=env, **kwargs)


async def _popen_async(cmd, cwd=None, env=None, **kwargs):
    """异步 spawn 子进程（单测打桩点）；与 ``_popen`` 同参数语义。

    必须直接调用 ``asyncio.create_subprocess_exec``，不能用
    ``asyncio.to_thread``：Linux 的 ``PR_SET_PDEATHSIG`` 跟随创建子进程的
    线程，工作线程返回后子进程会被内核误杀（见 ``child_entry`` 线程约束）。
    """
    if _WINDOWS and "creationflags" not in kwargs:
        kwargs.update(_spawn_creationflags())
    return await asyncio.create_subprocess_exec(*cmd, cwd=cwd, env=env, **kwargs)


def _apply_process_tuning(pid: int, cpus, nice: Optional[int]) -> None:
    """对刚 spawn 的内核进程做 CPU 亲和 / nice 调优（POSIX；失败只告警）。

    配置为空（cpus 空且 nice None）时零 syscall。采用 post-Popen 而非
    preexec_fn：后端是多线程进程，preexec_fn 在多线程 fork 下不安全。
    两类 syscall 各自失败互不影响，也绝不阻断后续握手。
    """
    if not cpus and nice is None:
        return
    if cpus:
        try:
            os.sched_setaffinity(pid, cpus)
        except (OSError, ValueError, AttributeError) as exc:
            logger.warning(
                "[Kernel] CPU 亲和设置失败 pid=%s cpus=%s: %s", pid, cpus, exc
            )
    if nice is not None:
        try:
            os.setpriority(os.PRIO_PROCESS, pid, int(nice))
        except (OSError, ValueError, AttributeError) as exc:
            logger.warning(
                "[Kernel] nice 设置失败 pid=%s nice=%s: %s", pid, nice, exc
            )


def _read_handshake_line(proc, timeout: float = _HANDSHAKE_TIMEOUT_S) -> bytes:
    """带超时读取内核 stdout 首行（对照 kernel/tests/test_handshake.py）。

    缺省 120s（2026-10-01 由 30s 上调）：内核冷启正常 1s 级，但机器高负载时
    python import + uvicorn bind 可超 30s，外层误判 spawn 失败会连环重 spawn
    加剧负载（09-29/09-30/10-01 三次重启毛刺同根源）。
    """
    holder: Dict[str, bytes] = {}

    def _reader() -> None:
        assert proc.stdout is not None
        holder["line"] = proc.stdout.readline()

    t = threading.Thread(target=_reader, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if t.is_alive():
        raise KernelUnavailable("等待内核握手行超时(%ss)" % timeout)
    return holder.get("line", b"")


def _parse_handshake(line: bytes) -> "tuple[int, int, str]":
    """解析握手行 -> ``(port, pid, api_version)``；非法/缺键抛 KernelUnavailable。"""
    try:
        handshake = json.loads(line.decode("utf-8").strip() or "{}")
    except (UnicodeDecodeError, ValueError) as exc:
        raise KernelUnavailable("内核握手行非法: %r" % line[:200]) from exc
    if not isinstance(handshake, dict):
        raise KernelUnavailable("内核握手行非法: %r" % line[:200])
    try:
        port = int(handshake.get("port") or 0)
        pid = int(handshake.get("pid") or 0)
    except (TypeError, ValueError) as exc:
        raise KernelUnavailable("内核握手字段非法: %r" % handshake) from exc
    api_version = str(handshake.get("api_version") or "")
    if not port or not pid:
        raise KernelUnavailable("内核握手缺少 port/pid: %r" % handshake)
    return port, pid, api_version


def _apply_tuning_from_config(pid: int) -> None:
    """按 config kernel.cpu_affinity/kernel.nice 调优刚 spawn 的进程（POSIX）。"""
    if os.name == "nt":
        return
    try:
        from config.config import get_config

        cfg = get_config()
        cpus = list(getattr(cfg, "KERNEL_CPU_AFFINITY", []) or [])
        nice = getattr(cfg, "KERNEL_NICE", None)
    except Exception as exc:
        logger.warning(
            "[Kernel] kernel.cpu_affinity/kernel.nice 配置读取失败"
            "（不调优）: %s",
            exc,
        )
        return
    _apply_process_tuning(pid, cpus, nice)


def _build_spawn_plan(
    state_dir: Path, token: str
) -> "tuple[List[str], Dict[str, str], str]":
    """构造内核 spawn 的 argv / env / 生效 token（同步与异步路径唯一真源）。

    token 只经环境变量传递，绝不进 argv；推理设备与模型缓存环境同样在此
    统一注入。两条 spawn 路径共用本函数，避免 argv/env 双实现漂移。
    """
    effective_token = (
        os.environ.get("AXEUH_KERNEL_TOKEN", "").strip()
        or token
        or secrets.token_urlsafe(32)
    )
    env = dict(os.environ)
    env["AXEUH_KERNEL_TOKEN"] = effective_token
    # 推理设备注入（cpu|gpu|auto，内核侧缺省 cpu）：外层 config kernel.device
    # 未配置时不设该键，保持内核 fail-safe 缺省。
    model_dir = ""
    try:
        from config.config import get_config

        cfg = get_config()
        dev = str(getattr(cfg, "KERNEL_DEVICE", "") or "").strip()
        if dev:
            env["AXEUH_KERNEL_DEVICE"] = dev
        cvd = str(
            getattr(cfg, "KERNEL_CUDA_VISIBLE_DEVICES", "") or ""
        ).strip()
        if cvd:
            env["CUDA_VISIBLE_DEVICES"] = cvd
        model_dir = str(getattr(cfg, "KERNEL_MODEL_DIR", "") or "").strip()
    except Exception as exc:  # 配置缺键/加载失败不阻断 spawn
        logger.warning(
            "[Kernel] kernel.device/cuda_visible_devices 配置读取失败"
            "（按内核缺省 cpu）: %s",
            exc,
        )
    # 模型缓存环境：显式 kernel.model_dir 覆盖 AXEUH_KERNEL_MODEL_DIR；
    # 其它键保留运维已设置的非空值，否则落到 <models_root>/.cache/...。
    try:
        env = apply_model_env(env, model_dir=model_dir or None)
    except Exception as exc:  # 模型根解析失败不阻断 spawn（内核仍按缺省链）
        logger.warning("[Kernel] 模型缓存环境注入失败（跳过）: %s", exc)
    # spawn 经 child_entry 包装，cwd 仍是 kernel/（内核契约）。child_entry 只
    # 依赖标准库，故按**文件路径**调用：既不需要 backend 在 sys.path 上，也不
    # 向内核环境注入 PYTHONPATH（execvp 原样传递环境）。解释器统一走
    # kernel_assets 解析链：config kernel.python > AXEUH_KERNEL_PYTHON >
    # /opt venv > 项目 .venv-kernel > 后端解释器。
    from services.kernel_assets import resolve_kernel_python

    resolved = resolve_kernel_python(project_root=_KERNEL_DIR.parent)
    kernel_python = str(resolved.get("path") or sys.executable)
    source = str(resolved.get("source") or "backend")
    if resolved.get("last_resort") and os.name != "nt":
        logger.error(
            "[Kernel] 未找到内核专用解释器（source=%s path=%s），"
            "POSIX 生产应配置 kernel.python 或 AXEUH_KERNEL_PYTHON"
            "指向内核专用 venv（否则 ML 依赖缺失，音频作业将 model.unavailable）",
            source,
            kernel_python,
        )
    else:
        logger.info(
            "[Kernel] 内核解释器 source=%s path=%s", source, kernel_python
        )
    # POSIX 父死亡保护（PR_SET_PDEATHSIG）只能由 child_entry 在 exec 前安装；
    # target 之后的 argv 原样不变，exec 保留 PID/stdout 握手。
    cmd = [
        sys.executable,
        str(backend_dir() / "services" / "orchestrator" / "child_entry.py"),
        "--target",
        kernel_python,
        "-m",
        "axeuh_kernel",
        "--port",
        "0",
        "--state-dir",
        str(state_dir),
    ]
    return cmd, env, effective_token


async def _terminate_async_child(proc: Any) -> None:
    """按精确子进程 PID 回收（SIGTERM -> 宽限 -> SIGKILL），并 wait 收尸。"""
    pid = getattr(proc, "pid", None)
    if proc.returncode is not None:
        with contextlib.suppress(Exception):
            await proc.wait()
        return
    try:
        proc.terminate()
    except (ProcessLookupError, OSError):
        pass
    try:
        await asyncio.wait_for(proc.wait(), timeout=_SIGKILL_GRACE_S)
        return
    except asyncio.TimeoutError:
        logger.warning(
            "[Kernel] pid=%s SIGTERM %.1fs 未退出，按 PID 补 SIGKILL",
            pid,
            _SIGKILL_GRACE_S,
        )
    try:
        proc.kill()
    except (ProcessLookupError, OSError):
        pass
    try:
        await asyncio.wait_for(proc.wait(), timeout=_SIGKILL_GRACE_S)
    except asyncio.TimeoutError:
        logger.error("[Kernel] pid=%s SIGKILL 后仍未确认退出", pid)


async def _abort_async_child(proc: Any) -> None:
    """spawn 失败/取消时回收子进程；shield 抵御二次取消，且绝不掩盖原异常。"""
    try:
        await asyncio.shield(_terminate_async_child(proc))
    except asyncio.CancelledError:
        logger.warning(
            "[Kernel] 取消清理期间再次被取消，pid=%s 终止转后台",
            getattr(proc, "pid", None),
        )
    except Exception as exc:
        logger.error(
            "[Kernel] 回收内核子进程 pid=%s 失败: %s",
            getattr(proc, "pid", None),
            exc,
        )


def _ensure_state_dir(state_dir: Path) -> None:
    """创建内核状态根；POSIX 收紧到 0700（失败只告警，不阻断 spawn）。"""
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "posix":
        return
    try:
        os.chmod(state_dir, 0o700)
    except OSError as exc:
        logger.warning("[Kernel] state-dir 权限收紧失败(%s): %s", state_dir, exc)


def _write_pidfile(state_dir: Path, data: Dict[str, Any]) -> None:
    """原子落 pidfile（同目录临时文件 + os.replace）；POSIX 收紧到 0600。"""
    _ensure_state_dir(state_dir)
    path = state_dir / _PIDFILE_NAME
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    if os.name == "posix":
        try:
            os.chmod(tmp, 0o600)
        except OSError as exc:
            logger.warning("[Kernel] pidfile 权限收紧失败(%s): %s", tmp, exc)
    os.replace(tmp, path)


def _read_pidfile(state_dir: Path) -> Optional[Dict[str, Any]]:
    path = state_dir / _PIDFILE_NAME
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


# pidfile 存在但无法可信解析时，ensure() 的运维指引：先确认没有遗留内核，
# 再人工删除损坏文件。自动删除/隔离会让"旧内核还活着"的线索消失。
_PIDFILE_CORRUPT_ACTION = (
    "请先确认没有 axeuh_kernel 进程在运行，然后删除该 pidfile 再重试"
)


def _pidfile_corrupt(path: Path, detail: str) -> KernelUnavailable:
    """构造 pidfile 损坏的拒绝错误（携带路径 + 可执行指引）。"""
    return KernelUnavailable(
        "pidfile_corrupt: %s (%s)；%s" % (path, detail, _PIDFILE_CORRUPT_ACTION)
    )


def _read_pidfile_strict(state_dir: Path) -> Optional[Dict[str, Any]]:
    """ensure() 专用严格读取：不存在 -> None；存在但不可信 -> 抛 KernelUnavailable。

    与 ``_read_pidfile`` 的区别只在损坏形态：后者为停止/挂接等只读路径保留
    "当作没有 pidfile" 的宽松语义；ensure 在归属不明时绝不能 spawn 第二个
    内核，故不可读/非法 JSON/非对象一律升级为 ``pidfile_corrupt``。函数本身
    不删除、不隔离、不改写 pidfile，处置权留给运维。
    """
    path = state_dir / _PIDFILE_NAME
    if not os.path.lexists(path):
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise _pidfile_corrupt(path, "无法读取: %s" % exc) from exc
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise _pidfile_corrupt(path, "JSON 解析失败: %s" % exc) from exc
    if not isinstance(data, dict):
        raise _pidfile_corrupt(
            path, "顶层类型 %s 不是 JSON 对象" % type(data).__name__
        )
    return data


class KernelStreamWs:
    """内核 ``/v1/stream`` 的 WS 句柄（T6）：aiohttp 会话随句柄生命周期。

    ``receive()`` 归一化为 ``(kind, payload)``（签名由
    backend/tests/test_kernel_client_ws.py 锁定）：

      - ``("timeout", None)`` : 传入 timeout 且窗口内无帧（健康握手无首帧）
      - ``("text", str)``     : JSON 文本帧
      - ``("binary", bytes)`` : 二进制帧（内核出站不用，保留完备）
      - ``("closed", None)``  : 连接已关闭
      - ``("error", str)``    : 传输层错误（原因字符串）

    PING/PONG 由 aiohttp autoping 自动应答，不外泄给调用方。
    ``close()`` 幂等语义由 aiohttp 保证，同时释放底层 WS 与 ClientSession
    （防“Unclosed client session”泄漏）。
    """

    def __init__(self, session: Any, ws: Any) -> None:
        self._session = session
        self._ws = ws

    @property
    def closed(self) -> bool:
        """底层 WS 是否已关闭（转发前的廉价可用性检查）。"""
        return bool(getattr(self._ws, "closed", True))

    async def send_bytes(self, data: bytes) -> None:
        await self._ws.send_bytes(data)

    async def send_json(self, payload: Dict[str, Any]) -> None:
        await self._ws.send_str(json.dumps(payload, ensure_ascii=False))

    async def receive(
        self, timeout: Optional[float] = None
    ) -> "tuple[str, Any]":
        """收一帧并归一化（见类 docstring 的 kind 枚举）。

        aiohttp ``receive(timeout)`` 超时抛 ``asyncio.TimeoutError``，此处
        折叠为 ``("timeout", None)``——握手探测依赖该语义区分“健康路径
        静默”与“对端已关”。
        """
        import aiohttp

        while True:
            try:
                msg = await self._ws.receive(timeout=timeout)
            except (asyncio.TimeoutError, TimeoutError):
                return ("timeout", None)
            except Exception as exc:  # 传输层异常全捕，折叠为 error kind
                return ("error", str(exc))
            mtype = msg.type
            if mtype == aiohttp.WSMsgType.TEXT:
                return ("text", msg.data)
            if mtype == aiohttp.WSMsgType.BINARY:
                return ("binary", bytes(msg.data))
            if mtype in (
                aiohttp.WSMsgType.CLOSE,
                aiohttp.WSMsgType.CLOSING,
                aiohttp.WSMsgType.CLOSED,
            ):
                return ("closed", None)
            if mtype == aiohttp.WSMsgType.ERROR:
                return ("error", str(self._ws.exception() or msg.data))
            # PING/PONG: autoping 已处理，继续等业务帧

    async def close(self) -> None:
        """关闭 WS 并释放 ClientSession（顺序：先 WS 后会话）。"""
        try:
            await self._ws.close()
        finally:
            try:
                await self._session.close()
            except Exception:
                pass


class KernelClient:
    """内核 HTTP 客户端：惰性 ensure() + 同步/异步请求（Bcker Bearer 头内置）。

    - ``base_url``/``token`` 显式传入且带 ``transport`` 时视为已连接（单测注入），
      不做 spawn/探活；
    - 生产路径经 ``get_kernel_client()`` 惰性单例创建，首次请求时 ensure()。
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        *,
        transport: Optional[httpx.BaseTransport] = None,
        state_dir: Optional[Path] = None,
        connected: Optional[bool] = None,
    ) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.token = token or ""
        self._transport = transport
        self._state_dir = Path(state_dir) if state_dir else _state_dir()
        # 显式给 base_url（且未要求探活）视为已连接；生产单例走 ensure()
        self._connected = (
            connected if connected is not None else bool(base_url)
        )
        self._ensure_lock = threading.Lock()
        # 事件循环内的 spawn 串行化：asyncio.Lock 绑定首个 loop，单例客户端
        # 可能跨多次 asyncio.run 复用（测试/脚本），故按 loop 惰性重建。
        self._async_lock: Optional[asyncio.Lock] = None
        self._async_lock_loop: Optional[asyncio.AbstractEventLoop] = None
        # 显式只读挂接标记：adopted 客户端的 stop() 为 no-op，绝不停止挂接的进程
        self.adopted = False
        self._adopted_pid = 0

    # ─── spawn / 归属 ─────────────────────────────────────

    def ensure(self) -> None:
        """确保本进程拥有内核：pidfile 里 pid 存活即报错，绝不自作主张接管。

        自动复用已删除（GAP-5）：外层重启后若旧内核还活着，说明上一次退出
        没走关停路径；此时静默接管会让 stop 归属、Windows 终止证明与 job
        生命周期全部失真。唯一合法入口是 spawn 新实例（pidfile 的 pid 已死），
        或运维脚本显式 ``adopt_kernel(pid)``。pidfile 存在但不可读/不可解析/
        pid 非正数时同样拒绝 spawn（``pidfile_corrupt``），因为旧内核可能仍
        活着且归属无法判断。线程安全。
        """
        if self._connected:
            return
        if _reloading:
            raise KernelUnavailable(
                "内核正在按 PID 重启（_reloading 置位），拒绝在换进程期间 spawn 第二个内核"
            )
        with self._ensure_lock:
            if self._connected:
                return
            if _reloading:
                raise KernelUnavailable(
                    "内核正在按 PID 重启（_reloading 置位），拒绝在换进程期间 spawn 第二个内核"
                )
            self._reject_foreign_pidfile()
            self._spawn()

    def _reject_foreign_pidfile(self) -> None:
        """严格 pidfile 归属检查：存活 pid 或损坏文件一律拒绝 spawn。

        同步/异步两条 ensure 共用本检查，保证"绝不 spawn 第二个内核"的
        判定只有一份实现。不删除、不隔离、不改写 pidfile，处置权留给运维。
        """
        link = _read_pidfile_strict(self._state_dir)
        if link is None:
            return
        pid = _int_or_zero(link.get("pid"))
        if pid <= 0:
            logger.error(
                "[Kernel] pidfile_corrupt: %s 记录的 pid=%r 不是正整数；"
                "旧内核可能仍在运行，拒绝 spawn 第二个实例",
                self._state_dir / _PIDFILE_NAME,
                link.get("pid"),
            )
            raise _pidfile_corrupt(
                self._state_dir / _PIDFILE_NAME,
                "pid=%r 不是正整数" % (link.get("pid"),),
            )
        if _pid_alive(pid):
            logger.error(
                "[Kernel] stale_kernel_detected: pidfile 记录了存活内核 pid=%s"
                "（state-dir=%s），但本进程没有接管它。自动复用已移除；"
                "请按 PID 停止该进程后重启后端，或用 adopt_kernel(pid) 只读挂接",
                pid,
                self._state_dir,
            )
            raise KernelUnavailable("stale_kernel_detected: pid=%s" % pid)
        logger.warning(
            "[Kernel] pidfile 陈旧(pid=%s 不存活)，重新 spawn", pid
        )

    async def ensure_async(self) -> None:
        """``ensure()`` 的异步等价：spawn 与握手全程不阻塞事件循环。

        前置条件与同步路径逐项一致（``_connected`` 快速返回、``_reloading``
        拒绝、严格 pidfile 归属检查）。``asyncio.Lock`` 串行化同一事件循环内
        的并发调用，锁内二次检查 ``_connected`` 保证只 spawn 一次。

        spawn 走 ``_popen_async``（asyncio.create_subprocess_exec），不用
        ``asyncio.to_thread``：``PR_SET_PDEATHSIG`` 跟随创建子进程的线程。
        """
        if self._connected:
            return
        if _reloading:
            raise KernelUnavailable(
                "内核正在按 PID 重启（_reloading 置位），拒绝在换进程期间 spawn 第二个内核"
            )
        async with self._async_ensure_lock():
            if self._connected:
                return
            if _reloading:
                raise KernelUnavailable(
                    "内核正在按 PID 重启（_reloading 置位），拒绝在换进程期间 spawn 第二个内核"
                )
            self._reject_foreign_pidfile()
            await self._spawn_async()

    def _async_ensure_lock(self) -> asyncio.Lock:
        """取当前事件循环绑定的异步 spawn 锁（跨 loop 复用时重建）。"""
        loop = asyncio.get_running_loop()
        if self._async_lock is None or self._async_lock_loop is not loop:
            self._async_lock = asyncio.Lock()
            self._async_lock_loop = loop
        return self._async_lock

    def _spawn(self) -> None:
        state_dir = self._state_dir
        _ensure_state_dir(state_dir)
        self._seed_state_from_outer(state_dir)
        cmd, env, token = _build_spawn_plan(state_dir, self.token)
        stderr_log = open(state_dir / "kernel.stderr.log", "ab")
        try:
            proc = _popen(
                cmd,
                cwd=str(_KERNEL_DIR),
                env=env,
                stdout=subprocess.PIPE,
                stderr=stderr_log,
            )
            _apply_tuning_from_config(proc.pid)
            line = _read_handshake_line(proc)
        finally:
            stderr_log.close()
        port, pid, api_version = _parse_handshake(line)
        self._finish_spawn(port, pid, api_version, token)

    async def _spawn_async(self) -> None:
        state_dir = self._state_dir
        _ensure_state_dir(state_dir)
        self._seed_state_from_outer(state_dir)
        cmd, env, token = _build_spawn_plan(state_dir, self.token)
        stderr_log = open(state_dir / "kernel.stderr.log", "ab")
        try:
            proc = await _popen_async(
                cmd,
                cwd=str(_KERNEL_DIR),
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=stderr_log,
            )
        finally:
            stderr_log.close()
        _apply_tuning_from_config(proc.pid)
        try:
            stdout = proc.stdout
            if stdout is None:
                raise KernelUnavailable("内核子进程 stdout 未接通（握手中断）")
            try:
                line = await asyncio.wait_for(
                    stdout.readline(), timeout=_HANDSHAKE_TIMEOUT_S
                )
            except asyncio.TimeoutError:
                raise KernelUnavailable(
                    "等待内核握手行超时(%ss)" % _HANDSHAKE_TIMEOUT_S
                ) from None
            if not line:
                code = proc.returncode
                if code is None:
                    try:
                        code = await asyncio.wait_for(proc.wait(), timeout=1.0)
                    except asyncio.TimeoutError:
                        code = None
                raise KernelUnavailable(
                    "内核在握手前退出(stdout EOF, exit=%s)" % code
                )
            port, pid, api_version = _parse_handshake(line)
            if pid != proc.pid:
                logger.warning(
                    "[Kernel] 握手 pid=%s 与子进程 pid=%s 不一致（按子进程回收）",
                    pid,
                    proc.pid,
                )
            try:
                self._finish_spawn(port, pid, api_version, token)
            except OSError as exc:
                raise KernelUnavailable("pidfile 写入失败: %s" % exc) from exc
        except BaseException:
            await _abort_async_child(proc)
            raise

    def _finish_spawn(
        self, port: int, pid: int, api_version: str, token: str
    ) -> None:
        """握手成功后落 pidfile 并标记已连接（同步/异步唯一实现）。

        ``nonce`` 每次 spawn 唯一（运维/审计可区分同一 state-dir 的历史
        实例）；``created_at`` 是子进程真实创建时间，Windows 终止前与
        GetProcessTimes 比对是归属证明的一环。读不到（容器/权限）时退化为
        握手时刻，其余三项仍把关。
        """
        nonce = secrets.token_hex(16)
        created_at = _process_creation_time(pid)
        if created_at is None:
            created_at = time.time()
            logger.warning(
                "[Kernel] 无法读取 pid=%s 的创建时间，pidfile 记录握手时刻 %.3f",
                pid,
                created_at,
            )
        _write_pidfile(self._state_dir, {
            "port": port,
            "pid": pid,
            "api_version": api_version,
            "token": token,
            "nonce": nonce,
            "created_at": created_at,
        })
        self.base_url = "http://127.0.0.1:%d" % port
        self.token = token
        self._connected = True
        logger.info(
            "[Kernel] spawn 完成 port=%s pid=%s api_version=%s", port, pid, api_version
        )

    def stop(self) -> Dict[str, Any]:
        """停止本客户端管理的内核；adopt 客户端 no-op，绝不停止挂接的进程。"""
        if self.adopted:
            return {
                "stopped": False,
                "reason": "adopted",
                "pid": self._adopted_pid,
            }
        return stop_kernel_process()

    @staticmethod
    def _seed_state_from_outer(state_dir: Path) -> None:
        """首启播种（契约 §15-W3，登记于 kernel-contract.md L95）：历史数据一次性引导。

        仅当内核侧目标缺失且外层**历史**文件存在时 copy2——V10（2026-10-08）
        外层注册库镜像退役后，外层 voiceprints.json 不再被写入（冻结的历史
        档案），本播种自此只在首部署/内核 state 丢失时生效，此后内核侧为
        唯一真相源。注册库/cohort 的读方全部走 HTTP 契约面（§7.6 registry /
        cohort 端点），跨进程直读 state-dir 的 W1 野生通道已根除。
        """
        import shutil

        try:
            from config.config import get_config

            pairs = []
            # 注册表: 外层历史 voiceprints.json -> {state}/voiceprints/voiceprints.json
            outer_vp = Path(get_config().VOICEPRINTS_PATH)
            kernel_vp = state_dir / "voiceprints" / "voiceprints.json"
            pairs.append((outer_vp, kernel_vp))
            # cohort 池: <AI_ROOT>/data/cache/cohort_active.jsonl -> {state}/voiceprint/
            outer_cohort = (
                Path(get_config().AI_ROOT) / "data" / "cache" / "cohort_active.jsonl"
            )
            kernel_cohort = state_dir / "voiceprint" / "cohort_active.jsonl"
            pairs.append((outer_cohort, kernel_cohort))
        except Exception as exc:  # 配置缺键不阻断 spawn（内核可空库启动）
            logger.warning("[Kernel] 播种源解析失败（跳过播种）: %s", exc)
            return
        for src, dst in pairs:
            try:
                if dst.exists() or not src.is_file():
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                logger.info("[Kernel] 状态播种: %s -> %s", src, dst)
            except OSError as exc:
                logger.warning("[Kernel] 状态播种失败 %s: %s", dst, exc)

    def available(self, timeout: float = _HEALTH_TIMEOUT) -> bool:
        """GET /v1/health 探活（供预览等入口判断降级；断连只记一次日志）。"""
        try:
            self.srequest("GET", "/v1/health", timeout=timeout)
            return True
        except KernelUnavailable as exc:
            log_down_once(str(exc))
            return False
        except KernelHttpError:
            return False

    # ─── 请求面 ───────────────────────────────────────────

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": "Bearer %s" % self.token}

    @staticmethod
    def _raise_for(resp: httpx.Response) -> Any:
        try:
            body: Any = resp.json()
        except Exception:
            body = {"error": {"code": "state.unavailable",
                              "message": resp.text[:200],
                              "retryable": True}}
        if resp.status_code >= 400:
            raise KernelHttpError(resp.status_code, body)
        return body

    def srequest(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Dict[str, Any]] = None,
        timeout: float = _DEFAULT_TIMEOUT,
    ) -> Any:
        """同步请求（管线/预览在工作线程与线程池中调用）。"""
        self.ensure()
        try:
            with httpx.Client(
                base_url=self.base_url,
                headers=self._headers(),
                transport=self._transport,
                timeout=httpx.Timeout(timeout, connect=_CONNECT_TIMEOUT),
            ) as client:
                resp = client.request(method, path, json=json)
        except httpx.HTTPError as exc:
            raise KernelUnavailable("%s %s 失败: %s" % (method, path, exc)) from exc
        return self._raise_for(resp)

    async def arequest(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Dict[str, Any]] = None,
        timeout: float = _DEFAULT_TIMEOUT,
    ) -> Any:
        """异步请求（async 路由调用；ensure 的阻塞部分丢线程池）。"""
        if not self._connected:
            await asyncio.to_thread(self.ensure)
        try:
            async with httpx.AsyncClient(
                base_url=self.base_url,
                headers=self._headers(),
                transport=self._transport,
                timeout=httpx.Timeout(timeout, connect=_CONNECT_TIMEOUT),
            ) as client:
                resp = await client.request(method, path, json=json)
        except httpx.HTTPError as exc:
            raise KernelUnavailable("%s %s 失败: %s" % (method, path, exc)) from exc
        return self._raise_for(resp)

    # ─── WS 流通道（T6: /v1/stream 桥接，KWS 上移内核） ─────

    def stream_ws_url(self) -> str:
        """构造内核流 WS 地址：base_url 换 ws scheme + ``/v1/stream?token=``。

        - ``http://`` -> ``ws://``，``https://`` -> ``wss://``（其余原样）
        - token 走 query（内核端点自校验契约，见 kernel stream/router.py）
        - **token 绝不写日志**；调用方日志必须截断/脱敏
        """
        base = (self.base_url or "").rstrip("/")
        if base.startswith("https://"):
            ws_base = "wss://" + base[len("https://"):]
        elif base.startswith("http://"):
            ws_base = "ws://" + base[len("http://"):]
        else:
            ws_base = base
        return "%s/v1/stream?token=%s" % (ws_base, quote(self.token or "", safe=""))

    def _scrub_token(self, text: str) -> str:
        """日志脱敏：抹掉内核 token 明文并截断（禁把 token 写进日志）。"""
        tok = self.token or ""
        if tok and tok in text:
            text = text.replace(tok, "***")
        return text[:200]

    async def ws_connect_stream(
        self, *, timeout: float = _WS_HANDSHAKE_TIMEOUT
    ) -> Optional[KernelStreamWs]:
        """连接内核 WS ``/v1/stream`` 并做握手探测（aiohttp；httpx 无 WS）。

        行为（签名由 backend/tests/test_kernel_client_ws.py 锁定）：

        - 复用现有 ``ensure()``/``base_url``/``token``/pidfile：未连接时把
          ensure 的阻塞部分丢线程池（``asyncio.to_thread``）
        - **不带 Origin 头**：内核 ``check_origin`` 非空一律拒；aiohttp 不传
          ``origin`` 参数即不发 Origin（显式传 ``headers={}`` 兜底）
        - 握手探测：内核鉴权失败在 accept 后立即回 error 帧再 close1008 ->
          收到 error 帧返回 ``None``（**降级信号**）；健康路径首帧静默 ->
          ``("timeout", None)`` 视为就绪；传输错误/半关同样 ``None``
        - 全程 fail-open 不抛：与 HTTP 面 ``KernelUnavailable`` -> 503 降级
          同一哲学——WS 桥接方拿到 ``None`` 即回本地路径
        - ``ensure()`` 可能触发 spawn（秒级）：需要总预算的调用方在外层
          ``asyncio.wait_for`` 包本方法（桥接侧预算 5s）
        - ``timeout`` 只作用于握手探测窗口；TCP+升级固定 ``_WS_CONNECT_TIMEOUT``
        """
        if not self._connected:
            await asyncio.to_thread(self.ensure)
        if not self.base_url or not self.token:
            logger.warning("[Kernel] WS 流地址/token 未就绪，不可用（降级）")
            return None
        url = self.stream_ws_url()
        try:
            import aiohttp
        except Exception as exc:
            logger.warning("[Kernel] aiohttp 不可用，WS 流通道降级: %s", exc)
            return None
        session: Any = None
        try:
            session = aiohttp.ClientSession()
            raw = await asyncio.wait_for(
                # headers={} 双保险：不发 Origin（内核非空 Origin 一律拒）
                session.ws_connect(url, headers={}),
                timeout=_WS_CONNECT_TIMEOUT,
            )
            conn = KernelStreamWs(session, raw)
            session = None  # 所有权转交 conn.close()
        except Exception as exc:
            logger.warning(
                "[Kernel] /v1/stream WS 连接失败（降级）: %s: %s",
                type(exc).__name__, self._scrub_token(str(exc)),
            )
            return None
        finally:
            if session is not None:
                try:
                    await session.close()
                except Exception:
                    pass
        # 握手探测：健康路径首帧静默（内核 start 前不主动发帧）
        kind, data = await conn.receive(timeout=timeout)
        if kind == "timeout":
            return conn
        if kind == "text":
            parsed: Any = None
            try:
                parsed = json.loads(data)
            except (TypeError, ValueError):
                parsed = None
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
                err = parsed["error"]
                logger.warning(
                    "[Kernel] /v1/stream 握手被拒 code=%s（降级）",
                    err.get("code"),
                )
                await conn.close()
                return None
            logger.debug(
                "[Kernel] /v1/stream 握手非常规首帧已忽略: %s",
                self._scrub_token(str(data)),
            )
            return conn
        logger.warning(
            "[Kernel] /v1/stream 握手传输失败 kind=%s（降级）", kind
        )
        await conn.close()
        return None


# ─── 进程内单例 ────────────────────────────────────────────

_client: Optional[KernelClient] = None
_client_lock = threading.Lock()

# 内核断连“只记一次”状态（管线打分降级用；测试经 _reset_down_state 复位）
_down_logged = False
_down_lock = threading.Lock()


def log_down_once(reason: str) -> bool:
    """内核断连日志去重：每个进程周期只记一次 WARNING。

    Returns:
        True 表示本次是首次断连（调用方记日志），False 表示已记过。
    """
    global _down_logged
    with _down_lock:
        if _down_logged:
            return False
        _down_logged = True
        logger.warning(
            "[Kernel] 内核不可达，评分/查询降级跳过（只记一次）: %s", reason
        )
        return True


def _reset_down_state() -> None:
    """复位断连日志状态（测试隔离用）。"""
    global _down_logged
    with _down_lock:
        _down_logged = False


def get_kernel_client(reset: bool = False) -> KernelClient:
    """惰性单例（线程安全）；reset=True 仅供单测重建。"""
    global _client
    with _client_lock:
        if reset:
            _client = None
        if _client is None:
            _client = KernelClient()
        return _client


def reset_kernel_client() -> None:
    """丢弃单例（测试收尾/进程内重启语义）。"""
    get_kernel_client(reset=True)


# ─── 安全停止 / 重启（N10）────────────────────────────────

@contextlib.contextmanager
def _reload_window() -> Iterator[None]:
    """标记内核换进程窗口：ensure() 期间拒绝 spawn 第二实例。"""
    global _reloading, _restart_depth
    with _restart_lock:
        _restart_depth += 1
        _reloading = True
    try:
        yield
    finally:
        with _restart_lock:
            _restart_depth = max(0, _restart_depth - 1)
            _reloading = _restart_depth > 0


def _clear_reloading() -> None:
    global _reloading, _restart_depth
    with _restart_lock:
        _restart_depth = 0
        _reloading = False


def _int_or_zero(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _proc_cmdline(pid: int) -> Optional[List[str]]:
    """读 /proc/<pid>/cmdline 全量 argv；非 Linux/不可读返回 None。"""
    if sys.platform != "linux":
        return None
    try:
        raw = Path("/proc/%d/cmdline" % pid).read_bytes()
    except (OSError, ValueError):
        return None
    return [
        part.decode("utf-8", errors="replace")
        for part in raw.split(b"\0")
        if part
    ]


def _state_dir_arg(argv: List[str]) -> Optional[str]:
    for index, arg in enumerate(argv[:-1]):
        if arg == "--state-dir":
            return argv[index + 1]
    return None


def _verify_kernel_ownership(pid: int, state_dir: Path) -> None:
    """证明 pid 属于 state_dir 的内核进程；任何不确定都抛错，绝不发信号。"""
    argv = _proc_cmdline(pid)
    if argv is None:
        raise KernelRestartError(
            "无法读取 /proc/%d/cmdline，无法证明该 PID 属于内核，拒绝发送信号" % pid
        )
    if not any("axeuh_kernel" in arg for arg in argv):
        raise KernelRestartError(
            "pid=%d 的 cmdline 不含 axeuh_kernel（PID 可能已被复用），拒绝发送信号"
            % pid
        )
    actual_state_dir = _state_dir_arg(argv)
    if actual_state_dir is None or not _same_path(actual_state_dir, str(state_dir)):
        raise KernelRestartError(
            "pid=%d 的 --state-dir=%r 与期望 %s 不符，拒绝发送信号"
            % (pid, actual_state_dir, state_dir)
        )
    expected_python = _expected_kernel_python()
    if expected_python is None:
        return
    actual_argv0 = _proc_argv0(pid)
    if actual_argv0 is None:
        raise KernelRestartError(
            "无法读取 pid=%d 的 argv0，无法校验 AXEUH_KERNEL_PYTHON，拒绝发送信号"
            % pid
        )
    if not _same_interpreter(actual_argv0, expected_python):
        raise KernelRestartError(
            "pid=%d 解释器不符：expected=%s actual=%s，拒绝发送信号"
            % (pid, expected_python, actual_argv0)
        )


def _wait_pid_gone(pid: int, timeout_s: float) -> bool:
    deadline = time.monotonic() + max(float(timeout_s), 0.0)
    while True:
        if not _pid_alive(pid):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(_STOP_POLL_INTERVAL_S)


def _unlink_pidfile_if_owned(state_dir: Path, pid: int) -> bool:
    current = _read_pidfile(state_dir)
    if current is None:
        return False
    current_pid = _int_or_zero(current.get("pid"))
    if current_pid != pid:
        logger.warning(
            "[Kernel] 停止期间 pidfile 被改写（期望 pid=%s 实际=%s），不删除 pidfile",
            pid,
            current_pid,
        )
        return False
    try:
        (state_dir / _PIDFILE_NAME).unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as exc:
        logger.warning(
            "[Kernel] 删除 pidfile 失败 %s: %s", state_dir / _PIDFILE_NAME, exc
        )
        return False


def _port_from_base_url(base_url: str) -> int:
    prefix = "http://127.0.0.1:"
    if not base_url.startswith(prefix):
        return 0
    try:
        return int(base_url[len(prefix):])
    except ValueError:
        return 0


_WINDOWS_KERNEL_IMAGES = frozenset({"python.exe", "pythonw.exe"})
_WINDOWS_OWNERSHIP_SKEW_S = 1.0


def _windows_ownership_failure(
    winproc: Any, pid: int, link: Dict[str, Any], state_dir: Path
) -> Optional[str]:
    """Windows 终止前的四项归属证明；返回失败原因，全部通过返回 None。

    证明 = 存活（调用方已查） ∧ 创建时间与 pidfile created_at 差 <1s ∧
    cmdline 含 ``axeuh_kernel`` 且 ``--state-dir`` 指向同一目录 ∧ 镜像名属于
    {python.exe, pythonw.exe}。任一项拿不到证据都按失败处理——Windows 没有
    /proc 的 pid 强绑定，缺证据时 TerminateProcess 可能杀掉复用同一 PID 的
    无关进程。
    """
    recorded = _float_or_none(link.get("created_at"))
    if recorded is None:
        return "pidfile 缺少有效的 created_at"
    actual = _float_or_none(winproc.creation_time(pid))
    if actual is None:
        return "无法读取进程创建时间"
    if abs(actual - recorded) >= _WINDOWS_OWNERSHIP_SKEW_S:
        return "创建时间不符 actual=%.3f recorded=%.3f" % (actual, recorded)
    argv = winproc.cmdline(pid)
    if argv is None:
        return "无法读取进程 cmdline"
    if not any("axeuh_kernel" in str(arg) for arg in argv):
        return "cmdline 不含 axeuh_kernel"
    actual_state_dir = _state_dir_arg(list(argv))
    if actual_state_dir is None or not _same_path(actual_state_dir, str(state_dir)):
        return "--state-dir 不符 actual=%r expected=%s" % (
            actual_state_dir,
            state_dir,
        )
    image = str(winproc.image_basename(pid) or "").strip().lower()
    if image not in _WINDOWS_KERNEL_IMAGES:
        return "镜像名 %r 不在 python.exe/pythonw.exe" % image
    return None


def _stop_kernel_process_windows(*, timeout_s: float) -> Dict[str, Any]:
    """Windows 按 PID 停止：先证明归属，再 TerminateProcess + WaitForSingleObject。"""
    winproc = _win_process()
    state_dir = get_kernel_client()._state_dir
    link = _read_pidfile(state_dir)
    pid = _int_or_zero((link or {}).get("pid"))
    if link is None or pid <= 0:
        return {"stopped": False, "reason": "no-pidfile"}
    if not winproc.is_alive(pid):
        removed = _unlink_pidfile_if_owned(state_dir, pid)
        reset_kernel_client()
        _reset_down_state()
        logger.info(
            "[Kernel] pid=%s 已不在，清理陈旧 pidfile removed=%s", pid, removed
        )
        return {
            "stopped": False,
            "reason": "not-running",
            "pid": pid,
            "pidfile_removed": removed,
        }
    failure = _windows_ownership_failure(winproc, pid, link, state_dir)
    if failure is not None:
        logger.error(
            "[Kernel] 拒绝终止 Windows 内核 pid=%s：归属无法证明（%s）",
            pid,
            failure,
        )
        return {
            "stopped": False,
            "reason": "ownership_unproven: %s" % failure,
            "pid": pid,
        }
    try:
        winproc.terminate(pid)
    except OSError as exc:
        raise KernelRestartError(
            "pid=%d TerminateProcess 失败: %s" % (pid, exc)
        ) from exc
    if not winproc.wait(pid, timeout_s):
        raise KernelRestartError(
            "pid=%d TerminateProcess 后 %.1fs 仍未退出，无法安全重启"
            % (pid, timeout_s)
        )
    removed = _unlink_pidfile_if_owned(state_dir, pid)
    reset_kernel_client()
    _reset_down_state()
    logger.info(
        "[Kernel] 内核已停止 pid=%s signal=TerminateProcess pidfile_removed=%s",
        pid,
        removed,
    )
    return {
        "stopped": True,
        "pid": pid,
        "signal": "TerminateProcess",
        "pidfile_removed": removed,
    }


def _stop_kernel_process_locked(*, timeout_s: float) -> Dict[str, Any]:
    if _WINDOWS:
        return _stop_kernel_process_windows(timeout_s=timeout_s)
    state_dir = get_kernel_client()._state_dir
    link = _read_pidfile(state_dir)
    pid = _int_or_zero((link or {}).get("pid"))
    if link is None or pid <= 0:
        return {"stopped": False, "reason": "no-pidfile"}
    if not _pid_alive(pid):
        removed = _unlink_pidfile_if_owned(state_dir, pid)
        reset_kernel_client()
        _reset_down_state()
        logger.info(
            "[Kernel] pid=%s 已不在，清理陈旧 pidfile removed=%s", pid, removed
        )
        return {
            "stopped": False,
            "reason": "not-running",
            "pid": pid,
            "pidfile_removed": removed,
        }
    _verify_kernel_ownership(pid, state_dir)
    signal_name = "SIGTERM"
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if not _wait_pid_gone(pid, timeout_s):
        signal_name = "SIGKILL"
        logger.warning(
            "[Kernel] pid=%s SIGTERM %.1fs 未退出，按 PID 补 SIGKILL", pid, timeout_s
        )
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if not _wait_pid_gone(
            pid, min(_SIGKILL_GRACE_S, max(float(timeout_s), _STOP_POLL_INTERVAL_S))
        ):
            raise KernelRestartError("pid=%d SIGKILL 后仍未退出，无法安全重启" % pid)
    removed = _unlink_pidfile_if_owned(state_dir, pid)
    reset_kernel_client()
    _reset_down_state()
    logger.info(
        "[Kernel] 内核已停止 pid=%s signal=%s pidfile_removed=%s",
        pid,
        signal_name,
        removed,
    )
    return {
        "stopped": True,
        "pid": pid,
        "signal": signal_name,
        "pidfile_removed": removed,
    }


def adopt_kernel(pid: int) -> Dict[str, Any]:
    """显式只读挂接一个已在运行的内核（不 spawn、不停止、不改 pidfile）。

    供后端在线时运行的运维脚本（cohort 重建等）使用：脚本进程调用本函数后，
    共享单例的 base_url/token 指向既有内核，后续 HTTP 请求直接可用；同时
    ``adopted=True`` 让 ``stop``/``restart`` 对该客户端 no-op，脚本退出时绝不
    误杀后端正在使用的内核。端口/token 只来自同一 state-dir 的 pidfile，pid
    必须匹配；任何不确定都抛 ``KernelUnavailable``，绝不猜测。
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError) as exc:
        raise KernelUnavailable("adopt_kernel: 非法 pid=%r" % (pid,)) from exc
    if pid <= 0:
        raise KernelUnavailable("adopt_kernel: 非法 pid=%s" % pid)
    if not _pid_alive(pid):
        raise KernelUnavailable("adopt_kernel: pid=%s 不存活" % pid)
    state_dir = _state_dir()
    link = _read_pidfile(state_dir) or {}
    file_pid = _int_or_zero(link.get("pid"))
    port = _int_or_zero(link.get("port"))
    if link.get("pid") is None or file_pid != pid or port <= 0:
        raise KernelUnavailable(
            "adopt_kernel: pidfile 与 pid=%s 不匹配（pidfile pid=%s port=%s）"
            % (pid, file_pid, port)
        )
    token = str(link.get("token") or "")
    healthy = _probe_health(port)
    client = get_kernel_client()
    with client._ensure_lock:
        client.base_url = "http://127.0.0.1:%d" % port
        client.token = token
        client._connected = True
        client.adopted = True
        client._adopted_pid = pid
    logger.info(
        "[Kernel] adopt 内核 pid=%s port=%s healthy=%s（只读挂接：不 spawn 不停止）",
        pid,
        port,
        healthy,
    )
    return {
        "pid": pid,
        "port": port,
        "adopted": True,
        "healthy": healthy,
        "api_version": link.get("api_version"),
        "nonce": link.get("nonce"),
        "created_at": link.get("created_at"),
    }


def stop_kernel_process(*, timeout_s: float = 10.0) -> Dict[str, Any]:
    """按 PID 安全停止内核（POSIX SIGTERM -> SIGKILL；Windows 归属证明后终止）。

    POSIX 归属无法证明（cmdline/state-dir/解释器不符）时抛 KernelRestartError
    且不发信号；Windows 归属证明失败返回 ``ownership_unproven`` 并拒绝终止。
    adopt 客户端为 no-op（reason=adopted）。
    """
    client = get_kernel_client()
    if getattr(client, "adopted", False):
        logger.info(
            "[Kernel] 当前客户端为只读 adopt（pid=%s），stop 为 no-op",
            getattr(client, "_adopted_pid", 0),
        )
        return {
            "stopped": False,
            "reason": "adopted",
            "pid": getattr(client, "_adopted_pid", 0),
        }
    with _restart_lock:
        with _reload_window():
            return _stop_kernel_process_locked(timeout_s=timeout_s)


def fence_kernel_respawn() -> None:
    """关停闸：置位 _reloading，本进程后续 ensure() 一律拒绝 spawn。

    只用于"内核已停、进程即将退出"的窗口（Windows 重启 Popen 新后端后
    os._exit 前的 0.5 秒）：如果此刻有后台请求触发 ensure，会抢先起一个新
    内核，旧后端退出后它就成了无人认领的孤儿，新后端只能报
    stale_kernel_detected。闸门复用 _reloading，不需要第二套状态。
    """
    global _reloading
    with _restart_lock:
        _reloading = True


def restart_kernel(
    *, timeout_s: float = 10.0, eager: bool = True
) -> Dict[str, Any]:
    """停止旧内核后按需立即 ensure() 新内核；状态/端口/pid 或错误以 dict 返回。"""
    stop_result: Dict[str, Any] = {}
    if getattr(get_kernel_client(), "adopted", False):
        return {
            "status": "error",
            "error": "当前客户端为只读 adopt，拒绝重启（不改动挂接的内核）",
            "stop": stop_result,
        }
    with _restart_lock:
        try:
            stop_result = stop_kernel_process(timeout_s=timeout_s)
            if stop_result.get("reason") == "no-pidfile":
                reset_kernel_client()
                _reset_down_state()
            if not eager:
                return {"status": "stopped", "stop": stop_result}
            client = get_kernel_client()
            client.ensure()
            link = _read_pidfile(client._state_dir) or {}
            return {
                "status": "restarted",
                "pid": _int_or_zero(link.get("pid")),
                "port": _int_or_zero(link.get("port"))
                or _port_from_base_url(client.base_url),
                "stop": stop_result,
            }
        except (KernelRestartError, KernelUnavailable) as exc:
            return {"status": "error", "error": str(exc), "stop": stop_result}
        finally:
            _clear_reloading()


def score_all_v2(
    audio,
    *,
    sample_rate: int = 16000,
    detail: bool = False,
    sliding: "Optional[Dict[str, int]]" = None,
    collect: bool = False,
    collect_meta: "Optional[Dict[str, Any]]" = None,
    **_ignored,
) -> Dict[str, Any]:
    """内核同步评分垫片（管线/预览线程上下文用），对齐外层 score_all_v2 语义。

    - ``audio``: 路径(str) 或 numpy 数组；数组编码为 16bit PCM WAV 后 base64 送
      内核 POST /v1/voiceprint/score（向量不出内核，只回分数）
    - ``detail=False`` -> 返回纯分数 dict {name: score}（对照后端非 detail 返回）
    - ``detail=True``  -> 返回 {scores, raw, imp_mean, imp_std, n_cohort, as_norm_on}
      并叠加内核 A2 additive 键（sliding/collect 请求时）：
      windows/win_max/win_pct/windows_total 与 collected/collect_reason
    - ``sliding={"window_ms","hop_ms"}``: A2 滑窗趋势（一次请求出全部窗分数，
      取代外层逐窗 HTTP 往返）；None 时内核不产 windows 四键（旧调用零感知）
    - ``collect=True`` + ``collect_meta``: 内核内 cohort 自动采集（三门+去重+
      日限，写内核 state-dir cohort 文件）；collect_meta 键
      {src_file,src_t,src_start,src_end,env_tag,speech_prob} 仅落盘溯源
    - 内核不可达 -> 只记一次日志并返回空结果（打分降级：跳过标注、绝不抛出、
      绝不让感知 ingest 503）；**不回退本地模型**（B2 起外层零算法残留）
    - ``**_ignored`` 吸收外层旧签名的 _src_* / _no_collect 等元数据参数
      （旧管线逐窗调用遗留的位置元数据，评分本体不依赖）
    """
    empty_detail: Dict[str, Any] = {
        "scores": {}, "raw": {}, "imp_mean": None, "imp_std": None,
        "n_cohort": 0, "as_norm_on": False,
    }
    if sliding is not None:
        empty_detail.update(
            {"windows": [], "win_max": None, "win_pct": None, "windows_total": 0}
        )
    if collect:
        empty_detail.update({"collected": False, "collect_reason": "not_scored"})
    try:
        payload: Dict[str, Any] = {"audio_b64": _wav_b64(audio, sample_rate)}
        if sliding is not None:
            payload["sliding"] = {
                "window_ms": int(sliding.get("window_ms", 1500)),
                "hop_ms": int(sliding.get("hop_ms", 750)),
            }
        if collect:
            payload["collect"] = True
            if collect_meta is not None:
                # 内核 CollectMeta extra=forbid：只透传契约内六键，None 值剔除走内核缺省
                payload["collect_meta"] = {
                    k: v for k, v in collect_meta.items() if v is not None
                }
        result = get_kernel_client().srequest(
            "POST", "/v1/voiceprint/score",
            json=payload,
            timeout=HEAVY_TIMEOUT,
        )
        facts = (result or {}).get("facts") or {}
        if detail:
            merged = dict(empty_detail)
            merged.update(facts)
            return merged
        return facts.get("scores") or {}
    except KernelUnavailable as exc:
        log_down_once(str(exc))
        return dict(empty_detail) if detail else {}
    except KernelHttpError as exc:
        # 内核业务错误（如模型缺失）同样降级：只记一次，不打断调用链
        log_down_once(str(exc))
        return dict(empty_detail) if detail else {}


def _wav_b64(audio, sample_rate: int) -> str:
    """路径直接读字节；numpy 数组编码为 16bit PCM WAV -> base64。"""
    import base64 as _b64

    if isinstance(audio, (str, Path)):
        return _b64.b64encode(Path(audio).read_bytes()).decode("ascii")
    import io

    import numpy as np
    import soundfile as sf

    arr = np.asarray(audio)
    if arr.dtype != np.float32 and arr.dtype != np.float64:
        arr = arr.astype(np.float32)
    if arr.ndim > 1:
        arr = arr.mean(axis=1)
    buf = io.BytesIO()
    sf.write(buf, arr, int(sample_rate), format="WAV", subtype="PCM_16")
    return _b64.b64encode(buf.getvalue()).decode("ascii")


def vp_speaker_count(timeout: float = 5.0) -> int:
    """声纹注册数探针（V10：原外层镜像内存计数改内核 HTTP 面）。

    GET /v1/voiceprint/speakers 的 facts.count（四键摘要端点，比 registry
    快照更轻）。消费方 = 分析管线评分门与日志元数据；内核不可达/业务错误
    一律降级 0（保持旧镜像语义：内核故障绝不传导为分析失败）。ensure 与
    打分链同款懒触发，无启动预热（B5 纯度原则）。
    """
    try:
        result = get_kernel_client().srequest(
            "GET", "/v1/voiceprint/speakers", timeout=timeout
        )
        facts = (result or {}).get("facts") if isinstance(result, dict) else None
        if not isinstance(facts, dict):
            return 0
        count = facts.get("count")
        if count is None and isinstance(facts.get("speakers"), list):
            count = len(facts["speakers"])
        return int(count or 0)
    except Exception as e:
        logger.debug(f"[Kernel] vp_speaker_count 探针失败(降级 0): {e}")
        return 0


def vp_cohort_stats(timeout: float = 5.0) -> Dict[str, int]:
    """冒名者队列统计 —— 透传内核 GET /v1/voiceprint/cohort/stats（V10 自
    voiceprint_service 镜像文件迁入；cohort 真相源全在内核 state-dir，
    write-through 采集无攒批缓冲, buffer 恒 0）。

    内核不可达/业务错误一律降级 ``{"active": 0, "buffer": 0}``：本函数只供
    分析管线日志元数据（"vp=Nspk/Mco(AS|raw)"），不得把内核故障传导为分析失败。
    """
    try:
        result = get_kernel_client().srequest(
            "GET", "/v1/voiceprint/cohort/stats", timeout=timeout
        )
        facts = (result or {}).get("facts") if isinstance(result, dict) else None
        if not isinstance(facts, dict):
            facts = {}
        return {
            "active": int(facts.get("active") or 0),
            "buffer": int(facts.get("buffer") or 0),
        }
    except Exception as e:
        logger.debug(f"[Kernel] vp_cohort_stats 透传失败(降级 0): {e}")
        return {"active": 0, "buffer": 0}


__all__ = [
    "KernelClient",
    "KernelStreamWs",
    "KernelUnavailable",
    "KernelHttpError",
    "KernelRestartError",
    "HEAVY_TIMEOUT",
    "get_kernel_client",
    "reset_kernel_client",
    "stop_kernel_process",
    "restart_kernel",
    "adopt_kernel",
    "fence_kernel_respawn",
    "log_down_once",
    "score_all_v2",
    "vp_speaker_count",
    "vp_cohort_stats",
]
