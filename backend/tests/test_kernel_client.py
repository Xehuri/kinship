# -*- coding: utf-8 -*-
"""K2 内核客户端单元测试（RED 先行）：握手解析 / pidfile 归属 / 断连 503 映射。

约定（docs/kernel-design.md §4.6）：
  - spawn: python -m axeuh_kernel --port 0 --state-dir <dir>，token 只走
    env AXEUH_KERNEL_TOKEN，绝不进 argv（命令行会进进程列表）
  - stdout 恰好一行 JSON 握手 {port, pid, api_version}
  - pidfile 记录 {port,pid,api_version,token,nonce,created_at}；pid 存活即抛
    stale_kernel_detected（自动复用已删除），只有 pid 已死才重新 spawn
  - 内核不可达（连接失败/超时）-> KernelUnavailable -> 路由映射
    503 {"error": {"code": "state.unavailable", ...}}（内核 errors.py 封闭码）
"""
import asyncio
import contextlib
import json
import logging
import os
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from services import kernel_assets
from services import kernel_client as kc


class _FakeStdout:
    """伪造内核 stdout：readline 返回唯一一行握手 JSON。"""

    def __init__(self, line: bytes):
        self._line = line
        self._read = False

    def readline(self) -> bytes:
        if self._read:
            return b""
        self._read = True
        return self._line


class _FakeProc:
    """伪造 Popen：记录 cmd/env 供断言 token 不进 argv。"""

    def __init__(self, handshake: dict):
        self.stdout = _FakeStdout(
            (json.dumps(handshake) + "\n").encode("utf-8")
        )
        self.pid = handshake.get("pid", 4242)
        self.args = None
        self.env = None


def _fake_popen_factory(fake: _FakeProc, capture: dict):
    """返回可注入 kc._popen 的桩：记录 cmd/cwd/env。"""

    def _popen(cmd, cwd=None, env=None, **kwargs):
        capture["cmd"] = list(cmd)
        capture["cwd"] = cwd
        capture["env"] = env
        fake.args = cmd
        fake.env = env
        return fake

    return _popen


_MODEL_ENV_KEYS = (
    "AXEUH_KERNEL_MODEL_DIR",
    "AXEUH_KERNEL_MODEL_DOWNLOAD_DIR",
    "MODELSCOPE_CACHE",
    "HF_HOME",
    "HF_HUB_CACHE",
    "HUGGINGFACE_HUB_CACHE",
    "TRANSFORMERS_CACHE",
    "TORCH_HOME",
)


def _clear_model_env(monkeypatch) -> None:
    for key in _MODEL_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def _ensure_with_config(monkeypatch, tmp_path, capture, **config_attrs):
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    fake = _FakeProc(handshake)
    monkeypatch.setattr(kc, "_popen", _fake_popen_factory(fake, capture))
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path / "state"))

    import config.config as cfg_mod

    class _FakeCfg:
        pass

    for name, value in config_attrs.items():
        setattr(_FakeCfg, name, value)
    monkeypatch.setattr(cfg_mod, "get_config", lambda: _FakeCfg())

    client = kc.get_kernel_client(reset=True)
    client.ensure()
    return capture["env"]


# ============================================================
# 1) 握手解析：单行 JSON -> base_url/pidfile 落盘；token 只进 env
# ============================================================

def test_spawn_parses_handshake_and_persists_pidfile(tmp_path, monkeypatch):
    token = "unit-test-token"
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    fake = _FakeProc(handshake)
    capture: dict = {}
    monkeypatch.setattr(kc, "_popen", _fake_popen_factory(fake, capture))
    monkeypatch.setenv("AXEUH_KERNEL_TOKEN", token)
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))

    client = kc.get_kernel_client(reset=True)
    client.ensure()

    # base_url 指向握手端口
    assert client.base_url == "http://127.0.0.1:54321"
    # pidfile 落在 state_dir，含 port/pid/api_version
    pidfile = tmp_path / "kernel.pid"
    assert pidfile.is_file(), "握手后必须持久化 pidfile"
    data = json.loads(pidfile.read_text(encoding="utf-8"))
    assert data["port"] == 54321
    assert data["pid"] == 4242
    assert data["api_version"] == "1.0.0"
    # token 绝不进 argv（命令行进进程列表），只进子进程 env
    argv = " ".join(str(x) for x in capture["cmd"])
    assert token not in argv, "token 泄漏进 argv"
    assert capture["env"].get("AXEUH_KERNEL_TOKEN") == token
    # 模块常量：spawn 命令要素齐备（--port 0 / --state-dir）
    assert "--port" in capture["cmd"] and "0" in capture["cmd"]
    assert "--state-dir" in capture["cmd"]
    assert str(tmp_path) in capture["cmd"]
    # cwd 必须是 kernel/（python -m axeuh_kernel 依赖包布局）
    assert capture["cwd"].replace("\\", "/").endswith("/kernel")


def test_spawn_wraps_kernel_in_child_entry_with_exact_argv(tmp_path, monkeypatch):
    """POSIX 父死亡保护：argv 严格是 child_entry 包 kernel，target 之后逐字不变。"""
    kernel_python = "/opt/kinship/.venv-kernel/bin/python"
    state_dir = tmp_path / "state"
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    capture: dict = {}
    monkeypatch.setattr(
        kc, "_popen", _fake_popen_factory(_FakeProc(handshake), capture)
    )
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(state_dir))
    monkeypatch.setattr(
        kernel_assets,
        "resolve_kernel_python",
        lambda *, project_root=None: {
            "path": kernel_python,
            "source": "default",
            "exists": True,
            "last_resort": False,
        },
    )
    monkeypatch.setattr(kc, "_process_creation_time", lambda pid: 1700000000.5)

    client = kc.get_kernel_client(reset=True)
    client.ensure()

    child_entry = (
        BACKEND_DIR / "services" / "orchestrator" / "child_entry.py"
    )
    assert capture["cmd"] == [
        sys.executable,
        str(child_entry),
        "--target",
        kernel_python,
        "-m",
        "axeuh_kernel",
        "--port",
        "0",
        "--state-dir",
        str(state_dir),
    ]
    # 握手解析不受包装影响
    assert client.base_url == "http://127.0.0.1:54321"
    data = json.loads((state_dir / "kernel.pid").read_text(encoding="utf-8"))
    assert (data["pid"], data["port"]) == (4242, 54321)
    # 内核 cwd 不变；child_entry 按文件路径调用，无需 PYTHONPATH
    assert capture["cwd"].replace("\\", "/").endswith("/kernel")
    assert capture["env"].get("PYTHONPATH") == os.environ.get("PYTHONPATH")


def test_spawn_plan_targets_project_kernel_venv_when_present(tmp_path, monkeypatch):
    """仅存在 <root>/.venv-kernel 时，spawn 的 --target 必须是该 venv python。"""
    root = tmp_path / "project"
    kernel_dir = root / "kernel"
    kernel_dir.mkdir(parents=True)
    venv_python = (
        root / ".venv-kernel" / "Scripts" / "python.exe"
        if os.name == "nt"
        else root / ".venv-kernel" / "bin" / "python"
    )
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("")
    monkeypatch.setattr(kc, "_KERNEL_DIR", kernel_dir)
    monkeypatch.setattr(kernel_assets, "DEFAULT_KERNEL_PYTHONS", ())
    monkeypatch.setattr(kernel_assets, "_config", lambda name, default="": "")
    monkeypatch.setenv("AXEUH_KERNEL_PYTHON", "")

    cmd, _env, _token = kc._build_spawn_plan(tmp_path / "state", "token")

    assert cmd[cmd.index("--target") + 1] == str(venv_python)


