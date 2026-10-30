# -*- coding: utf-8 -*-
"""Windows-mocked parity matrix for onboarding storage/kernel/Loom/client code.

Runs on Linux without a Windows host: every Windows-only branch is exercised
through platform flags, fake paths or fake process handles. No real service
manager, subprocess, network call or production file is touched.

Coverage:
  * ``config.paths``: drive/UNC absolute inputs and project-relative resolution.
  * kernel model env: backend pins roots under ``models_root`` even when
    ``LOCALAPPDATA`` exists; ``kernel.model_dir`` still wins.
  * ``kernel_assets``: Windows liveness uses handle probes (never ``os.kill``)
    and the local venv candidate uses ``Scripts/python.exe``.
  * ``kernel_client``: Windows spawn passes hidden-window and new-process-group
    creation flags; POSIX spawn keeps plain Popen kwargs.
  * ``loom_runtime``: systemctl-free mode detection, detached spawn flags,
    TerminateProcess stop path, PID fingerprint rejection, chmod-tolerant token
    provisioning, and no shell / name-based kill strings.
  * client catalog: fallback order is identical under ``sys.platform=win32``.
"""

from __future__ import annotations

import ast
import ctypes
import inspect
import sys
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace
from typing import Any

import pytest

from config import paths
from config.config import Config
from services import client_artifacts, client_release_manifest, clients_catalog
from services import kernel_assets as ka
from services import kernel_client as kc
from services import kernel_model_paths as kmp
from services import loom_runtime as rt

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

_SCANNED_MODULES = (
    paths,
    kmp,
    ka,
    rt,
    clients_catalog,
    client_release_manifest,
    client_artifacts,
)

_FORBIDDEN_KILL_COMMANDS = {"taskkill", "pkill", "killall"}


class _FakeWindowsPath:
    """Minimal ``WindowsPath`` stand-in that never touches the host filesystem."""

    def __init__(self, value: str | PureWindowsPath) -> None:
        self._value = value if isinstance(value, PureWindowsPath) else PureWindowsPath(value)

    def expanduser(self) -> "_FakeWindowsPath":
        return self

    def is_absolute(self) -> bool:
        return self._value.is_absolute()

    def resolve(self) -> "_FakeWindowsPath":
        return self

    def __truediv__(self, child: Any) -> "_FakeWindowsPath":
        value = child._value if isinstance(child, _FakeWindowsPath) else child
        return _FakeWindowsPath(self._value / value)

    def __str__(self) -> str:
        return str(self._value)


def _fake_windows_project(monkeypatch, project: str = "C:/project") -> None:
    monkeypatch.setattr(paths, "Path", _FakeWindowsPath)
    monkeypatch.setattr(paths, "project_root", lambda: _FakeWindowsPath(project))


def _loom_config(tmp_path: Path, *, token: str = "") -> Config:
    return Config(
        {
            "loom": {
                "url": "http://127.0.0.1:5100",
                "token": token,
                "manage_config": True,
            },
            "data": {"ai_root": str(tmp_path / "ai")},
        }
    )


# ── config.paths ─────────────────────────────────────────────


class TestWindowsPaths:
    def test_drive_absolute_path_is_kept(self, monkeypatch):
        _fake_windows_project(monkeypatch)

        resolved = paths._resolve_from_project_root(r"D:\Kinship\Data", windows=True)

        assert str(resolved) == r"D:\Kinship\Data"

    def test_unc_absolute_path_is_kept(self, monkeypatch):
        _fake_windows_project(monkeypatch)

        resolved = paths._resolve_from_project_root(
            r"\\nas\share\axeuh-data", windows=True
        )

        assert str(resolved) == r"\\nas\share\axeuh-data"

    def test_relative_path_joins_windows_project_root(self, monkeypatch):
        _fake_windows_project(monkeypatch)

        resolved = paths._resolve_from_project_root(r"runtime\data", windows=True)

        assert str(resolved) == r"C:\project\runtime\data"

    def test_windows_default_model_dir_follows_models_root(self, monkeypatch):
        monkeypatch.setattr(
            kmp,
            "models_root",
            lambda: _FakeWindowsPath(r"C:\Kinship\var\models"),
        )

        assert str(kmp.default_model_dir()) == (
            r"C:\Kinship\var\models\.cache\axeuh-kernel\models"
        )

    def _patch_platform_helper(self, monkeypatch) -> None:
        monkeypatch.setattr(
            paths,
            "_is_absolute_path",
            lambda raw, windows=None: PureWindowsPath(raw).is_absolute(),
        )

    def test_windows_data_root_keeps_drive_override(self, monkeypatch):
        _fake_windows_project(monkeypatch)
        self._patch_platform_helper(monkeypatch)
        monkeypatch.setenv("AXEUH_DATA_ROOT", r"D:\Kinship\Data")

        assert str(paths.data_root()) == r"D:\Kinship\Data"

    def test_windows_data_root_joins_relative_override(self, monkeypatch):
        _fake_windows_project(monkeypatch)
        self._patch_platform_helper(monkeypatch)
        monkeypatch.setenv("AXEUH_DATA_ROOT", r"runtime\data")

        assert str(paths.data_root()) == r"C:\project\runtime\data"


