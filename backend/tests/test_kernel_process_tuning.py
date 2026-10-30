# -*- coding: utf-8 -*-
"""内核进程调优（T1）：config 解析 + spawn 后 CPU 亲和 / nice 应用。

契约：
  - config kernel.cpu_affinity: list[int] 或 "2-4" / "2,3,4" 字符串 -> list[int]，
    负数与非法值被过滤，空 = 不限制（默认 []）
  - config kernel.nice: int 或数字字符串 -> Optional[int]，非法 = None，
    夹取到 [-20, 19]（默认 None）
  - spawn: _popen 之后、握手之前对 proc.pid 做 os.sched_setaffinity /
    os.setpriority；未配置时零 syscall；任一 syscall 失败只 WARNING，不阻断握手
  - 仅 POSIX 生效（os.name != "nt"）
"""
import json
import logging
import os

import pytest

import config.config as cfg_mod
from config.config import Config
from services import kernel_client as kc

pytestmark = pytest.mark.skipif(os.name == "nt", reason="内核进程调优仅 POSIX 生效")


def _config_with_kernel(**kernel) -> Config:
    """构造 Config（补齐 opencode 必填项，避免 _validate_opencode 抛错）。"""
    return Config({
        "opencode": {
            "default_model": "m",
            "default_provider": "p",
            "default_agent": "a",
        },
        "kernel": kernel,
    })


# ============================================================
# 1) 配置属性：默认值 / 解析 / 过滤 / 夹取
# ============================================================

def test_kernel_tuning_defaults_are_unconfigured():
    cfg = _config_with_kernel()
    assert cfg.KERNEL_CPU_AFFINITY == []
    assert cfg.KERNEL_NICE is None


def test_cpu_affinity_accepts_int_list_filtering_invalid():
    cfg = _config_with_kernel(cpu_affinity=[2, 3, 4, -1, "x", "5"])
    assert cfg.KERNEL_CPU_AFFINITY == [2, 3, 4, 5]


def test_cpu_affinity_accepts_range_and_comma_string():
    assert _config_with_kernel(cpu_affinity="2-4").KERNEL_CPU_AFFINITY == [2, 3, 4]
    assert _config_with_kernel(cpu_affinity=" 2,3,4 ").KERNEL_CPU_AFFINITY == [2, 3, 4]
    assert _config_with_kernel(cpu_affinity="4,2,2,-1,x").KERNEL_CPU_AFFINITY == [2, 4]


def test_cpu_affinity_empty_or_invalid_means_unrestricted():
    assert _config_with_kernel(cpu_affinity=None).KERNEL_CPU_AFFINITY == []
    assert _config_with_kernel(cpu_affinity="").KERNEL_CPU_AFFINITY == []
    assert _config_with_kernel(cpu_affinity="garbage").KERNEL_CPU_AFFINITY == []


def test_cuda_visible_devices_parses():
    assert _config_with_kernel().KERNEL_CUDA_VISIBLE_DEVICES == ""
    assert _config_with_kernel(cuda_visible_devices=" 1 ").KERNEL_CUDA_VISIBLE_DEVICES == "1"
    assert _config_with_kernel(cuda_visible_devices="0,1").KERNEL_CUDA_VISIBLE_DEVICES == "0,1"


def test_nice_parses_and_clamps():
    assert _config_with_kernel(nice=10).KERNEL_NICE == 10
    assert _config_with_kernel(nice="-5").KERNEL_NICE == -5
    assert _config_with_kernel(nice=30).KERNEL_NICE == 19
    assert _config_with_kernel(nice=-30).KERNEL_NICE == -20
    assert _config_with_kernel(nice="high").KERNEL_NICE is None
    assert _config_with_kernel(nice="19.5").KERNEL_NICE is None


# ============================================================
# spawn 桩：伪 Popen + 伪 stdout 单行握手
# ============================================================

class _FakeStdout:
    def __init__(self, line: bytes):
        self._line = line
        self._read = False

    def readline(self) -> bytes:
        if self._read:
            return b""
        self._read = True
        return self._line


class _FakeProc:
    def __init__(self, handshake: dict):
        self.stdout = _FakeStdout((json.dumps(handshake) + "\n").encode("utf-8"))
        self.pid = handshake.get("pid", 4242)


def _install_fake_popen(monkeypatch, handshake: dict) -> None:
    fake = _FakeProc(handshake)

    def _popen(cmd, cwd=None, env=None, **kwargs):
        return fake

    monkeypatch.setattr(kc, "_popen", _popen)