def test_spawn_pidfile_records_nonce_and_process_creation_time(
    tmp_path, monkeypatch
):
    """每次 spawn 写唯一 nonce + 子进程真实创建时间（Windows 归属证明输入）。"""
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    pops: list = []

    def _popen(cmd, cwd=None, env=None, **kwargs):
        proc = _FakeProc(handshake)
        pops.append(cmd)
        return proc

    monkeypatch.setattr(kc, "_popen", _popen)
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(
        kc,
        "_process_creation_time",
        lambda pid: 1700000000.25 if pid == 4242 else None,
    )

    client = kc.get_kernel_client(reset=True)
    client.ensure()

    data = json.loads((tmp_path / "kernel.pid").read_text(encoding="utf-8"))
    assert isinstance(data["nonce"], str) and len(data["nonce"]) >= 16
    assert data["created_at"] == 1700000000.25

    monkeypatch.setattr(
        kc, "_process_creation_time", lambda pid: 1700000001.25
    )
    kc.get_kernel_client(reset=True).ensure()
    second = json.loads((tmp_path / "kernel.pid").read_text(encoding="utf-8"))
    assert len(pops) == 2
    assert second["nonce"] != data["nonce"], "每次 spawn 的 nonce 必须唯一"
    assert second["created_at"] == 1700000001.25


def test_spawn_pidfile_created_at_falls_back_when_unreadable(
    tmp_path, monkeypatch
):
    """读不到 /proc 创建时间时仍写 created_at（握手时刻），不允许字段缺失。"""
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    fake = _FakeProc(handshake)
    monkeypatch.setattr(kc, "_popen", _fake_popen_factory(fake, {}))
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(kc, "_process_creation_time", lambda pid: None)
    before = time.time()

    client = kc.get_kernel_client(reset=True)
    client.ensure()

    data = json.loads((tmp_path / "kernel.pid").read_text(encoding="utf-8"))
    assert before <= float(data["created_at"]) <= time.time()


def test_fence_kernel_respawn_blocks_ensure_without_spawn(tmp_path, monkeypatch):
    """关停闸置位后，本进程再也 ensure 不出内核（Windows 重启空窗保护）。"""
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(kc, "_reloading", False)
    spawn_calls = _forbid_spawn(monkeypatch)

    kc.fence_kernel_respawn()
    client = kc.get_kernel_client(reset=True)
    with pytest.raises(kc.KernelUnavailable) as ei:
        client.ensure()

    assert "reloading" in str(ei.value) or "重启" in str(ei.value)
    assert spawn_calls == []


def test_spawn_injects_kernel_device_from_config(tmp_path, monkeypatch):
    """config kernel.device=gpu -> spawn env 带 AXEUH_KERNEL_DEVICE=gpu。"""
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    fake = _FakeProc(handshake)
    capture: dict = {}
    monkeypatch.setattr(kc, "_popen", _fake_popen_factory(fake, capture))
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    # 打桩配置读取（不经真实 config.yaml）
    import config.config as cfg_mod

    class _FakeCfg:
        KERNEL_DEVICE = "gpu"

    monkeypatch.setattr(cfg_mod, "get_config", lambda: _FakeCfg())

    client = kc.get_kernel_client(reset=True)
    client.ensure()
    assert capture["env"].get("AXEUH_KERNEL_DEVICE") == "gpu"


def test_spawn_omits_kernel_device_when_unconfigured(tmp_path, monkeypatch):
    """未配置 kernel.device -> 不设 env 键，内核保持缺省 cpu（fail-safe）。"""
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    fake = _FakeProc(handshake)
    capture: dict = {}
    monkeypatch.setattr(kc, "_popen", _fake_popen_factory(fake, capture))
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("AXEUH_KERNEL_DEVICE", raising=False)
    import config.config as cfg_mod

    class _FakeCfg:
        KERNEL_DEVICE = ""

    monkeypatch.setattr(cfg_mod, "get_config", lambda: _FakeCfg())

    client = kc.get_kernel_client(reset=True)
    client.ensure()
    assert "AXEUH_KERNEL_DEVICE" not in capture["env"]


def test_spawn_injects_model_cache_env_under_models_root(tmp_path, monkeypatch):
    models_root = tmp_path / "models-root"
    monkeypatch.setenv("AXEUH_MODELS_DIR", str(models_root))
    _clear_model_env(monkeypatch)

    env = _ensure_with_config(
        monkeypatch, tmp_path, {}, KERNEL_DEVICE="", KERNEL_MODEL_DIR=""
    )

    default = models_root / ".cache" / "axeuh-kernel" / "models"
    cache = models_root / ".cache"
    assert env["AXEUH_KERNEL_MODEL_DIR"] == str(default)
    assert env["AXEUH_KERNEL_MODEL_DOWNLOAD_DIR"] == str(default)
    assert env["MODELSCOPE_CACHE"] == str(cache / "modelscope")
    assert env["HF_HOME"] == str(cache / "huggingface")
    assert env["HF_HUB_CACHE"] == str(cache / "huggingface" / "hub")
    assert env["HUGGINGFACE_HUB_CACHE"] == str(cache / "huggingface" / "hub")
    assert env["TRANSFORMERS_CACHE"] == str(cache / "huggingface" / "hub")
    assert env["TORCH_HOME"] == str(cache / "torch")


def test_spawn_kernel_model_dir_config_wins_over_operator_env(tmp_path, monkeypatch):
    models_root = tmp_path / "models-root"
    configured = tmp_path / "configured-models"
    monkeypatch.setenv("AXEUH_MODELS_DIR", str(models_root))
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("AXEUH_KERNEL_MODEL_DIR", str(tmp_path / "operator-models"))

    env = _ensure_with_config(
        monkeypatch,
        tmp_path,
        {},
        KERNEL_DEVICE="",
        KERNEL_MODEL_DIR=str(configured),
    )

    assert env["AXEUH_KERNEL_MODEL_DIR"] == str(configured)
    assert env["AXEUH_KERNEL_MODEL_DOWNLOAD_DIR"] == str(
        models_root / ".cache" / "axeuh-kernel" / "models"
    )


def test_spawn_preserves_operator_model_cache_env(tmp_path, monkeypatch):
    models_root = tmp_path / "models-root"
    operator = {
        "AXEUH_KERNEL_MODEL_DIR": tmp_path / "operator" / "models",
        "AXEUH_KERNEL_MODEL_DOWNLOAD_DIR": tmp_path / "operator" / "downloads",
        "MODELSCOPE_CACHE": tmp_path / "operator" / "modelscope",
        "HF_HOME": tmp_path / "operator" / "hf",
        "HF_HUB_CACHE": tmp_path / "operator" / "hf" / "hub",
        "HUGGINGFACE_HUB_CACHE": tmp_path / "operator" / "hf" / "hub2",
        "TRANSFORMERS_CACHE": tmp_path / "operator" / "transformers",
        "TORCH_HOME": tmp_path / "operator" / "torch",
    }
    monkeypatch.setenv("AXEUH_MODELS_DIR", str(models_root))
    _clear_model_env(monkeypatch)
    for key, path in operator.items():
        monkeypatch.setenv(key, str(path))

    env = _ensure_with_config(
        monkeypatch, tmp_path, {}, KERNEL_DEVICE="", KERNEL_MODEL_DIR=""
    )

    for key, path in operator.items():
        assert env[key] == str(path)


# ============================================================
# 2) pidfile 归属：pid 存活 -> stale_kernel_detected，绝不自动接管/二次 spawn
# ============================================================

STALE_ERROR_TEMPLATE = "stale_kernel_detected: pid=%s"


def _stale_message(pid: int) -> str:
    """ensure() 拒绝接管存活 pidfile 时的唯一合法错误文本。"""
    return STALE_ERROR_TEMPLATE % pid