# ── kernel model env ─────────────────────────────────────────


class TestKernelModelEnvOnWindows:
    def test_localappdata_never_leaks_into_backend_env(self, monkeypatch, tmp_path):
        models = tmp_path / "models-root"
        local = tmp_path / "AppData" / "Local"
        monkeypatch.setattr(kmp, "models_root", lambda: models)
        monkeypatch.setenv("LOCALAPPDATA", str(local))
        for key in _MODEL_ENV_KEYS:
            monkeypatch.delenv(key, raising=False)

        env = kmp.apply_model_env({})

        default = models / ".cache" / "axeuh-kernel" / "models"
        assert env["AXEUH_KERNEL_MODEL_DIR"] == str(default)
        assert env["AXEUH_KERNEL_MODEL_DOWNLOAD_DIR"] == str(default)
        assert str(local) not in "\n".join(env.values())

    def test_configured_model_dir_beats_operator_env_and_localappdata(
        self, monkeypatch, tmp_path
    ):
        models = tmp_path / "models-root"
        configured = tmp_path / "configured-models"
        monkeypatch.setattr(kmp, "models_root", lambda: models)
        monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "AppData" / "Local"))
        monkeypatch.setenv("AXEUH_KERNEL_MODEL_DIR", str(tmp_path / "operator"))

        env = kmp.apply_model_env({}, model_dir=configured)

        assert env["AXEUH_KERNEL_MODEL_DIR"] == str(configured)
        assert env["AXEUH_KERNEL_MODEL_DOWNLOAD_DIR"] == str(
            models / ".cache" / "axeuh-kernel" / "models"
        )
        assert str(tmp_path / "operator") not in env["AXEUH_KERNEL_MODEL_DIR"]

    def test_blank_operator_values_fall_back_to_models_root(
        self, monkeypatch, tmp_path
    ):
        models = tmp_path / "models-root"
        monkeypatch.setattr(kmp, "models_root", lambda: models)

        env = kmp.apply_model_env(
            {"AXEUH_KERNEL_MODEL_DIR": "   ", "HF_HOME": "  "}
        )

        cache = models / ".cache"
        assert env["AXEUH_KERNEL_MODEL_DIR"] == str(
            cache / "axeuh-kernel" / "models"
        )
        assert env["HF_HOME"] == str(cache / "huggingface")


# ── kernel assets ───────────────────────────────────────────


