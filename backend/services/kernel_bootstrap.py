# -*- coding: utf-8 -*-
"""内核本地构建与内核 venv 依赖安装（首次引导第 4 步）。

三步编排（不下载 kernel tar.gz）：

1. **构建**：用当前后端解释器跑 ``kernel/build_dist.py --protection pyc``，
   断言退出码 0 且 ``kernel/dist/axeuh-kernel/axeuh_kernel/__main__.pyc``
   存在。构建只做复制 + compileall + smoke，不需要 torch。
2. **建 venv**：``<repo>/.venv-kernel``，路径与
   ``kernel_assets.resolve_kernel_python`` 的项目内探测位置一致；
   已存在可执行 python 则复用。
3. **装依赖**：先 torch，再 ``pip install -e kernel/``。顺序不可反：
   funasr 依赖 torch，若先装 ``-e kernel/``，pip 会从 PyPI 拉一份 CPU
   torch，随后再装 CUDA 版会重复下载数 GB。预构建发行包没有 pyproject/
   源码，改读发行包根 ``requirements.txt``（``pip install -r``）。

torch 安装源：显式 ``kernel.torch_index_url`` 优先；否则按 ``nvidia-smi``
驱动主版本判定。驱动 >= 550 视为 CUDA 候选，>= 570 选 cu128（覆盖 RTX 50
系），550-569 选 cu124（保守，CUDA 12.x 向后兼容）；低于 550 走 PyPI CPU。
CUDA 首次安装失败时只回退一次 CPU（去掉 ``--index-url``），结果标
``torch_cpu_fallback``，不中断整个引导。

磁盘守卫：建 venv 之前检查剩余空间，默认 8 GiB（CUDA 路径 12 GiB），不足
直接抛 ``disk_full`` 且不落任何目录。所有子进程经 ``runner`` 注入，测试
零网络、零真实 pip、零 GB 级下载。
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Protocol, Sequence

logger = logging.getLogger(__name__)

# 磁盘守卫阈值：CPU 路径 8 GiB（venv + CPU torch ~0.2 GB + 依赖）；
# CUDA 路径 12 GiB（cu 轮子下载 ~6.3 GB，解包与 pip 缓存放大约一倍）。
MIN_FREE_BYTES = 8 * 1024 ** 3
CUDA_MIN_FREE_BYTES = 12 * 1024 ** 3
# 自动选 CUDA 时必须回报的体积（十进制 ~6.3 GB，与计划口径一致）。
TORCH_CUDA_DOWNLOAD_BYTES = 6_300_000_000
# CPU 路径总下载预算（CPU torch + funasr/modelscope 传递依赖，十进制 ~1.1 GB）。
TORCH_CPU_RUNTIME_DOWNLOAD_BYTES = 1_100_000_000
CUDA_DRIVER_MIN_MAJOR = 550
CUDA128_DRIVER_MIN_MAJOR = 570
CUDA_INDEX_LEGACY = "https://download.pytorch.org/whl/cu124"
CUDA_INDEX_MODERN = "https://download.pytorch.org/whl/cu128"

BUILD_TIMEOUT_S = 600.0
VENV_TIMEOUT_S = 300.0
PIP_TIMEOUT_S = 3600.0
VERIFY_TIMEOUT_S = 180.0
NVIDIA_SMI_TIMEOUT_S = 10.0

KERNEL_DIST_REL = Path("kernel") / "dist" / "axeuh-kernel"
KERNEL_ENTRY_REL = KERNEL_DIST_REL / "axeuh_kernel" / "__main__.pyc"
VENV_DIR_NAME = ".venv-kernel"


class KernelBootstrapError(RuntimeError):
    """引导步骤失败；``code`` 是稳定、可上报且不含敏感值的错误码。"""

    def __init__(self, code: str, message: str, *, detail: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.detail = detail or message


@dataclass
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class Runner(Protocol):
    def __call__(
        self,
        argv: Sequence[str],
        *,
        cwd: Path | str | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> CommandResult: ...


ProgressFn = Callable[[int, Optional[int]], None]
LogFn = Callable[[str], None]


def _decode(raw: bytes) -> str:
    return raw.decode("utf-8", "replace")


def _default_runner(
    argv: Sequence[str],
    *,
    cwd: Path | str | None = None,
    env: Mapping[str, str] | None = None,
    timeout: float | None = None,
    cancel_event: threading.Event | None = None,
) -> CommandResult:
    """真实子进程执行：输出落临时文件，轮询取消/超时，避免管道死锁。"""
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            proc = subprocess.Popen(
                list(argv),
                cwd=str(cwd) if cwd is not None else None,
                env=dict(env) if env is not None else None,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
            )
        except OSError as exc:
            raise KernelBootstrapError(
                "spawn_failed", "cannot run %s: %s" % (argv[0], exc)
            ) from exc
        deadline = time.monotonic() + timeout if timeout else None
        try:
            while proc.poll() is None:
                if cancel_event is not None and cancel_event.is_set():
                    raise KernelBootstrapError(
                        "cancelled", "%s cancelled by user" % argv[0]
                    )
                if deadline is not None and time.monotonic() > deadline:
                    raise KernelBootstrapError(
                        "timeout", "%s exceeded %.0fs" % (argv[0], timeout or 0)
                    )
                time.sleep(0.2)
        finally:
            if proc.poll() is None:
                proc.kill()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                logger.warning("[KernelBootstrap] child did not exit after kill: %s", argv[0])
        stdout.seek(0)
        stderr.seek(0)
        return CommandResult(
            returncode=int(proc.returncode or 0),
            stdout=_decode(stdout.read()),
            stderr=_decode(stderr.read()),
        )


def _as_result(value: Any) -> CommandResult:
    if isinstance(value, CommandResult):
        return value
    return CommandResult(
        returncode=int(getattr(value, "returncode", 1) or 0),
        stdout=str(getattr(value, "stdout", "") or ""),
        stderr=str(getattr(value, "stderr", "") or ""),
    )


def _call(
    runner: Runner,
    argv: Sequence[str],
    *,
    cwd: Path | str | None = None,
    env: Mapping[str, str] | None = None,
    timeout: float | None = None,
    cancel_event: threading.Event | None = None,
) -> CommandResult:
    try:
        return _as_result(
            runner(
                list(argv),
                cwd=cwd,
                env=env,
                timeout=timeout,
                cancel_event=cancel_event,
            )
        )
    except KernelBootstrapError:
        raise
    except (OSError, subprocess.SubprocessError) as exc:
        raise KernelBootstrapError(
            "spawn_failed", "cannot run %s: %s" % (argv[0], exc)
        ) from exc


def _tail(result: CommandResult, limit: int = 2000) -> str:
    text = (result.stderr or "").strip() or (result.stdout or "").strip()
    return text[-limit:]


def _raise_if_cancelled(cancel_event: threading.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise KernelBootstrapError("cancelled", "kernel bootstrap cancelled")


def _dir_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            try:
                total += item.stat().st_size
            except OSError:
                continue
    return total


def _driver_major(text: str) -> Optional[int]:
    match = re.search(r"(\d+)", str(text or ""))
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def _normalize_classification(value: Any) -> tuple[str, str]:
    if isinstance(value, (tuple, list)):
        kind = str(value[0]).strip().lower() if value else "cpu"
        detail = str(value[1]) if len(value) > 1 else ""
        return (kind if kind in {"cuda", "cpu"} else "cpu", detail)
    kind = str(value or "").strip().lower()
    return (kind if kind in {"cuda", "cpu"} else "cpu", "")


def gpu_classify(
    runner: Runner | None = None,
    *,
    timeout: float = NVIDIA_SMI_TIMEOUT_S,
) -> tuple[str, str]:
    """按 ``nvidia-smi`` 驱动主版本判定 torch 轮子类型。

    成功且首个 GPU 驱动主版本 >= 550 返回 ``("cuda", detail)``，否则
    ``("cpu", detail)``。命令缺失/失败/输出不可解析一律按 CPU 处理，
    绝不因显卡探测失败阻塞引导。
    """
    active = runner or _default_runner
    argv = ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"]
    try:
        result = _call(active, argv, timeout=timeout)
    except KernelBootstrapError as exc:
        return "cpu", "nvidia-smi unavailable: %s" % exc.code
    if result.returncode != 0:
        return "cpu", "nvidia-smi exit=%s" % result.returncode
    lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    if not lines:
        return "cpu", "nvidia-smi returned no GPU"
    raw = lines[0]
    major = _driver_major(raw)
    if major is None:
        return "cpu", "unparsable driver version: %s" % raw
    if major >= CUDA_DRIVER_MIN_MAJOR:
        return "cuda", "driver %s (>=%d)" % (raw, CUDA_DRIVER_MIN_MAJOR)
    return "cpu", "driver %s (<%d)" % (raw, CUDA_DRIVER_MIN_MAJOR)


def _kernel_value(cfg: Any, key: str) -> str:
    if cfg is None:
        return ""
    if isinstance(cfg, Mapping):
        section = cfg.get("kernel")
        if isinstance(section, Mapping):
            return str(section.get(key) or "").strip()
        return ""
    attr = getattr(cfg, "KERNEL_" + key.upper(), None)
    if attr is not None:
        return str(attr or "").strip()
    section_fn = getattr(cfg, "_section", None)
    if callable(section_fn):
        try:
            section = section_fn("kernel")
        except Exception:
            return ""
        if isinstance(section, Mapping):
            return str(section.get(key) or "").strip()
    return ""


def _load_config() -> Any:
    try:
        from config.config import get_config

        return get_config()
    except Exception:
        return None


def torch_index_url(cfg: Any, classification: Any) -> str:
    """返回 torch 安装 ``--index-url``；空串 = 不覆盖 PyPI。

    显式 ``kernel.torch_index_url`` 优先（任何分类都生效）；否则 CUDA 按
    驱动主版本选 cu128（>=570）或 cu124（550-569），CPU 返回空串。
    """
    explicit = _kernel_value(cfg, "torch_index_url")
    if explicit:
        return explicit
    kind, detail = _normalize_classification(classification)
    if kind != "cuda":
        return ""
    major = _driver_major(detail)
    if major is not None and major >= CUDA128_DRIVER_MIN_MAJOR:
        return CUDA_INDEX_MODERN
    return CUDA_INDEX_LEGACY


def runtime_download_bytes(classification: Any) -> int:
    """内核运行时安装的下载体积预算（CPU ~1.1 GB / CUDA ~6.3 GB）。"""
    kind, _ = _normalize_classification(classification)
    return (
        TORCH_CUDA_DOWNLOAD_BYTES
        if kind == "cuda"
        else TORCH_CPU_RUNTIME_DOWNLOAD_BYTES
    )


def venv_python_path(venv_dir: Path | str) -> Path:
    base = Path(venv_dir)
    return base / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def _is_executable(path: Path) -> bool:
    if not path.is_file():
        return False
    if os.name == "nt":
        return True
    return os.access(path, os.X_OK)


def build_kernel(
    repo_root: Path | str,
    *,
    runner: Runner | None = None,
    timeout: float = BUILD_TIMEOUT_S,
) -> dict:
    """本地构建内核分发目录（``--protection pyc``，无 torch 依赖）。"""
    root = Path(repo_root).expanduser().resolve()
    active = runner or _default_runner
    argv = [sys.executable, "kernel/build_dist.py", "--protection", "pyc"]
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    result = _call(active, argv, cwd=root, env=env, timeout=timeout)
    if result.returncode != 0:
        raise KernelBootstrapError(
            "build_failed",
            "kernel build failed (exit=%s)" % result.returncode,
            detail=_tail(result),
        )
    artifact = root / KERNEL_ENTRY_REL
    if not artifact.is_file():
        raise KernelBootstrapError(
            "build_artifact_missing",
            "kernel build artifact missing: %s" % artifact,
        )
    return {
        "artifact": str(artifact),
        "artifact_bytes": _dir_size(root / KERNEL_DIST_REL),
        "command": argv,
        "output": _tail(result, 1000),
    }


def ensure_kernel_venv(
    repo_root: Path | str,
    *,
    classification: Any = ("cpu", ""),
    torch_index: str | None = None,
    requirements_file: Path | str | None = None,
    runner: Runner | None = None,
    python: str | None = None,
    cancel_event: threading.Event | None = None,
    disk_usage_fn: Callable[[Path], Any] = shutil.disk_usage,
    min_free_bytes: int = MIN_FREE_BYTES,
    phase: Callable[[str], None] | None = None,
    log: LogFn | None = None,
    venv_timeout: float = VENV_TIMEOUT_S,
    pip_timeout: float = PIP_TIMEOUT_S,
) -> dict:
    """创建（或复用）``<repo>/.venv-kernel`` 并安装 torch、内核依赖。

    顺序硬约束：torch 安装必须先于依赖安装。依赖来源二选一：
    ``requirements_file`` 显式给出或 ``kernel/pyproject.toml`` 不存在时走
    ``pip install -r``（预构建发行包），否则保持 ``pip install -e kernel``。
    """
    root = Path(repo_root).expanduser().resolve()
    active = runner or _default_runner
    kind, detail = _normalize_classification(classification)
    index_url = torch_index if torch_index is not None else ""
    requirements_mode = requirements_file is not None or not (
        root / "kernel" / "pyproject.toml"
    ).is_file()
    requirements_path: Path | None = None
    if requirements_mode:
        raw_requirements: Path | str = (
            requirements_file
            if requirements_file is not None
            else root / "kernel" / "requirements.txt"
        )
        requirements_path = Path(raw_requirements).expanduser()
        if not requirements_path.is_absolute():
            requirements_path = root / requirements_path
        requirements_path = requirements_path.resolve()
        if not requirements_path.is_file():
            raise KernelBootstrapError(
                "kernel_requirements_missing",
                "kernel requirements file missing: %s" % requirements_path,
                detail="expected %s from the prebuilt kernel package" % requirements_path,
            )

    def _phase(name: str) -> None:
        if phase is not None:
            phase(name)

    def _log(line: str) -> None:
        if log is not None:
            log(line)
        else:
            logger.info("%s", line)

    # 1) 磁盘守卫：任何目录创建之前。CUDA 轮子更大，阈值抬高。
    required = max(int(min_free_bytes), CUDA_MIN_FREE_BYTES) if kind == "cuda" else int(min_free_bytes)
    try:
        usage = disk_usage_fn(root)
        free = int(getattr(usage, "free", 0) or 0)
    except OSError as exc:
        raise KernelBootstrapError("disk_check_failed", "cannot inspect disk: %s" % exc) from exc
    if free < required:
        raise KernelBootstrapError(
            "disk_full",
            "free space %d bytes < required %d bytes" % (free, required),
            detail="repo=%s free=%d required=%d" % (root, free, required),
        )

    # 2) venv：已存在可执行 python 直接复用，不重复创建。
    venv_dir = root / VENV_DIR_NAME
    target_python = venv_python_path(venv_dir)
    reused = _is_executable(target_python)
    commands: list[list[str]] = []
    if not reused:
        _raise_if_cancelled(cancel_event)
        _phase("venv")
        base_python = python or sys.executable
        venv_argv = [base_python, "-m", "venv", str(venv_dir)]
        commands.append(venv_argv)
        result = _call(
            active,
            venv_argv,
            cwd=root,
            timeout=venv_timeout,
            cancel_event=cancel_event,
        )
        if result.returncode != 0:
            shutil.rmtree(venv_dir, ignore_errors=True)
            raise KernelBootstrapError(
                "venv_create_failed",
                "python -m venv failed (exit=%s)" % result.returncode,
                detail=_tail(result),
            )
        if not _is_executable(target_python):
            shutil.rmtree(venv_dir, ignore_errors=True)
            raise KernelBootstrapError(
                "venv_create_failed",
                "venv python missing: %s" % target_python,
            )
        _log("[KernelBootstrap] phase=venv result=ok path=%s" % venv_dir)
    else:
        _log("[KernelBootstrap] phase=venv result=reuse path=%s" % venv_dir)

    # 3) torch 先行；失败（且用了 index）只回退一次 CPU 轮子。
    _raise_if_cancelled(cancel_event)
    _phase("torch")
    torch_attempts: list[list[str]] = []
    torch_kind = kind
    fallback = False
    used_index = index_url

    def _torch_command(with_index: str) -> list[str]:
        argv = [
            str(target_python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "torch",
        ]
        if with_index:
            argv.extend(["--index-url", with_index])
        return argv

    first_argv = _torch_command(index_url)
    torch_attempts.append(first_argv)
    commands.append(first_argv)
    result = _call(
        active,
        first_argv,
        cwd=root,
        timeout=pip_timeout,
        cancel_event=cancel_event,
    )
    if result.returncode != 0:
        if not index_url:
            raise KernelBootstrapError(
                "torch_install_failed",
                "torch install failed (exit=%s)" % result.returncode,
                detail=_tail(result),
            )
        _log(
            "[KernelBootstrap] phase=torch result=fallback reason=install_failed"
        )
        cpu_argv = _torch_command("")
        torch_attempts.append(cpu_argv)
        commands.append(cpu_argv)
        retry = _call(
            active,
            cpu_argv,
            cwd=root,
            timeout=pip_timeout,
            cancel_event=cancel_event,
        )
        if retry.returncode != 0:
            raise KernelBootstrapError(
                "torch_install_failed",
                "torch install failed on CUDA and CPU retry (exit=%s)"
                % retry.returncode,
                detail=_tail(retry),
            )
        torch_kind = "cpu"
        fallback = True
        used_index = ""
        _log("[KernelBootstrap] phase=torch result=cpu_fallback")
    _log(
        "[KernelBootstrap] phase=torch result=ok kind=%s index=%s"
        % (torch_kind, used_index or "pypi")
    )

    # 4) 内核依赖（torch 已满足，funasr 不会再把 CPU torch 拉一遍）。
    _raise_if_cancelled(cancel_event)
    _phase("deps")
    if requirements_mode:
        deps_argv = [
            str(target_python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-r",
            str(requirements_path),
        ]
    else:
        deps_argv = [
            str(target_python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-e",
            "kernel",
        ]
    commands.append(deps_argv)
    deps_result = _call(
        active,
        deps_argv,
        cwd=root,
        timeout=pip_timeout,
        cancel_event=cancel_event,
    )
    if deps_result.returncode != 0:
        if requirements_mode:
            raise KernelBootstrapError(
                "kernel_deps_install_failed",
                "pip install -r %s failed (exit=%s)"
                % (requirements_path, deps_result.returncode),
                detail=_tail(deps_result),
            )
        raise KernelBootstrapError(
            "deps_install_failed",
            "pip install -e kernel failed (exit=%s)" % deps_result.returncode,
            detail=_tail(deps_result),
        )

    estimate = TORCH_CUDA_DOWNLOAD_BYTES if torch_kind == "cuda" else 0
    if estimate:
        _log(
            "[KernelBootstrap] phase=torch result=cuda download_bytes=%d note=\"CUDA wheels ~6.3 GB\""
            % estimate
        )
    return {
        "venv_dir": str(venv_dir),
        "venv_python": str(target_python),
        "reused": reused,
        "created": not reused,
        "torch": torch_kind,
        "classification": kind,
        "classification_detail": detail,
        "torch_index_url": used_index,
        "torch_cpu_fallback": fallback,
        "torch_download_bytes_estimate": estimate,
        "torch_attempts": torch_attempts,
        "commands": commands,
        "deps_mode": "requirements" if requirements_mode else "editable",
        "requirements_file": (
            str(requirements_path) if requirements_path is not None else None
        ),
    }


def verify_kernel_runtime(
    venv_python: Path | str,
    kernel_dir: Path | str,
    *,
    runner: Runner | None = None,
    timeout: float = VERIFY_TIMEOUT_S,
    cancel_event: threading.Event | None = None,
) -> dict:
    """用内核 venv 在 ``kernel_dir`` 跑 ``python -m axeuh_kernel --help``。

    ``--help`` 在 argparse 阶段退出（0），只验证解释器、包导入与依赖可用；
    token 校验在此之前不会触发。
    """
    active = runner or _default_runner
    python_path = Path(venv_python).expanduser()
    kernel_path = Path(kernel_dir).expanduser()
    if not _is_executable(python_path):
        raise KernelBootstrapError(
            "kernel_venv_python_missing",
            "kernel venv python missing: %s" % python_path,
        )
    if not kernel_path.is_dir():
        raise KernelBootstrapError(
            "kernel_package_missing",
            "kernel package directory missing: %s" % kernel_path,
        )
    argv = [str(python_path), "-m", "axeuh_kernel", "--help"]
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env.pop("PYTHONPATH", None)
    result = _call(
        active,
        argv,
        cwd=kernel_path,
        env=env,
        timeout=timeout,
        cancel_event=cancel_event,
    )
    if result.returncode != 0:
        raise KernelBootstrapError(
            "kernel_verify_failed",
            "python -m axeuh_kernel --help failed (exit=%s)" % result.returncode,
            detail=_tail(result),
        )
    return {"command": argv, "cwd": str(kernel_path), "output": _tail(result, 500)}


def _default_repo_root() -> Path:
    try:
        from config.paths import project_root

        return Path(project_root()).resolve()
    except Exception:
        return Path(__file__).resolve().parents[2]


def bootstrap_kernel(
    repo_root: Path | str | None = None,
    *,
    cfg: Any = None,
    job: Any = None,
    runner: Runner | None = None,
    python: str | None = None,
    progress: ProgressFn | None = None,
    log: LogFn | None = None,
    cancel_event: threading.Event | None = None,
    disk_usage_fn: Callable[[Path], Any] = shutil.disk_usage,
    min_free_bytes: int = MIN_FREE_BYTES,
) -> dict:
    """引导内核三步（build -> venv -> torch/deps），返回结构化结果。

    ``job`` 可直接传 ``onboarding_jobs.Job``：其 ``set_current`` / ``log`` /
    ``update_progress`` / ``cancel_event`` 会绑定到同名的进度回调，快照形状
    与其他引导作业一致。成功返回 ``{ok, built, artifact_bytes, venv_python,
    torch, torch_cpu_fallback, steps}``；预期失败返回 ``ok=False`` 与
    ``error={code, detail}``，不抛异常（编程错误除外）。
    """
    root = (
        Path(repo_root).expanduser().resolve()
        if repo_root is not None
        else _default_repo_root()
    )
    active = runner or _default_runner
    job_current = getattr(job, "set_current", None) if job is not None else None
    if job is not None:
        progress = progress or getattr(job, "update_progress", None)
        log = log or getattr(job, "log", None)
        cancel_event = cancel_event or getattr(job, "cancel_event", None)

    def _log(line: str) -> None:
        if log is not None:
            log(line)
        else:
            logger.info("%s", line)

    def _report(done: int) -> None:
        if progress is not None:
            progress(done, 3)

    def _current(name: str) -> None:
        if job_current is not None:
            job_current(name)

    steps: list[dict[str, Any]] = []
    build_info: dict[str, Any] = {}
    venv_info: dict[str, Any] = {}
    built = False
    step_name = "build"
    try:
        _raise_if_cancelled(cancel_event)
        _report(0)
        _current("kernel_build")
        _log("[KernelBootstrap] phase=build result=start")
        started = time.monotonic()
        build_info = build_kernel(root, runner=active)
        built = True
        duration_ms = int((time.monotonic() - started) * 1000)
        steps.append(
            {
                "name": "build",
                "ok": True,
                "duration_ms": duration_ms,
                "artifact": build_info["artifact"],
                "artifact_bytes": build_info["artifact_bytes"],
            }
        )
        _log(
            "[KernelBootstrap] phase=build result=ok bytes=%d duration_ms=%d"
            % (build_info["artifact_bytes"], duration_ms)
        )
        _report(1)

        _raise_if_cancelled(cancel_event)
        classification = gpu_classify(runner=active)
        auto_index = torch_index_url(cfg if cfg is not None else _load_config(), classification)
        _log(
            "[KernelBootstrap] phase=classify kind=%s detail=%s index=%s"
            % (classification[0], classification[1], auto_index or "pypi")
        )
        step_name = "venv"
        _current("kernel_venv")

        def _phase(name: str) -> None:
            nonlocal step_name
            if name == "venv":
                step_name = "venv"
                _log("[KernelBootstrap] phase=venv result=start")
            elif name == "torch":
                step_name = "deps"
                _current("kernel_torch")
                _log(
                    "[KernelBootstrap] phase=torch result=start kind=%s index=%s"
                    % (classification[0], auto_index or "pypi")
                )
            elif name == "deps":
                step_name = "deps"
                _report(2)
                _current("kernel_deps")
                _log("[KernelBootstrap] phase=deps result=start")

        venv_info = ensure_kernel_venv(
            root,
            classification=classification,
            torch_index=auto_index,
            runner=active,
            python=python,
            cancel_event=cancel_event,
            disk_usage_fn=disk_usage_fn,
            min_free_bytes=min_free_bytes,
            phase=_phase,
            log=_log,
        )
        steps.append(
            {
                "name": "venv",
                "ok": True,
                "reused": venv_info["reused"],
                "venv_python": venv_info["venv_python"],
            }
        )
        steps.append(
            {
                "name": "deps",
                "ok": True,
                "torch": venv_info["torch"],
                "torch_index_url": venv_info["torch_index_url"],
                "torch_cpu_fallback": venv_info["torch_cpu_fallback"],
                "torch_download_bytes_estimate": venv_info[
                    "torch_download_bytes_estimate"
                ],
            }
        )
        _report(3)
        _log("[KernelBootstrap] phase=deps result=ok")
        return {
            "ok": True,
            "built": built,
            "artifact": build_info.get("artifact"),
            "artifact_bytes": build_info.get("artifact_bytes", 0),
            "venv_python": venv_info["venv_python"],
            "torch": venv_info["torch"],
            "torch_cpu_fallback": venv_info["torch_cpu_fallback"],
            "torch_index_url": venv_info["torch_index_url"],
            "torch_download_bytes_estimate": venv_info[
                "torch_download_bytes_estimate"
            ],
            "reused_venv": venv_info["reused"],
            "steps": steps,
        }
    except KernelBootstrapError as exc:
        steps.append(
            {
                "name": step_name,
                "ok": False,
                "code": exc.code,
                "detail": exc.detail,
            }
        )
        _log("[KernelBootstrap] phase=%s result=failed code=%s" % (step_name, exc.code))
        return {
            "ok": False,
            "built": built,
            "artifact_bytes": build_info.get("artifact_bytes", 0),
            "error": {"code": exc.code, "detail": exc.detail},
            "steps": steps,
        }


__all__ = [
    "CUDA_DRIVER_MIN_MAJOR",
    "CUDA_INDEX_LEGACY",
    "CUDA_INDEX_MODERN",
    "CUDA_MIN_FREE_BYTES",
    "MIN_FREE_BYTES",
    "TORCH_CPU_RUNTIME_DOWNLOAD_BYTES",
    "TORCH_CUDA_DOWNLOAD_BYTES",
    "CommandResult",
    "KernelBootstrapError",
    "bootstrap_kernel",
    "build_kernel",
    "ensure_kernel_venv",
    "gpu_classify",
    "runtime_download_bytes",
    "torch_index_url",
    "venv_python_path",
    "verify_kernel_runtime",
]