def _install_fake_config(monkeypatch, **kernel) -> None:
    class _FakeCfg:
        KERNEL_DEVICE = ""
        KERNEL_CUDA_VISIBLE_DEVICES = kernel.get("cuda_visible_devices", "")
        KERNEL_CPU_AFFINITY = list(kernel.get("cpu_affinity") or [])
        KERNEL_NICE = kernel.get("nice")

    monkeypatch.setattr(cfg_mod, "get_config", lambda: _FakeCfg())


def _spawn_client(tmp_path, monkeypatch) -> kc.KernelClient:
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("AXEUH_KERNEL_TOKEN", "t")
    client = kc.get_kernel_client(reset=True)
    client.ensure()
    return client


# ============================================================
# 2) spawn 应用调优 syscall（fake Popen 的 pid）
# ============================================================

def test_spawn_applies_affinity_and_nice_to_popen_pid(tmp_path, monkeypatch):
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    _install_fake_popen(monkeypatch, handshake)
    _install_fake_config(monkeypatch, cpu_affinity=[2, 3], nice=10)

    affinity_calls: list = []
    nice_calls: list = []
    monkeypatch.setattr(
        kc.os, "sched_setaffinity",
        lambda pid, cpus: affinity_calls.append((pid, list(cpus))),
        raising=False,
    )
    monkeypatch.setattr(
        kc.os, "setpriority",
        lambda which, pid, prio: nice_calls.append((which, pid, prio)),
        raising=False,
    )

    client = _spawn_client(tmp_path, monkeypatch)

    assert client.base_url == "http://127.0.0.1:54321"
    assert affinity_calls == [(4242, [2, 3])]
    assert nice_calls == [(os.PRIO_PROCESS, 4242, 10)]


def test_spawn_injects_cuda_visible_devices(tmp_path, monkeypatch):
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    fake = _FakeProc(handshake)
    capture: dict = {}

    def _popen(cmd, cwd=None, env=None, **kwargs):
        capture["env"] = env
        return fake

    monkeypatch.setattr(kc, "_popen", _popen)
    _install_fake_config(monkeypatch, cpu_affinity=[], nice=None, cuda_visible_devices="1")

    _spawn_client(tmp_path, monkeypatch)

    assert capture["env"].get("CUDA_VISIBLE_DEVICES") == "1"


def test_spawn_omits_cuda_visible_devices_when_unconfigured(tmp_path, monkeypatch):
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    fake = _FakeProc(handshake)
    capture: dict = {}

    def _popen(cmd, cwd=None, env=None, **kwargs):
        capture["env"] = env
        return fake

    monkeypatch.setattr(kc, "_popen", _popen)
    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)
    _install_fake_config(monkeypatch, cpu_affinity=[], nice=None)

    _spawn_client(tmp_path, monkeypatch)

    assert "CUDA_VISIBLE_DEVICES" not in capture["env"]


def test_spawn_unconfigured_makes_no_tuning_syscalls(tmp_path, monkeypatch):
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    _install_fake_popen(monkeypatch, handshake)
    _install_fake_config(monkeypatch, cpu_affinity=[], nice=None)

    def _no_syscall(*args, **kwargs):  # pragma: no cover - 命中即失败
        raise AssertionError("未配置时不允许发生调优 syscall")

    monkeypatch.setattr(kc.os, "sched_setaffinity", _no_syscall, raising=False)
    monkeypatch.setattr(kc.os, "setpriority", _no_syscall, raising=False)

    client = _spawn_client(tmp_path, monkeypatch)
    assert client.base_url == "http://127.0.0.1:54321"
    assert json.loads((tmp_path / "kernel.pid").read_text(encoding="utf-8"))["pid"] == 4242


def test_spawn_survives_tuning_syscall_failure(tmp_path, monkeypatch, caplog):
    handshake = {"port": 54321, "pid": 4242, "api_version": "1.0.0"}
    _install_fake_popen(monkeypatch, handshake)
    _install_fake_config(monkeypatch, cpu_affinity=[2], nice=10)

    def _boom(*args, **kwargs):
        raise OSError("permission denied")

    monkeypatch.setattr(kc.os, "sched_setaffinity", _boom, raising=False)
    monkeypatch.setattr(kc.os, "setpriority", _boom, raising=False)

    caplog.set_level(logging.WARNING, logger=kc.logger.name)
    client = _spawn_client(tmp_path, monkeypatch)

    # 调优失败不阻断：握手照常完成、连接可用、pidfile 落盘
    assert client.base_url == "http://127.0.0.1:54321"
    assert client.token == "t"
    assert json.loads((tmp_path / "kernel.pid").read_text(encoding="utf-8"))["port"] == 54321
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) >= 2, "两个 syscall 失败应各记一条 WARNING"