class TestKernelAssetsOnWindows:
    def test_venv_candidate_uses_scripts_python(self, monkeypatch, tmp_path):
        root = tmp_path / "project"
        venv_python = root / ".venv-kernel" / "Scripts" / "python.exe"
        venv_python.parent.mkdir(parents=True)
        venv_python.write_text("", encoding="utf-8")
        backend = tmp_path / "backend-python"
        backend.write_text("", encoding="utf-8")
        monkeypatch.setattr(ka, "_WINDOWS", True)

        result = ka.resolve_kernel_python(
            root,
            configured="",
            env="",
            candidates=(),
            sys_executable=str(backend),
        )

        assert result["source"] == "venv"
        assert result["path"] == str(venv_python)

    def test_venv_candidate_stays_bin_on_posix(self, monkeypatch, tmp_path):
        root = tmp_path / "project"
        venv_python = root / ".venv-kernel" / "bin" / "python"
        venv_python.parent.mkdir(parents=True)
        venv_python.write_text("", encoding="utf-8")
        backend = tmp_path / "backend-python"
        backend.write_text("", encoding="utf-8")
        monkeypatch.setattr(ka, "_WINDOWS", False)

        result = ka.resolve_kernel_python(
            root,
            configured="",
            env="",
            candidates=(),
            sys_executable=str(backend),
        )

        assert result["source"] == "venv"
        assert result["path"] == str(venv_python)

    def test_windows_pid_probe_never_calls_os_kill(self, monkeypatch):
        monkeypatch.setattr(ka, "_WINDOWS", True)
        monkeypatch.setattr(ka, "_windows_pid_alive", lambda pid: True)
        monkeypatch.setattr(
            ka.os,
            "kill",
            lambda *args, **kwargs: pytest.fail("os.kill must not probe on Windows"),
        )

        assert ka._pid_alive(4242) is True

    def test_inspect_uses_handle_probe_for_windows_pidfile(
        self, monkeypatch, tmp_path
    ):
        root = tmp_path / "project"
        root.mkdir()
        state = tmp_path / "state"
        state.mkdir()
        (state / "kernel.pid").write_text(
            '{"pid": 4242, "port": 4567, "api_version": "1.0.0"}',
            encoding="utf-8",
        )
        fake_python = tmp_path / "kernel-python"
        fake_python.write_text("", encoding="utf-8")
        monkeypatch.setattr(ka, "_WINDOWS", True)
        monkeypatch.setattr(ka, "_windows_pid_alive", lambda pid: True)
        monkeypatch.setattr(
            ka.os,
            "kill",
            lambda *args, **kwargs: pytest.fail("inspect must stay read-only"),
        )

        result = ka.inspect(
            root,
            state_dir=state,
            kernel_python=str(fake_python),
            model_dir=str(tmp_path / "models"),
            python_candidates=(),
            sys_executable=str(fake_python),
            health_probe=lambda port: False,
            disk_usage=lambda path: SimpleNamespace(free=10**9),
        )

        assert result["health"]["alive"] is True
        assert result["health"]["error"] == "health_unreachable"


# ── kernel spawn ────────────────────────────────────────────


class TestKernelSpawnOnWindows:
    def test_windows_spawn_sets_hidden_window_and_process_group(
        self, monkeypatch
    ):
        captured: dict[str, Any] = {}

        class _FakePopen:
            def __init__(self, argv, **kwargs):
                captured["argv"] = list(argv)
                captured.update(kwargs)

        monkeypatch.setattr(kc, "_WINDOWS", True)
        monkeypatch.setattr(
            kc.subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False
        )
        monkeypatch.setattr(
            kc.subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200, raising=False
        )
        monkeypatch.setattr(kc.subprocess, "Popen", _FakePopen)

        kc._popen(
            ["python.exe", "-m", "axeuh_kernel"], cwd="C:/project/kernel", env={}
        )

        assert captured["creationflags"] == 0x08000200
        assert "shell" not in captured
        assert captured["argv"] == ["python.exe", "-m", "axeuh_kernel"]

    def test_posix_spawn_keeps_plain_popen_kwargs(self, monkeypatch):
        captured: dict[str, Any] = {}

        class _FakePopen:
            def __init__(self, argv, **kwargs):
                captured.update(kwargs)

        monkeypatch.setattr(kc, "_WINDOWS", False)
        monkeypatch.setattr(kc.subprocess, "Popen", _FakePopen)

        kc._popen(["python", "-m", "axeuh_kernel"], cwd="/project/kernel", env={})

        assert "creationflags" not in captured


# ── Loom runtime ────────────────────────────────────────────