def _forbid_spawn(monkeypatch) -> list:
    """spawn 即失败（关停闸等"绝不允许出现新进程"的用例）。"""
    spawn_calls: list = []

    def _no_spawn(*args, **kwargs):  # pragma: no cover - 命中即失败
        spawn_calls.append(args)
        raise AssertionError("pidfile 里 pid 存活时绝不允许 spawn 第二个内核")

    monkeypatch.setattr(kc, "_popen", _no_spawn)
    return spawn_calls


def _spawn_spy(monkeypatch, handshake: dict | None = None) -> list:
    """记录每次 spawn 的 argv：调用计数是"双 spawn"回归的硬证据。"""
    spawn_calls: list = []
    handshake = handshake or {
        "port": 54321,
        "pid": 4242,
        "api_version": "1.0.0",
    }

    def _popen(cmd, cwd=None, env=None, **kwargs):
        spawn_calls.append(list(cmd))
        return _FakeProc(handshake)

    monkeypatch.setattr(kc, "_popen", _popen)
    return spawn_calls


def _forbid_probe(monkeypatch) -> list:
    probes: list = []

    def _probe(port, timeout=1.0):  # pragma: no cover - 命中即失败
        probes.append(port)
        raise AssertionError("新语义不再用 health 探针决定接管")

    monkeypatch.setattr(kc, "_probe_health", _probe)
    return probes


def _assert_stale_raises(client, pid: int) -> kc.KernelUnavailable:
    """断言 ensure() 抛精确 stale 错误，且客户端未被静默接管。"""
    with pytest.raises(kc.KernelUnavailable) as ei:
        client.ensure()
    assert type(ei.value) is kc.KernelUnavailable
    assert str(ei.value) == _stale_message(pid)
    assert client._connected is False, "存活 pidfile 绝不能被静默接管"
    return ei.value


def test_stale_live_pidfile_raises(tmp_path, monkeypatch, caplog):
    """pidfile 里 pid 存活 -> 精确抛 stale_kernel_detected，不探活、不 spawn。"""
    pid = os.getpid()
    _write_live_pidfile(tmp_path, pid=pid)
    pidfile_before = (tmp_path / "kernel.pid").read_text(encoding="utf-8")
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("AXEUH_KERNEL_TOKEN", raising=False)
    spawn_calls = _spawn_spy(monkeypatch)
    probes = _forbid_probe(monkeypatch)
    caplog.set_level(logging.ERROR, logger=kc.logger.name)

    client = kc.get_kernel_client(reset=True)
    _assert_stale_raises(client, pid)

    assert spawn_calls == [], "存活 pidfile 必须零 spawn"
    assert probes == []
    assert (tmp_path / "kernel.pid").read_text(encoding="utf-8") == pidfile_before
    errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
    assert any(
        "stale_kernel_detected: pidfile" in msg and ("pid=%s" % pid) in msg
        for msg in errors
    ), "必须留 ERROR 日志，含 stale 标记与存活 pid"


def test_stale_pidfile_respawns_when_pid_dead(tmp_path, monkeypatch):
    """pid 死透（不可能存活的大 pid）-> 恰好 spawn 一次新内核。"""
    dead_pid = 2**22 + 12345
    _write_live_pidfile(tmp_path, pid=dead_pid)
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("AXEUH_KERNEL_TOKEN", "t2")
    probes = _forbid_probe(monkeypatch)
    handshake = {"port": 55001, "pid": 4343, "api_version": "1.0.0"}
    spawn_calls = _spawn_spy(monkeypatch, handshake)

    client = kc.get_kernel_client(reset=True)
    client.ensure()

    assert client.base_url == "http://127.0.0.1:55001"
    assert len(spawn_calls) == 1, "陈旧 pidfile 只能触发一次 spawn（双 spawn 即回归）"
    assert probes == []
    data = json.loads((tmp_path / "kernel.pid").read_text(encoding="utf-8"))
    assert (data["pid"], data["port"]) == (4343, 55001)


# ============================================================
# 2b) 解释器守卫已随自动复用删除：存活 pid 一律 stale，不论解释器
# ============================================================

EXPECTED_PY = "/opt/kinship/.venv-kernel/bin/python"
FOREIGN_PY = "/opt/kinship/.venv-health/bin/python"


def _write_live_pidfile(tmp_path, pid: int = os.getpid(), **overrides) -> None:
    data = {
        "port": 54999,
        "pid": pid,
        "api_version": "1.0.0",
        "token": "persisted-token",
    }
    data.update(overrides)
    (tmp_path / "kernel.pid").write_text(json.dumps(data), encoding="utf-8")


def _unexpected_argv0(pid: int):
    raise AssertionError("解释器接管分支已删除，不得读取 argv0")


def test_live_pidfile_with_foreign_interpreter_still_raises(tmp_path, monkeypatch):
    """解释器不符不再是拒绝条件：自动接管删除后任何存活 pid 都抛 stale。"""
    pid = os.getpid()
    _write_live_pidfile(tmp_path, pid=pid)
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(kc, "_expected_kernel_python", lambda: EXPECTED_PY)
    spawn_calls = _spawn_spy(monkeypatch)
    probes = _forbid_probe(monkeypatch)
    monkeypatch.setattr(kc, "_proc_argv0", _unexpected_argv0)

    client = kc.get_kernel_client(reset=True)
    exc = _assert_stale_raises(client, pid)

    assert EXPECTED_PY not in str(exc) and FOREIGN_PY not in str(exc)
    assert spawn_calls == []
    assert probes == []


def test_live_pidfile_with_matching_interpreter_still_raises(tmp_path, monkeypatch):
    """解释器一致也不接管：同一 state-dir 的存活内核一律交给运维裁决。"""
    pid = os.getpid()
    _write_live_pidfile(tmp_path, pid=pid)
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(kc, "_expected_kernel_python", lambda: EXPECTED_PY)
    spawn_calls = _spawn_spy(monkeypatch)
    probes = _forbid_probe(monkeypatch)
    argv0_reads: list = []

    def _record_argv0(pid: int):
        argv0_reads.append(pid)
        return EXPECTED_PY

    monkeypatch.setattr(kc, "_proc_argv0", _record_argv0)

    client = kc.get_kernel_client(reset=True)
    _assert_stale_raises(client, pid)

    assert argv0_reads == [], "解释器校验已删除，不得为接管读取 argv0"
    assert spawn_calls == []
    assert probes == []


def test_live_pidfile_without_expected_python_raises(tmp_path, monkeypatch):
    """AXEUH_KERNEL_PYTHON 未设置也照样 stale，不存在"回退接管"分支。"""
    pid = os.getpid()
    _write_live_pidfile(tmp_path, pid=pid)
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("AXEUH_KERNEL_PYTHON", raising=False)
    monkeypatch.setattr(kc, "_expected_kernel_python", lambda: None)
    spawn_calls = _spawn_spy(monkeypatch)
    probes = _forbid_probe(monkeypatch)
    monkeypatch.setattr(kc, "_proc_argv0", _unexpected_argv0)

    client = kc.get_kernel_client(reset=True)
    _assert_stale_raises(client, pid)

    assert spawn_calls == []
    assert probes == []


def test_live_pidfile_with_unreadable_proc_raises(tmp_path, monkeypatch):
    """读不到 argv0 也不降级接管：存活 pid 一律 stale。"""
    pid = os.getpid()
    _write_live_pidfile(tmp_path, pid=pid)
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(kc, "_expected_kernel_python", lambda: EXPECTED_PY)
    spawn_calls = _spawn_spy(monkeypatch)
    probes = _forbid_probe(monkeypatch)
    argv0_reads: list = []

    def _unreadable_argv0(pid: int):
        argv0_reads.append(pid)
        return None

    monkeypatch.setattr(kc, "_proc_argv0", _unreadable_argv0)

    client = kc.get_kernel_client(reset=True)
    _assert_stale_raises(client, pid)

    assert argv0_reads == []
    assert spawn_calls == []
    assert probes == []


