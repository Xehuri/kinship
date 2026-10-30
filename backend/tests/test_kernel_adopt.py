# -*- coding: utf-8 -*-
"""显式只读 adopt：挂接既有内核但绝不 spawn、绝不停止。

adopt 的用途是后端在线时的运维脚本（cohort 重建等）：自动复用已删除后，
脚本必须显式表明"我知道 pid，只读挂接"。因此本文件同时锁定三件事：
1) adopt 只读（不调用 _popen / stop / terminate）；
2) adopt 后的客户端 stop() 是 no-op，pidfile 原样保留；
3) pidfile 不匹配/pid 不存活/缺 pidfile 时拒绝挂接，绝不猜测端口。
"""
from __future__ import annotations

import json
import os

import pytest

from services import kernel_client as kc

PORT = 54999
TOKEN = "adopted-token"


def _write_pidfile(
    state_dir,
    *,
    pid=None,
    port=PORT,
    token=TOKEN,
    nonce="nonce-adopt",
    created_at=1700000000.0,
):
    data = {
        "pid": os.getpid() if pid is None else pid,
        "port": port,
        "api_version": "1.0.0",
        "token": token,
        "nonce": nonce,
        "created_at": created_at,
    }
    (state_dir / "kernel.pid").write_text(json.dumps(data), encoding="utf-8")


@pytest.fixture
def adopt_env(monkeypatch, tmp_path):
    monkeypatch.setattr(kc, "_state_dir", lambda: tmp_path)
    monkeypatch.setattr(kc, "_probe_health", lambda port, timeout=1.5: True)
    spawned: list = []

    def _no_spawn(*args, **kwargs):  # pragma: no cover - 命中即失败
        spawned.append(args)
        raise AssertionError("adopt 绝不允许 spawn")

    monkeypatch.setattr(kc, "_popen", _no_spawn)
    kc.reset_kernel_client()
    kc._reset_down_state()
    yield tmp_path, spawned
    # reset 会立刻新建客户端；先撤销 _state_dir patch，避免残留单例绑定 tmp_path。
    monkeypatch.undo()
    kc.reset_kernel_client()


def test_adopt_attaches_without_spawning(adopt_env):
    state_dir, spawned = adopt_env
    _write_pidfile(state_dir)

    result = kc.adopt_kernel(os.getpid())

    client = kc.get_kernel_client()
    assert result["adopted"] is True
    assert result["pid"] == os.getpid()
    assert result["port"] == PORT
    assert result["healthy"] is True
    assert result["nonce"] == "nonce-adopt"
    assert client.adopted is True
    assert client._connected is True
    assert client.base_url == "http://127.0.0.1:%d" % PORT
    assert client.token == TOKEN
    assert spawned == []


def test_adopt_stop_is_noop_and_leaves_pidfile(adopt_env, monkeypatch):
    state_dir, _ = adopt_env
    _write_pidfile(state_dir)
    kc.adopt_kernel(os.getpid())

    def _no_signal(*args, **kwargs):  # pragma: no cover - 命中即失败
        raise AssertionError("adopt 客户端的 stop 不得发送任何信号")

    monkeypatch.setattr(kc.os, "kill", _no_signal)

    client_result = kc.get_kernel_client().stop()
    module_result = kc.stop_kernel_process()

    assert client_result == {
        "stopped": False,
        "reason": "adopted",
        "pid": os.getpid(),
    }
    assert module_result == client_result
    assert (state_dir / "kernel.pid").exists()


def test_adopt_restart_refuses(adopt_env):
    state_dir, _ = adopt_env
    _write_pidfile(state_dir)
    kc.adopt_kernel(os.getpid())

    result = kc.restart_kernel(eager=True)

    assert result["status"] == "error"
    assert "adopt" in result["error"]
    assert (state_dir / "kernel.pid").exists()


def test_adopt_ensure_does_not_spawn(adopt_env):
    state_dir, spawned = adopt_env
    _write_pidfile(state_dir)
    kc.adopt_kernel(os.getpid())

    kc.get_kernel_client().ensure()

    assert spawned == []


def test_adopt_rejects_dead_pid(adopt_env):
    state_dir, _ = adopt_env
    dead_pid = 2**22 + 4321
    _write_pidfile(state_dir, pid=dead_pid)

    with pytest.raises(kc.KernelUnavailable) as ei:
        kc.adopt_kernel(dead_pid)
    assert "不存活" in str(ei.value)


def test_adopt_rejects_missing_pidfile(adopt_env):
    state_dir, _ = adopt_env

    with pytest.raises(kc.KernelUnavailable) as ei:
        kc.adopt_kernel(os.getpid())
    assert "pidfile" in str(ei.value)
    assert not (state_dir / "kernel.pid").exists()


def test_adopt_rejects_pid_mismatch(adopt_env):
    state_dir, _ = adopt_env
    parent = os.getppid()
    if parent == os.getpid():  # pragma: no cover - 常规环境不会出现
        pytest.skip("父进程 pid 与当前进程相同，无法构造不匹配场景")
    _write_pidfile(state_dir, pid=parent)

    with pytest.raises(kc.KernelUnavailable) as ei:
        kc.adopt_kernel(os.getpid())
    assert "不匹配" in str(ei.value)


def test_adopt_rejects_invalid_pid(adopt_env):
    adopt_env

    with pytest.raises(kc.KernelUnavailable):
        kc.adopt_kernel(0)
    with pytest.raises(kc.KernelUnavailable):
        kc.adopt_kernel("not-a-pid")


def test_adopt_marks_only_the_singleton(adopt_env):
    state_dir, _ = adopt_env
    _write_pidfile(state_dir)
    kc.adopt_kernel(os.getpid())

    assert kc.get_kernel_client().adopted is True
    kc.reset_kernel_client()
    assert kc.get_kernel_client().adopted is False