class TestLoomRuntimeOnWindows:
    def test_child_mode_never_probes_systemd(self, monkeypatch, tmp_path):
        cli = tmp_path / "cli.js"
        cli.write_text("// built\n", encoding="utf-8")
        node = r"C:\Program Files\nodejs\node.exe"
        monkeypatch.setattr(
            rt, "_which", lambda name: node if name == "node" else None
        )
        monkeypatch.setattr(rt, "_cli_path", lambda: cli)
        monkeypatch.setattr(
            rt,
            "_systemd_unit_info",
            lambda unit=rt.DEFAULT_SYSTEMD_UNIT: pytest.fail(
                "systemctl must not be probed when it is absent"
            ),
        )

        assert rt.detect_mode() == rt.MODE_CHILD
        details = rt._mode_details()
        assert details["systemd"]["systemctl"] is False
        assert "systemctl_missing" in details["reasons"]

    def test_none_mode_when_node_dist_missing(self, monkeypatch, tmp_path):
        node = r"C:\Program Files\nodejs\node.exe"
        monkeypatch.setattr(
            rt, "_which", lambda name: node if name == "node" else None
        )
        monkeypatch.setattr(rt, "_cli_path", lambda: tmp_path / "absent" / "cli.js")
        monkeypatch.setattr(
            rt,
            "_systemd_unit_info",
            lambda unit=rt.DEFAULT_SYSTEMD_UNIT: pytest.fail(
                "systemctl must not be probed when it is absent"
            ),
        )

        assert rt.detect_mode() == rt.MODE_NONE
        details = rt._mode_details()
        assert details["child"]["cli_present"] is False
        assert "loom_harness_dist_missing" in details["reasons"]

    def test_windows_spawn_flags_reach_popen(self, monkeypatch, tmp_path):
        captured: dict[str, Any] = {}

        class _FakePopen:
            def __init__(self, argv, **kwargs):
                captured["argv"] = list(argv)
                captured.update(kwargs)

        monkeypatch.setattr(rt, "_WINDOWS", True)
        monkeypatch.setattr(rt.subprocess, "Popen", _FakePopen)

        rt._spawn_child_process(
            ["node.exe", "cli.js", "serve"],
            env={"LOOM_TOKEN": "secret"},
            cwd=str(tmp_path),
            log_path=tmp_path / "logs" / "loom.log",
        )

        expected = rt._CREATE_NEW_PROCESS_GROUP | rt._DETACHED_PROCESS | rt._CREATE_NO_WINDOW
        assert captured["creationflags"] == expected
        assert captured["start_new_session"] is False
        assert "shell" not in captured
        assert captured["cwd"] == str(tmp_path)

    def test_windows_pid_alive_never_calls_os_kill(self, monkeypatch):
        monkeypatch.setattr(rt, "_WINDOWS", True)
        monkeypatch.setattr(rt, "_pid_exists", lambda pid: True)
        monkeypatch.setattr(
            rt.os,
            "kill",
            lambda *args, **kwargs: pytest.fail("os.kill must not probe on Windows"),
        )

        assert rt._pid_alive(4242) is True

    def test_windows_stop_uses_terminate_process(self, monkeypatch):
        calls: list[tuple[str, int, int]] = []

        class _FakeKernel32:
            def OpenProcess(self, access, inherit, pid):
                calls.append(("open", access, pid))
                return 99

            def TerminateProcess(self, handle, code):
                calls.append(("terminate", handle, code))
                return 1

            def CloseHandle(self, handle):
                calls.append(("close", handle, 0))
                return 1

        monkeypatch.setattr(rt, "_WINDOWS", True)
        monkeypatch.setattr(
            ctypes, "windll", SimpleNamespace(kernel32=_FakeKernel32()), raising=False
        )
        monkeypatch.setattr(
            rt.os,
            "kill",
            lambda *args, **kwargs: pytest.fail("Windows stop must not use os.kill"),
        )

        assert rt._terminate_pid(4242, graceful=True) is True
        assert calls == [
            ("open", 0x0001, 4242),
            ("terminate", 99, 1),
            ("close", 99, 0),
        ]

    def test_windows_command_only_fingerprint_is_rejected(self):
        identity = rt.ProcessIdentity(
            True, 1000.0, None, r"C:\Program Files\nodejs\node.exe"
        )

        matched, reason = rt._fingerprint_matches(
            {"pid": 7, "command_hash": "argv-hash"}, identity
        )

        assert matched is False
        assert reason == "unverifiable_identity"

    def test_token_provisioning_survives_chmod_failure(
        self, monkeypatch, tmp_path
    ):
        monkeypatch.delenv("LOOM_TOKEN", raising=False)
        monkeypatch.setattr(rt, "_persist_token_file", lambda path: (True, None))
        monkeypatch.setattr(
            rt.os,
            "chmod",
            lambda *args, **kwargs: (_ for _ in ()).throw(OSError("no chmod")),
        )

        result = rt.ensure_token(
            _loom_config(tmp_path, token=""), data_root=tmp_path / "var"
        )

        assert result["found"] is True
        assert result["provisioned"] is True
        content = (tmp_path / "var" / "secrets" / "loom.env").read_text(
            encoding="utf-8"
        )
        assert content.startswith("LOOM_TOKEN=")