@pytest.mark.skipif(os.name == "nt", reason="POSIX 生产才要求内核专用 venv")
def test_spawn_logs_last_resort_backend_interpreter(
    tmp_path, monkeypatch, caplog
):
    """解析器落到后端解释器 -> 仍 spawn，但必须 ERROR 告警含 source/path。"""
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    fake = _FakeProc(handshake)
    capture: dict = {}
    monkeypatch.setattr(kc, "_popen", _fake_popen_factory(fake, capture))
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("AXEUH_KERNEL_TOKEN", "t")
    monkeypatch.setattr(
        kernel_assets,
        "resolve_kernel_python",
        lambda *, project_root=None: {
            "path": sys.executable,
            "source": "backend",
            "exists": True,
            "last_resort": True,
        },
    )
    caplog.set_level(logging.ERROR, logger=kc.logger.name)

    client = kc.get_kernel_client(reset=True)
    client.ensure()

    assert capture["cmd"][0] == sys.executable
    assert capture["cmd"][capture["cmd"].index("--target") + 1] == sys.executable
    errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
    assert any(
        "source=backend" in msg
        and sys.executable in msg
        and "kernel.python" in msg
        and "AXEUH_KERNEL_PYTHON" in msg
        for msg in errors
    ), "最后兜底必须 ERROR 告警，含 source/path 与两个配置入口"


def test_spawn_uses_kernel_python_from_config_over_env(tmp_path, monkeypatch):
    """config kernel.python 优先于 AXEUH_KERNEL_PYTHON。"""
    configured = tmp_path / "configured-python"
    configured.write_text("", encoding="utf-8")
    env_python = tmp_path / "env-python"
    env_python.write_text("", encoding="utf-8")
    monkeypatch.setenv("AXEUH_KERNEL_PYTHON", str(env_python))
    capture: dict = {}

    _ensure_with_config(
        monkeypatch,
        tmp_path,
        capture,
        KERNEL_PYTHON=str(configured),
        KERNEL_DEVICE="",
        KERNEL_MODEL_DIR="",
    )

    assert capture["cmd"][0] == sys.executable
    assert capture["cmd"][capture["cmd"].index("--target") + 1] == str(configured)


def test_spawn_uses_kernel_python_from_env(tmp_path, monkeypatch):
    """config 为空时 AXEUH_KERNEL_PYTHON 生效。"""
    env_python = tmp_path / "env-python"
    env_python.write_text("", encoding="utf-8")
    monkeypatch.setenv("AXEUH_KERNEL_PYTHON", str(env_python))
    capture: dict = {}

    _ensure_with_config(
        monkeypatch,
        tmp_path,
        capture,
        KERNEL_PYTHON="",
        KERNEL_DEVICE="",
        KERNEL_MODEL_DIR="",
    )

    assert capture["cmd"][0] == sys.executable
    assert capture["cmd"][capture["cmd"].index("--target") + 1] == str(env_python)


def test_spawn_passes_resolved_path_and_logs_source(tmp_path, monkeypatch, caplog):
    """spawn 使用共享解析器的 path，并以仓库根调用，INFO 记录 source/path。"""
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    fake = _FakeProc(handshake)
    capture: dict = {}
    resolved_python = tmp_path / "venv-python"
    resolved_python.write_text("", encoding="utf-8")
    seen: dict = {}

    def _resolve(*, project_root=None):
        seen["project_root"] = project_root
        return {
            "path": str(resolved_python),
            "source": "venv",
            "exists": True,
            "last_resort": False,
        }

    monkeypatch.setattr(kc, "_popen", _fake_popen_factory(fake, capture))
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("AXEUH_KERNEL_TOKEN", "t")
    monkeypatch.setattr(kernel_assets, "resolve_kernel_python", _resolve)
    caplog.set_level(logging.INFO, logger=kc.logger.name)

    client = kc.get_kernel_client(reset=True)
    client.ensure()

    assert capture["cmd"][0] == sys.executable
    assert capture["cmd"][capture["cmd"].index("--target") + 1] == str(resolved_python)
    assert seen["project_root"] == kc._KERNEL_DIR.parent
    infos = [r.getMessage() for r in caplog.records if r.levelno == logging.INFO]
    assert any(
        "source=venv" in msg and str(resolved_python) in msg for msg in infos
    ), "必须 INFO 记录解释器 source/path"


@pytest.mark.skipif(os.name != "posix", reason="POSIX 权限位")
def test_write_pidfile_tightens_state_dir_and_file_modes(tmp_path):
    state = tmp_path / "nested" / "kernel_state"

    kc._write_pidfile(state, {"port": 1, "pid": 2, "token": "t"})

    assert stat.S_IMODE(state.stat().st_mode) == 0o700
    assert stat.S_IMODE((state / "kernel.pid").stat().st_mode) == 0o600


def test_same_interpreter_does_not_resolve_symlinks():
    """路径比较必须规范化但绝不 realpath（venv python 是系统解释器软链）。"""
    assert kc._same_interpreter(
        "/opt/venvs/a/bin/python", "/opt/venvs/b/bin/python"
    ) is False
    assert kc._same_interpreter(
        "/opt/venvs/a/bin/../bin/python", "/opt/venvs/a/bin/python"
    ) is True


# ============================================================
# 2c) 探活不再参与决策：pid 存活即 stale，无论 health 结果如何
# ============================================================

def test_alive_pidfile_never_probes_health(
    tmp_path, monkeypatch, caplog
):
    """pid 存活 -> 精确 stale_kernel_detected；health 探针零调用、不 spawn。"""
    pid = os.getpid()
    _write_live_pidfile(tmp_path, pid=pid)
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    probes = _forbid_probe(monkeypatch)
    spawn_calls = _spawn_spy(monkeypatch)
    caplog.set_level(logging.ERROR, logger=kc.logger.name)

    client = kc.get_kernel_client(reset=True)
    _assert_stale_raises(client, pid)

    assert spawn_calls == []
    assert probes == []
    errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
    assert any(
        "stale_kernel_detected: pidfile" in msg and ("pid=%s" % pid) in msg
        for msg in errors
    )


def test_alive_pidfile_never_retries_or_recovers(tmp_path, monkeypatch):
    """探活"瞬时失败后恢复"的旧路径已删除：不探活、不重试、不 sleep、不 spawn。"""
    pid = os.getpid()
    _write_live_pidfile(tmp_path, pid=pid)
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    probes = _forbid_probe(monkeypatch)
    spawn_calls = _spawn_spy(monkeypatch)
    sleeps: list = []
    monkeypatch.setattr(time, "sleep", lambda seconds: sleeps.append(seconds))

    client = kc.get_kernel_client(reset=True)
    _assert_stale_raises(client, pid)

    assert probes == []
    assert sleeps == [], "旧探活重试的退避 sleep 必须彻底消失"
    assert spawn_calls == []


# ============================================================
# 2d) pidfile 损坏：存在但不可读/不可解析/pid 非正数 -> pidfile_corrupt
#     绝不能当作"没有 pidfile"而 spawn 第二个内核
# ============================================================

_CORRUPT_HINT_KEYS = ("axeuh_kernel", "删除该 pidfile")


def _corrupt_case_env(tmp_path, monkeypatch) -> list:
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("AXEUH_KERNEL_TOKEN", raising=False)
    return _spawn_spy(monkeypatch)


def _assert_corrupt_pidfile_rejected(
    client, pidfile_path, spawn_calls: list, original: str
) -> kc.KernelUnavailable:
    with pytest.raises(kc.KernelUnavailable) as ei:
        client.ensure()
    assert type(ei.value) is kc.KernelUnavailable
    message = str(ei.value)
    assert message.startswith("pidfile_corrupt: %s" % pidfile_path)
    for key in _CORRUPT_HINT_KEYS:
        assert key in message, "错误必须携带可执行的运维指引: %r" % key
    assert spawn_calls == [], "损坏 pidfile 必须零 spawn（否则可能双内核）"
    assert client._connected is False, "损坏 pidfile 绝不能被静默接管"
    assert pidfile_path.read_text(encoding="utf-8") == original, (
        "损坏 pidfile 绝不能被静默删除或改写"
    )
    return ei.value


def test_corrupt_pidfile_empty_file_raises_without_spawn(tmp_path, monkeypatch):
    pidfile = tmp_path / "kernel.pid"
    pidfile.write_text("", encoding="utf-8")
    spawn_calls = _corrupt_case_env(tmp_path, monkeypatch)

    client = kc.get_kernel_client(reset=True)
    _assert_corrupt_pidfile_rejected(client, pidfile, spawn_calls, "")


def test_corrupt_pidfile_invalid_json_raises_without_spawn(tmp_path, monkeypatch):
    payload = '{"pid": 4242, "port":'
    pidfile = tmp_path / "kernel.pid"
    pidfile.write_text(payload, encoding="utf-8")
    spawn_calls = _corrupt_case_env(tmp_path, monkeypatch)

    client = kc.get_kernel_client(reset=True)
    _assert_corrupt_pidfile_rejected(client, pidfile, spawn_calls, payload)
    assert kc._read_pidfile(tmp_path) is None, "宽松读取器保持停止路径兼容"


@pytest.mark.parametrize("bad_pid", [0, -17])
def test_corrupt_pidfile_non_positive_pid_raises_without_spawn(
    tmp_path, monkeypatch, bad_pid
):
    payload = json.dumps(
        {"port": 55001, "pid": bad_pid, "api_version": "1.0.0"}
    )
    pidfile = tmp_path / "kernel.pid"
    pidfile.write_text(payload, encoding="utf-8")
    spawn_calls = _corrupt_case_env(tmp_path, monkeypatch)

    client = kc.get_kernel_client(reset=True)
    _assert_corrupt_pidfile_rejected(client, pidfile, spawn_calls, payload)


# ============================================================
# 3) 断连映射：连接错误 -> KernelUnavailable（路由层落 503 封闭码）
# ============================================================

def _down_transport(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)


def test_async_request_maps_connect_error_to_kernel_unavailable(tmp_path):
    client = kc.KernelClient(
        base_url="http://kernel.test", token="t",
        transport=httpx.MockTransport(_down_transport),
    )

    async def _call():
        return await client.arequest("GET", "/v1/voiceprint/speakers")

    with pytest.raises(kc.KernelUnavailable) as ei:
        asyncio.run(_call())
    # 封闭码由路由层组装；异常本身携带可读原因
    assert "refused" in str(ei.value) or "connect" in str(ei.value).lower()


def test_sync_request_maps_connect_error_to_kernel_unavailable(tmp_path):
    client = kc.KernelClient(
        base_url="http://kernel.test", token="t",
        transport=httpx.MockTransport(_down_transport),
    )
    with pytest.raises(kc.KernelUnavailable):
        client.srequest("POST", "/v1/voiceprint/score", json={})


def test_kernel_http_error_carries_status_and_envelope(tmp_path):
    """内核 4xx/5xx 信封原样携带（封闭码透传，不吞不改写）。"""

    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={"error": {"code": "input.not_found", "message": "声纹不存在: x",
                            "retryable": False}},
        )

    client = kc.KernelClient(base_url="http://kernel.test", token="t",
                             transport=httpx.MockTransport(_handler))
    with pytest.raises(kc.KernelHttpError) as ei:
        client.srequest("DELETE", "/v1/voiceprint/speakers/x")
    assert ei.value.status == 404
    assert ei.value.body["error"]["code"] == "input.not_found"


def test_success_returns_parsed_json(tmp_path):
    def _handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("Authorization") == "Bearer t"
        return httpx.Response(200, json={"facts": {"count": 0}})

    client = kc.KernelClient(base_url="http://kernel.test", token="t",
                             transport=httpx.MockTransport(_handler))
    data = client.srequest("GET", "/v1/voiceprint/speakers")
    assert data["facts"]["count"] == 0


# ============================================================
# 5) 进程生命周期：父死亡保护（F1 A4）+ 僵尸判活（F1 A3）
# ============================================================

BACKEND_DIR = Path(__file__).resolve().parents[1]

_LINUX_ONLY = pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="PR_SET_PDEATHSIG 与 /proc 僵尸语义仅 Linux 支持",
)

_PARENT_SPAWN_SOURCE = '''\
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, sys.argv[3])

from services import kernel_client as kc

state_dir = Path(sys.argv[1])
ready_path = Path(sys.argv[2])
client = kc.KernelClient(state_dir=state_dir)
client.ensure()
link = kc._read_pidfile(state_dir) or {}
ready_tmp = ready_path.with_suffix(".tmp")
ready_tmp.write_text(
    json.dumps({"child_pid": int(link.get("pid") or 0)}), encoding="utf-8"
)
os.replace(ready_tmp, ready_path)
time.sleep(60)
'''


def _install_fake_kernel(tmp_path: Path) -> Path:
    """假内核包（只握手后长眠），让真实 _spawn 路径可端到端运行。"""
    package = tmp_path / "fake_kernel" / "axeuh_kernel"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "__main__.py").write_text(
        "import json, os, time\n"
        "print(json.dumps({'port': 54321, 'pid': os.getpid(),"
        " 'api_version': 'fake'}), flush=True)\n"
        "time.sleep(120)\n",
        encoding="utf-8",
    )
    return package.parent


def _proc_state(pid: int) -> str:
    """读 /proc/<pid>/stat 的 state 字符；进程不存在返回空串。"""
    try:
        raw = Path("/proc/%d/stat" % pid).read_text(
            encoding="utf-8", errors="replace"
        )
    except OSError:
        return ""
    try:
        return raw[raw.rindex(")") + 2:].split()[0]
    except (ValueError, IndexError):
        return ""


def _wait_until(predicate, timeout: float, message: str) -> float:
    start = time.monotonic()
    while not predicate():
        elapsed = time.monotonic() - start
        if elapsed >= timeout:
            raise AssertionError("%s（等待 %.2fs）" % (message, elapsed))
        time.sleep(0.02)
    return time.monotonic() - start


def _kill_quietly(pid) -> None:
    if not pid:
        return
    try:
        os.kill(int(pid), signal.SIGKILL)
    except (ProcessLookupError, ValueError):
        pass