# ── client catalog ──────────────────────────────────────────


def _client_config() -> SimpleNamespace:
    return SimpleNamespace(
        CLIENTS_ANDROID_URL="",
        CLIENTS_ANDROID_SHA256="",
        CLIENTS_DESKTOP_URL="",
        CLIENTS_DESKTOP_SHA256="",
        CLIENTS_GITHUB_RELEASE_TAG="onboarding-v1.0.0",
        CLIENTS_GITHUB_RELEASE_BASE="https://github.com/Xehuri/kinship",
        ONBOARDING_RELEASE_MANIFEST_URL="",
        ONBOARDING_RELEASE_BASE_URL="",
        BACKEND_HOST="0.0.0.0",
        BACKEND_PORT=8768,
        BACKEND_HTTPS_PORT=8768,
        BACKEND_HTTP_PORT=8768,
        SSL_ENABLED=True,
    )


def _manifest() -> SimpleNamespace:
    asset = SimpleNamespace(
        file="Kinship-Android-1.4.2-debug.apk",
        url="https://example.test/Kinship-Android-1.4.2-debug.apk",
        size=1024,
        sha256="a" * 64,
    )
    return SimpleNamespace(version="2026.10.26", assets={"android": asset})


def test_client_fallback_order_is_platform_independent(monkeypatch, tmp_path):
    client_release_manifest.reset_cache()
    monkeypatch.setattr(sys, "platform", "win32")
    ota = tmp_path / "ota"
    release = tmp_path / "release"
    ota.mkdir()
    release.mkdir()
    monkeypatch.setenv("OTA_FILE_DIR", str(ota))
    monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(release))
    cfg = _client_config()
    monkeypatch.setattr(clients_catalog, "get_config", lambda: cfg)

    def unavailable(*args, **kwargs):
        raise RuntimeError("offline")

    monkeypatch.setattr(client_release_manifest, "_manifest_loader", unavailable)

    assert clients_catalog.android_entry()["source"] == "github"

    cfg.CLIENTS_ANDROID_URL = "https://example.test/Kinship-Android-8.8.8.apk"
    assert clients_catalog.android_entry()["source"] == "configured"

    apk = ota / "app-debug.apk"
    apk.write_bytes(b"FAKE-APK")
    assert clients_catalog.android_entry()["source"] == "local"

    apk.unlink()
    cfg.CLIENTS_ANDROID_URL = ""
    client_release_manifest.reset_cache()
    monkeypatch.setattr(
        client_release_manifest, "_manifest_loader", lambda *args, **kwargs: _manifest()
    )
    assert clients_catalog.android_entry()["source"] == "manifest"

    client_release_manifest.reset_cache()


# ── static platform hygiene ─────────────────────────────────


@pytest.mark.parametrize(
    "module", _SCANNED_MODULES, ids=[module.__name__ for module in _SCANNED_MODULES]
)
def test_module_has_no_shell_or_name_based_kill(module):
    tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        for keyword in node.keywords:
            if keyword.arg == "shell":
                assert not (
                    isinstance(keyword.value, ast.Constant)
                    and keyword.value.value is True
                ), f"{module.__name__} must not use shell=True"
        name = ""
        if isinstance(node.func, ast.Attribute):
            name = node.func.attr
        elif isinstance(node.func, ast.Name):
            name = node.func.id
        assert name not in {"system", "popen"}, f"{module.__name__} must not spawn a shell"
        if name not in {"run", "call", "check_call", "check_output", "Popen"}:
            continue
        for argument in node.args:
            if isinstance(argument, (ast.List, ast.Tuple)):
                values = [
                    item.value
                    for item in argument.elts
                    if isinstance(item, ast.Constant)
                ]
            elif isinstance(argument, ast.Constant):
                values = [argument.value]
            else:
                values = []
            for value in values:
                if isinstance(value, str):
                    assert value not in _FORBIDDEN_KILL_COMMANDS, (
                        f"{module.__name__} must not kill by name: {value}"
                    )


@pytest.mark.parametrize(
    "module", _SCANNED_MODULES, ids=[module.__name__ for module in _SCANNED_MODULES]
)
def test_module_has_no_hardcoded_posix_home(module):
    source = inspect.getsource(module)
    for needle in ("Path.home(", '"/home/', "'/home/"):
        assert needle not in source, f"{module.__name__} hardcodes {needle}"