@_LINUX_ONLY
def test_real_spawn_parent_kill_takes_kernel_down_within_two_seconds(tmp_path):
    """真实 _spawn 路径：kill -9 父进程后，PDEATHSIG 让内核 2s 内消失（F1 A4）。"""
    fake_root = _install_fake_kernel(tmp_path)
    parent_script = tmp_path / "parent_spawn.py"
    parent_script.write_text(_PARENT_SPAWN_SOURCE, encoding="utf-8")
    state_dir = tmp_path / "state"
    ready = tmp_path / "ready.json"
    log_path = tmp_path / "parent.log"

    env = dict(os.environ)
    env["AXEUH_KERNEL_STATE_DIR"] = str(state_dir)
    env["AXEUH_KERNEL_PYTHON"] = sys.executable
    env["PYTHONPATH"] = os.pathsep.join(
        [str(fake_root)]
        + [item for item in (env.get("PYTHONPATH") or "").split(os.pathsep) if item]
    )

    child_pid = None
    with open(log_path, "wb") as log:
        parent = subprocess.Popen(
            [
                sys.executable,
                "-u",
                str(parent_script),
                str(state_dir),
                str(ready),
                str(BACKEND_DIR),
            ],
            cwd=str(BACKEND_DIR),
            env=env,
            stdout=log,
            stderr=log,
        )
        try:
            _wait_until(
                lambda: ready.is_file() or parent.poll() is not None,
                timeout=20.0,
                message="等待父进程写出子进程 pid 超时",
            )
            assert ready.is_file(), (
                "父进程未能 spawn 假内核，日志:\n%s"
                % log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
            )
            child_pid = int(
                json.loads(ready.read_text(encoding="utf-8"))["child_pid"]
            )
            assert child_pid > 0
            assert kc._pid_alive(child_pid), "父进程存活时内核必须存活"
            child_env = dict(
                item.split(b"=", 1)
                for item in Path("/proc/%d/environ" % child_pid)
                .read_bytes()
                .split(b"\0")
                if b"=" in item
            )
            child_pythonpath = child_env.get(b"PYTHONPATH", b"").decode()
            assert str(BACKEND_DIR) not in child_pythonpath.split(os.pathsep)

            os.kill(parent.pid, signal.SIGKILL)
            parent.wait(timeout=5)
            _wait_until(
                lambda: not kc._pid_alive(child_pid),
                timeout=2.0,
                message="父进程 kill -9 后 2s 内内核仍存活 pid=%s" % child_pid,
            )
        finally:
            if parent.poll() is None:
                _kill_quietly(parent.pid)
                parent.wait(timeout=5)
            _kill_quietly(child_pid)


@_LINUX_ONLY
def test_pid_alive_reports_zombie_as_dead(tmp_path, monkeypatch):
    """僵尸（父未 waitpid）对 os.kill 是活的，但 _pid_alive 必须判死。"""
    pid = os.fork()
    if pid == 0:  # pragma: no cover - 子进程立即退出
        os._exit(0)
    try:
        _wait_until(
            lambda: _proc_state(pid) == "Z",
            timeout=5.0,
            message="子进程未进入僵尸态",
        )
        assert kc._pid_alive(pid) is False

        monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
        kc._write_pidfile(
            tmp_path,
            {"pid": pid, "port": 18080, "api_version": "fake", "token": "t"},
        )
        kc.reset_kernel_client()
        start = time.monotonic()
        result = kc.stop_kernel_process(timeout_s=10.0)
        elapsed = time.monotonic() - start

        assert elapsed < 1.0, "僵尸入口停止耗时 %.2fs" % elapsed
        assert result["reason"] == "not-running"
        assert result["pidfile_removed"] is True
        assert not (tmp_path / "kernel.pid").exists()
    finally:
        os.waitpid(pid, 0)


@_LINUX_ONLY
def test_stop_cleans_up_zombie_pidfile_in_under_one_second(tmp_path, monkeypatch):
    """SIGTERM 后内核变僵尸：停止立即判死、删 pidfile、不再白等 12s（F1 A3）。"""
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("AXEUH_KERNEL_PYTHON", raising=False)
    state_dir = tmp_path

    pid = os.fork()
    if pid == 0:  # pragma: no cover - exec 到内核形状的假进程
        try:
            os.execv(
                sys.executable,
                [
                    sys.executable,
                    "-c",
                    "import signal,sys,time; "
                    "signal.signal(signal.SIGTERM, lambda *a: sys.exit(0)); "
                    "time.sleep(60)",
                    "-m",
                    "axeuh_kernel",
                    "--state-dir",
                    str(state_dir),
                ],
            )
        finally:
            os._exit(127)

    try:
        _wait_until(
            lambda: any(
                "axeuh_kernel" in arg for arg in (kc._proc_cmdline(pid) or [])
            ),
            timeout=5.0,
            message="假内核 exec 未完成",
        )
        kc._write_pidfile(
            state_dir,
            {"pid": pid, "port": 18080, "api_version": "fake", "token": "t"},
        )
        kc.reset_kernel_client()
        assert kc._pid_alive(pid) is True

        start = time.monotonic()
        result = kc.stop_kernel_process(timeout_s=10.0)
        elapsed = time.monotonic() - start

        assert elapsed < 1.0, "僵尸判活回归：停止耗时 %.2fs" % elapsed
        assert result["stopped"] is True
        assert result["signal"] == "SIGTERM"
        assert result["pidfile_removed"] is True
        assert not (state_dir / "kernel.pid").exists()
        assert _proc_state(pid) == "Z", "此时应仍是未被父进程回收的僵尸"
        assert kc._pid_alive(pid) is False
    finally:
        _kill_quietly(pid)
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass


# ============================================================
# 6) B2 扩缝：score_all_v2 的 sliding/collect 透传与降级形状
# ============================================================

def _score_handler(capture: dict, facts: dict):
    """捕获请求 body 并回内核信封的 MockTransport 处理器。"""

    def _handler(request: httpx.Request) -> httpx.Response:
        capture["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(200, json={"facts": facts})

    return _handler


def test_score_all_v2_passes_sliding_and_collect(tmp_path, monkeypatch):
    """B2: detail=True + sliding/collect/collect_meta -> body 逐键透传，
    facts 的 windows/win_max/win_pct/collected 原样并入返回（旧调用零感知）。"""
    import numpy as np

    capture: dict = {}
    facts = {
        "scores": {"小贺": 0.82}, "raw": {"小贺": 0.6},
        "imp_mean": 0.1, "imp_std": 0.2, "n_cohort": 500, "as_norm_on": True,
        "windows": [0, 0.85, 750, 0.4], "win_max": 0.85,
        "win_pct": 0.5, "windows_total": 2,
        "collected": True, "collect_reason": "written",
    }
    client = kc.KernelClient(base_url="http://kernel.test", token="t",
                             transport=httpx.MockTransport(_score_handler(capture, facts)))
    monkeypatch.setattr(kc, "get_kernel_client", lambda: client)

    out = kc.score_all_v2(
        np.zeros(16000, dtype=np.float32), sample_rate=16000, detail=True,
        sliding={"window_ms": 1500, "hop_ms": 750},
        collect=True,
        collect_meta={"src_file": "a.wav", "src_t": "10:00:00",
                      "src_start": 0.2, "src_end": 1.8, "speech_prob": 0.9},
    )
    body = capture["body"]
    assert body["sliding"] == {"window_ms": 1500, "hop_ms": 750}
    assert body["collect"] is True
    assert body["collect_meta"]["src_file"] == "a.wav"
    # None 值剔除（内核 CollectMeta 键缺省走内核口径）
    assert "env_tag" not in body["collect_meta"]
    # facts 全键并入（含 A2 additive 六键），六键旧形状保持
    assert out["scores"] == {"小贺": 0.82}
    assert out["windows"] == [0, 0.85, 750, 0.4]
    assert out["win_max"] == 0.85 and out["win_pct"] == 0.5
    assert out["collected"] is True and out["collect_reason"] == "written"


def test_score_all_v2_omits_extras_when_unset(tmp_path, monkeypatch):
    """旧调用（不传 sliding/collect）: body 只含 audio_b64，回归锁零感知。"""
    import numpy as np

    capture: dict = {}
    client = kc.KernelClient(
        base_url="http://kernel.test", token="t",
        transport=httpx.MockTransport(_score_handler(capture, {"scores": {}})))
    monkeypatch.setattr(kc, "get_kernel_client", lambda: client)

    scores = kc.score_all_v2(np.zeros(1600, dtype=np.float32))
    assert scores == {}
    assert set(capture["body"].keys()) == {"audio_b64"}


def test_score_all_v2_down_degrades_with_requested_shapes(monkeypatch):
    """不可达 + sliding/collect 请求: 空 detail 也带请求过的 extras 键
    （调用方按 None/[] 降级消费，不再触发 fact_extractor 未校验以外的形态意外）。"""
    import numpy as np

    client = kc.KernelClient(base_url="http://kernel.test", token="t",
                             transport=httpx.MockTransport(_down_transport))
    monkeypatch.setattr(kc, "get_kernel_client", lambda: client)
    kc._reset_down_state()

    out = kc.score_all_v2(
        np.zeros(1600, dtype=np.float32), detail=True,
        sliding={"window_ms": 1500, "hop_ms": 750}, collect=True,
    )
    assert out["scores"] == {}
    assert out["windows"] == [] and out["win_max"] is None
    assert out["windows_total"] == 0
    assert out["collected"] is False and out["collect_reason"] == "not_scored"
    # 旧 detail 六键恒在
    for k in ("raw", "imp_mean", "imp_std", "n_cohort", "as_norm_on"):
        assert k in out


# ============================================================
# 4) 异步 spawn（T45）：ensure_async 在事件循环线程内 spawn，
#    握手（模型加载 25~60s）期间绝不阻塞 loop
# ============================================================

_DELAYED_FAKE_KERNEL = """\
#!{python}
import json
import os
import sys
import time

args = sys.argv[1:]
time.sleep({delay})
print(
    json.dumps(
        {{"port": 54321, "pid": os.getpid(), "api_version": "fake-delayed"}}
    ),
    flush=True,
)
time.sleep(30)
"""


def _kill_pidfile_child(state_dir: Path) -> None:
    """按 pidfile 里的精确 PID 回收测试假内核（失败即忽略）。"""
    data = kc._read_pidfile(state_dir) or {}
    pid = kc._int_or_zero(data.get("pid"))
    if pid <= 0:
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, ValueError, OSError):
        pass


class _FakeAsyncStdout:
    """伪造内核异步 stdout：可延迟、可永久挂起、只吐一行握手。"""

    def __init__(
        self, line: bytes = b"", *, delay: float = 0.0, hang: bool = False
    ) -> None:
        self._line = line
        self._delay = delay
        self._hang = hang
        self._served = False

    async def readline(self) -> bytes:
        if self._hang:
            await asyncio.sleep(3600.0)
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._served:
            return b""
        self._served = True
        return self._line


class _FakeAsyncProc:
    """伪造 ``asyncio.subprocess.Process``：记录 terminate/kill/wait。"""

    def __init__(
        self,
        handshake: dict | None = None,
        *,
        pid: int = 4242,
        delay: float = 0.0,
        hang: bool = False,
        exit_code: int | None = None,
        line: bytes | None = None,
    ) -> None:
        if line is None:
            line = (
                b""
                if handshake is None
                else (json.dumps(handshake) + "\n").encode("utf-8")
            )
        self.stdout = _FakeAsyncStdout(line, delay=delay, hang=hang)
        self.pid = pid
        self.returncode = exit_code
        self.terminated = False
        self.killed = False
        self.wait_calls = 0

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    async def wait(self) -> int | None:
        self.wait_calls += 1
        return self.returncode


def _install_async_spawn(monkeypatch, procs: list) -> dict:
    """注入 ``kc._popen_async``：记录 cmd/cwd/env，队列空即视为双 spawn 失败。"""
    capture: dict = {"calls": 0, "cmd": None, "cwd": None, "env": None}
    queue = list(procs)

    async def _spawn(cmd, cwd=None, env=None, **kwargs):
        capture["calls"] += 1
        capture["cmd"] = list(cmd)
        capture["cwd"] = cwd
        capture["env"] = env
        if not queue:
            raise AssertionError("ensure_async 只允许 spawn 一次（双 spawn 即回归）")
        return queue.pop(0)

    monkeypatch.setattr(kc, "_popen_async", _spawn)
    monkeypatch.setattr(
        kc.KernelClient,
        "_seed_state_from_outer",
        staticmethod(lambda state_dir: None),
    )
    return capture


def _forbid_async_spawn(monkeypatch) -> list:
    calls: list = []

    async def _spawn(*args, **kwargs):  # pragma: no cover - 命中即失败
        calls.append(args)
        raise AssertionError("该路径绝不允许 spawn 内核")

    monkeypatch.setattr(kc, "_popen_async", _spawn)
    return calls


def _async_env(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("AXEUH_KERNEL_TOKEN", raising=False)


def test_async_spawn_parses_handshake_and_persists_pidfile(tmp_path, monkeypatch):
    """异步路径与同步路径同契约：握手 -> base_url + pidfile（含 nonce/created_at）。"""
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    proc = _FakeAsyncProc(handshake)
    capture = _install_async_spawn(monkeypatch, [proc])
    _async_env(tmp_path, monkeypatch)
    monkeypatch.setenv("AXEUH_KERNEL_TOKEN", "async-token")
    monkeypatch.setattr(kc, "_process_creation_time", lambda pid: 1700000000.5)

    async def scenario():
        client = kc.get_kernel_client(reset=True)
        await client.ensure_async()
        return client

    client = asyncio.run(scenario())

    assert client.base_url == "http://127.0.0.1:54321"
    assert client.token == "async-token"
    assert client._connected is True
    data = json.loads((tmp_path / "kernel.pid").read_text(encoding="utf-8"))
    assert (data["port"], data["pid"]) == (54321, 4242)
    assert data["api_version"] == "1.0.0"
    assert data["token"] == "async-token"
    assert len(data["nonce"]) == 32
    assert data["created_at"] == 1700000000.5

    cmd = capture["cmd"]
    assert cmd[0] == sys.executable
    assert cmd[1] == str(
        BACKEND_DIR / "services" / "orchestrator" / "child_entry.py"
    )
    assert cmd[cmd.index("-m") + 1] == "axeuh_kernel"
    assert cmd[cmd.index("--port") + 1] == "0"
    assert cmd[cmd.index("--state-dir") + 1] == str(tmp_path)
    assert capture["cwd"] == str(kc._KERNEL_DIR)
    assert "async-token" not in " ".join(str(x) for x in cmd), "token 泄漏进 argv"
    assert capture["env"]["AXEUH_KERNEL_TOKEN"] == "async-token"


def test_async_spawn_created_at_falls_back_when_unreadable(tmp_path, monkeypatch):
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    proc = _FakeAsyncProc(handshake)
    _install_async_spawn(monkeypatch, [proc])
    _async_env(tmp_path, monkeypatch)
    monkeypatch.setattr(kc, "_process_creation_time", lambda pid: None)
    before = time.time()

    async def scenario():
        client = kc.get_kernel_client(reset=True)
        await client.ensure_async()
        return client

    asyncio.run(scenario())

    data = json.loads((tmp_path / "kernel.pid").read_text(encoding="utf-8"))
    assert data["created_at"] >= before
    assert data["created_at"] <= time.time()


@_LINUX_ONLY
def test_async_ensure_does_not_block_loop_while_kernel_handshakes(
    tmp_path, monkeypatch
):
    """真实子进程 2s 后才握手：ensure_async 在途时 ticker 必须持续推进。"""
    kernel_script = tmp_path / "fake_kernel_delayed"
    kernel_script.write_text(
        _DELAYED_FAKE_KERNEL.format(python=sys.executable, delay=2.0),
        encoding="utf-8",
    )
    kernel_script.chmod(0o755)
    _async_env(tmp_path, monkeypatch)
    monkeypatch.setattr(
        kc.KernelClient,
        "_seed_state_from_outer",
        staticmethod(lambda state_dir: None),
    )
    monkeypatch.setattr(
        kernel_assets,
        "resolve_kernel_python",
        lambda *, project_root=None: {
            "path": str(kernel_script),
            "source": "test",
            "exists": True,
            "last_resort": False,
        },
    )

    ticks: list = []

    async def scenario():
        client = kc.get_kernel_client(reset=True)
        stop = asyncio.Event()

        async def ticker() -> None:
            while not stop.is_set():
                ticks.append(time.monotonic())
                await asyncio.sleep(0.01)

        ticker_task = asyncio.create_task(ticker())
        started = time.monotonic()
        await client.ensure_async()
        elapsed = time.monotonic() - started
        pid = kc._int_or_zero((kc._read_pidfile(tmp_path) or {}).get("pid"))
        if pid > 0:
            with contextlib.suppress(ProcessLookupError, OSError):
                os.kill(pid, signal.SIGTERM)
        await asyncio.sleep(0.3)
        stop.set()
        await ticker_task
        return client, elapsed

    try:
        client, elapsed = asyncio.run(scenario())
        assert elapsed >= 1.8, "假内核必须真的延迟握手，而不是瞬间返回"
        assert len(ticks) >= 50, (
            "握手等待期间事件循环被阻塞：ticker 只推进了 %d 次" % len(ticks)
        )
        assert client._connected is True
        assert (tmp_path / "kernel.pid").is_file()
    finally:
        _kill_pidfile_child(tmp_path)


def test_concurrent_ensure_async_spawns_exactly_once(tmp_path, monkeypatch):
    proc = _FakeAsyncProc(
        {"port": 55001, "pid": 4343, "api_version": "1.0.0"}, delay=0.2
    )
    capture = _install_async_spawn(monkeypatch, [proc])
    _async_env(tmp_path, monkeypatch)
    monkeypatch.setattr(kc, "_process_creation_time", lambda pid: 1700000000.5)

    async def scenario():
        client = kc.get_kernel_client(reset=True)
        await asyncio.gather(*(client.ensure_async() for _ in range(5)))
        return client

    client = asyncio.run(scenario())

    assert capture["calls"] == 1, "并发 ensure_async 绝不允许双 spawn"
    assert client.base_url == "http://127.0.0.1:55001"
    assert client._connected is True


def test_async_handshake_timeout_terminates_child_without_pidfile(
    tmp_path, monkeypatch
):
    proc = _FakeAsyncProc(hang=True)
    _install_async_spawn(monkeypatch, [proc])
    _async_env(tmp_path, monkeypatch)
    monkeypatch.setattr(kc, "_HANDSHAKE_TIMEOUT_S", 0.05)

    async def scenario():
        client = kc.get_kernel_client(reset=True)
        with pytest.raises(kc.KernelUnavailable) as ei:
            await client.ensure_async()
        return ei.value, client

    exc, client = asyncio.run(scenario())

    assert "超时" in str(exc)
    assert proc.terminated is True
    assert proc.wait_calls >= 1
    assert not (tmp_path / "kernel.pid").exists(), "失败路径不得遗留 pidfile"
    assert client._connected is False


def test_async_child_exit_before_handshake_raises_and_cleans(tmp_path, monkeypatch):
    proc = _FakeAsyncProc(None, exit_code=7)
    _install_async_spawn(monkeypatch, [proc])
    _async_env(tmp_path, monkeypatch)

    async def scenario():
        client = kc.get_kernel_client(reset=True)
        with pytest.raises(kc.KernelUnavailable) as ei:
            await client.ensure_async()
        return ei.value, client

    exc, client = asyncio.run(scenario())

    assert "退出" in str(exc) and "7" in str(exc)
    assert proc.wait_calls >= 1
    assert not (tmp_path / "kernel.pid").exists()
    assert client._connected is False


def test_async_invalid_handshake_terminates_child(tmp_path, monkeypatch):
    proc = _FakeAsyncProc(None, line=b"{not-json}\n")
    _install_async_spawn(monkeypatch, [proc])
    _async_env(tmp_path, monkeypatch)

    async def scenario():
        client = kc.get_kernel_client(reset=True)
        with pytest.raises(kc.KernelUnavailable) as ei:
            await client.ensure_async()
        return ei.value

    exc = asyncio.run(scenario())

    assert "握手行非法" in str(exc)
    assert proc.terminated is True
    assert not (tmp_path / "kernel.pid").exists()


def test_async_cancel_terminates_spawned_child(tmp_path, monkeypatch):
    """编排器关停会取消在途 start：已创建的子进程必须按精确 PID 回收。"""
    proc = _FakeAsyncProc(hang=True)
    _async_env(tmp_path, monkeypatch)
    spawned = asyncio.Event()

    async def scenario():
        client = kc.get_kernel_client(reset=True)

        async def _spawn(cmd, cwd=None, env=None, **kwargs):
            spawned.set()
            return proc

        monkeypatch.setattr(kc, "_popen_async", _spawn)
        task = asyncio.create_task(client.ensure_async())
        await asyncio.wait_for(spawned.wait(), timeout=2.0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return client

    client = asyncio.run(scenario())

    assert proc.terminated is True
    assert proc.wait_calls >= 1
    assert not (tmp_path / "kernel.pid").exists()
    assert client._connected is False


def test_async_live_pidfile_raises_stale_without_spawn(tmp_path, monkeypatch):
    pid = os.getpid()
    _write_live_pidfile(tmp_path, pid=pid)
    _async_env(tmp_path, monkeypatch)
    spawn_calls = _forbid_async_spawn(monkeypatch)

    async def scenario():
        client = kc.get_kernel_client(reset=True)
        with pytest.raises(kc.KernelUnavailable) as ei:
            await client.ensure_async()
        return ei.value, client

    exc, client = asyncio.run(scenario())

    assert str(exc) == STALE_ERROR_TEMPLATE % pid
    assert spawn_calls == []
    assert client._connected is False


@pytest.mark.parametrize(
    "payload",
    [
        "",
        '{"pid": 4242, "port":',
        json.dumps({"port": 55001, "pid": 0, "api_version": "1.0.0"}),
    ],
)
def test_async_corrupt_pidfile_raises_without_spawn(tmp_path, monkeypatch, payload):
    pidfile = tmp_path / "kernel.pid"
    pidfile.write_text(payload, encoding="utf-8")
    _async_env(tmp_path, monkeypatch)
    spawn_calls = _forbid_async_spawn(monkeypatch)

    async def scenario():
        client = kc.get_kernel_client(reset=True)
        with pytest.raises(kc.KernelUnavailable) as ei:
            await client.ensure_async()
        return ei.value, client

    exc, client = asyncio.run(scenario())

    message = str(exc)
    assert message.startswith("pidfile_corrupt: %s" % pidfile)
    for key in _CORRUPT_HINT_KEYS:
        assert key in message
    assert spawn_calls == []
    assert client._connected is False
    assert pidfile.read_text(encoding="utf-8") == payload, "损坏 pidfile 不得被改写"


def test_async_reloading_blocks_spawn(tmp_path, monkeypatch):
    _async_env(tmp_path, monkeypatch)
    monkeypatch.setattr(kc, "_reloading", True)
    spawn_calls = _forbid_async_spawn(monkeypatch)

    async def scenario():
        client = kc.get_kernel_client(reset=True)
        with pytest.raises(kc.KernelUnavailable) as ei:
            await client.ensure_async()
        return ei.value

    exc = asyncio.run(scenario())

    assert "_reloading" in str(exc)
    assert spawn_calls == []


def test_async_fast_path_returns_without_spawn(tmp_path, monkeypatch):
    _async_env(tmp_path, monkeypatch)
    spawn_calls = _forbid_async_spawn(monkeypatch)
    client = kc.get_kernel_client(reset=True)
    client._connected = True

    asyncio.run(client.ensure_async())

    assert spawn_calls == []
