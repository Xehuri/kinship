# -*- coding: utf-8 -*-
"""task 23：内核本地构建 + 内核 venv 安装（全部注入 runner，零网络零 pip）。"""
from __future__ import annotations

import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping, Sequence

import pytest

from config.config import Config
from services import kernel_bootstrap as kb


class FakeRunner:
    """记录 argv 并按 token 注入失败/输出；必要时模拟 venv 目录落盘。"""

    def __init__(
        self,
        *,
        venv_dir: Path | None = None,
        stdout: Mapping[str, str] | None = None,
    ) -> None:
        self.calls: list[dict[str, Any]] = []
        self.venv_dir = venv_dir
        self.stdout = dict(stdout or {})
        self.fail_counts: dict[str, int] = {}
        self.fail_rc = 1

    def fail(self, token: str, *, times: int = 1, rc: int = 1, stderr: str = "boom") -> None:
        self.fail_counts[token] = times
        self.fail_rc = rc

    def commands(self) -> list[list[str]]:
        return [list(call["argv"]) for call in self.calls]

    def __call__(
        self,
        argv: Sequence[str],
        *,
        cwd: Path | str | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> kb.CommandResult:
        argv = list(argv)
        self.calls.append(
            {
                "argv": argv,
                "cwd": cwd,
                "env": env,
                "timeout": timeout,
                "cancel_event": cancel_event,
            }
        )
        if (
            self.venv_dir is not None
            and len(argv) >= 4
            and argv[1:3] == ["-m", "venv"]
        ):
            py = kb.venv_python_path(self.venv_dir)
            py.parent.mkdir(parents=True, exist_ok=True)
            py.write_text("#!/bin/sh\n", encoding="utf-8")
            py.chmod(0o755)
        for token, remaining in list(self.fail_counts.items()):
            if remaining > 0 and token in argv:
                self.fail_counts[token] = remaining - 1
                return kb.CommandResult(self.fail_rc, "", "boom")
        stdout = ""
        for token, text in self.stdout.items():
            if token in argv:
                stdout = text
                break
        return kb.CommandResult(0, stdout, "")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    entry = root / kb.KERNEL_ENTRY_REL
    entry.parent.mkdir(parents=True)
    entry.write_bytes(b"x" * 1024)
    weight = root / kb.KERNEL_DIST_REL / "axeuh_kernel" / "models" / "w.bin"
    weight.parent.mkdir(parents=True)
    weight.write_bytes(b"y" * 2048)
    (root / "kernel" / "pyproject.toml").write_text(
        "[project]\nname = \"axeuh-kernel\"\n", encoding="utf-8"
    )
    return root


def test_build_kernel_runs_exact_command_and_measures_artifact(repo: Path) -> None:
    runner = FakeRunner()

    info = kb.build_kernel(repo, runner=runner)

    assert runner.commands()[0] == [
        sys.executable,
        "kernel/build_dist.py",
        "--protection",
        "pyc",
    ]
    assert Path(runner.calls[0]["cwd"]) == repo
    assert Path(info["artifact"]) == repo / kb.KERNEL_ENTRY_REL
    assert info["artifact_bytes"] == 3072


def test_build_kernel_rejects_nonzero_exit(repo: Path) -> None:
    runner = FakeRunner()
    runner.fail("--protection")

    with pytest.raises(kb.KernelBootstrapError) as excinfo:
        kb.build_kernel(repo, runner=runner)

    assert excinfo.value.code == "build_failed"


def test_build_kernel_requires_pyc_entry(tmp_path: Path) -> None:
    empty = tmp_path / "empty-repo"
    empty.mkdir()

    with pytest.raises(kb.KernelBootstrapError) as excinfo:
        kb.build_kernel(empty, runner=FakeRunner())

    assert excinfo.value.code == "build_artifact_missing"


@pytest.mark.parametrize(
    ("driver", "expected"),
    [
        ("550.54.14\n", "cuda"),
        ("535.104.05\n", "cpu"),
        ("580.65.06\n", "cuda"),
        ("550.54.14\n535.104.05\n", "cuda"),
    ],
)
def test_gpu_classify_by_driver_major(driver: str, expected: str) -> None:
    runner = FakeRunner(stdout={"nvidia-smi": driver})

    kind, detail = kb.gpu_classify(runner=runner)

    assert kind == expected
    assert "driver" in detail


def test_gpu_classify_falls_back_to_cpu_when_smi_fails() -> None:
    runner = FakeRunner()
    runner.fail("nvidia-smi")

    kind, detail = kb.gpu_classify(runner=runner)

    assert kind == "cpu"
    assert "nvidia-smi" in detail


def test_torch_index_url_explicit_override_wins_for_any_classification() -> None:
    cfg = {"kernel": {"torch_index_url": "https://example.invalid/whl/cu999"}}

    assert kb.torch_index_url(cfg, ("cuda", "driver 580.65.06")) == (
        "https://example.invalid/whl/cu999"
    )
    assert kb.torch_index_url(cfg, ("cpu", "")) == "https://example.invalid/whl/cu999"


def test_torch_index_url_reads_config_object() -> None:
    cfg = Config({"kernel": {"torch_index_url": " https://example.invalid/whl/cu126 "}})

    assert kb.torch_index_url(cfg, "cpu") == "https://example.invalid/whl/cu126"


@pytest.mark.parametrize(
    ("classification", "expected"),
    [
        (("cuda", "driver 550.54.14 (>=550)"), kb.CUDA_INDEX_LEGACY),
        (("cuda", "driver 569.99.01 (>=550)"), kb.CUDA_INDEX_LEGACY),
        (("cuda", "driver 580.65.06 (>=550)"), kb.CUDA_INDEX_MODERN),
        (("cpu", "driver 535.104.05 (<550)"), ""),
        (("cpu", "nvidia-smi unavailable: spawn_failed"), ""),
    ],
)
def test_torch_index_url_auto_mapping(classification: tuple[str, str], expected: str) -> None:
    assert kb.torch_index_url({}, classification) == expected


def test_ensure_kernel_venv_installs_torch_before_kernel(repo: Path) -> None:
    runner = FakeRunner(venv_dir=repo / ".venv-kernel")

    info = kb.ensure_kernel_venv(
        repo,
        classification=("cuda", "driver 550.54.14 (>=550)"),
        torch_index=kb.CUDA_INDEX_LEGACY,
        runner=runner,
    )

    commands = runner.commands()
    assert commands[0] == [sys.executable, "-m", "venv", str(repo / ".venv-kernel")]
    torch_pos = next(i for i, cmd in enumerate(commands) if "torch" in cmd)
    kernel_pos = next(i for i, cmd in enumerate(commands) if "-e" in cmd and "kernel" in cmd)
    assert torch_pos < kernel_pos
    assert commands[torch_pos][-2:] == ["--index-url", kb.CUDA_INDEX_LEGACY]
    assert info["torch"] == "cuda"
    assert info["torch_cpu_fallback"] is False
    assert info["torch_download_bytes_estimate"] == kb.TORCH_CUDA_DOWNLOAD_BYTES
    assert Path(info["venv_python"]).is_file()


def test_torch_failure_retries_cpu_exactly_once(repo: Path) -> None:
    runner = FakeRunner(venv_dir=repo / ".venv-kernel")
    runner.fail("torch", times=1)

    info = kb.ensure_kernel_venv(
        repo,
        classification=("cuda", "driver 550.54.14 (>=550)"),
        torch_index=kb.CUDA_INDEX_LEGACY,
        runner=runner,
    )

    torch_commands = [cmd for cmd in runner.commands() if "torch" in cmd]
    assert len(torch_commands) == 2
    assert "--index-url" in torch_commands[0]
    assert "--index-url" not in torch_commands[1]
    assert info["torch"] == "cpu"
    assert info["torch_cpu_fallback"] is True
    assert info["torch_download_bytes_estimate"] == 0


def test_torch_failure_without_index_does_not_retry(repo: Path) -> None:
    runner = FakeRunner(venv_dir=repo / ".venv-kernel")
    runner.fail("torch", times=1)

    with pytest.raises(kb.KernelBootstrapError) as excinfo:
        kb.ensure_kernel_venv(repo, classification=("cpu", ""), runner=runner)

    assert excinfo.value.code == "torch_install_failed"
    assert len([cmd for cmd in runner.commands() if "torch" in cmd]) == 1


def test_disk_guard_returns_disk_full_without_creating_venv(repo: Path) -> None:
    runner = FakeRunner()
    low_disk = lambda _root: SimpleNamespace(total=10, used=9, free=1)

    result = kb.bootstrap_kernel(repo, runner=runner, disk_usage_fn=low_disk)

    assert result["ok"] is False
    assert result["error"]["code"] == "disk_full"
    assert not (repo / ".venv-kernel").exists()
    assert not any(cmd[1:3] == ["-m", "venv"] for cmd in runner.commands())


def test_existing_venv_is_reused_and_dependencies_still_installed(repo: Path) -> None:
    venv_dir = repo / ".venv-kernel"
    python = kb.venv_python_path(venv_dir)
    python.parent.mkdir(parents=True)
    python.write_text("#!/bin/sh\n", encoding="utf-8")
    python.chmod(0o755)
    runner = FakeRunner(venv_dir=venv_dir)

    info = kb.ensure_kernel_venv(repo, classification=("cpu", ""), runner=runner)

    assert info["reused"] is True
    assert info["created"] is False
    assert not any(cmd[1:3] == ["-m", "venv"] for cmd in runner.commands())
    assert any("torch" in cmd for cmd in runner.commands())
    assert any("-e" in cmd and "kernel" in cmd for cmd in runner.commands())


def test_ensure_kernel_venv_requirements_mode_installs_requirements_file(
    tmp_path: Path,
) -> None:
    root = tmp_path / "prebuilt"
    requirements = root / "kernel" / "requirements.txt"
    requirements.parent.mkdir(parents=True)
    requirements.write_text("fastapi\nuvicorn\n", encoding="utf-8")
    runner = FakeRunner(venv_dir=root / ".venv-kernel")

    info = kb.ensure_kernel_venv(
        root,
        classification=("cpu", ""),
        requirements_file=requirements,
        runner=runner,
    )

    commands = runner.commands()
    assert any("-e" in cmd and "kernel" in cmd for cmd in commands) is False
    deps = next(cmd for cmd in commands if "-r" in cmd)
    assert deps[-1] == str(requirements.resolve())
    assert deps[deps.index("-r") + 1] == str(requirements.resolve())
    torch_pos = next(i for i, cmd in enumerate(commands) if "torch" in cmd)
    deps_pos = commands.index(deps)
    assert torch_pos < deps_pos
    assert info["deps_mode"] == "requirements"
    assert info["requirements_file"] == str(requirements.resolve())


def test_ensure_kernel_venv_defaults_to_kernel_requirements_without_pyproject(
    tmp_path: Path,
) -> None:
    root = tmp_path / "prebuilt"
    requirements = root / "kernel" / "requirements.txt"
    requirements.parent.mkdir(parents=True)
    requirements.write_text("fastapi\n", encoding="utf-8")
    runner = FakeRunner(venv_dir=root / ".venv-kernel")

    info = kb.ensure_kernel_venv(root, classification=("cpu", ""), runner=runner)

    deps = next(cmd for cmd in runner.commands() if "-r" in cmd)
    assert deps[-1] == str(requirements.resolve())
    assert info["deps_mode"] == "requirements"


def test_ensure_kernel_venv_missing_requirements_fails_before_any_command(
    tmp_path: Path,
) -> None:
    root = tmp_path / "prebuilt"
    root.mkdir()
    runner = FakeRunner(venv_dir=root / ".venv-kernel")

    with pytest.raises(kb.KernelBootstrapError) as excinfo:
        kb.ensure_kernel_venv(
            root,
            requirements_file=root / "kernel" / "requirements.txt",
            runner=runner,
        )

    assert excinfo.value.code == "kernel_requirements_missing"
    assert runner.commands() == []
    assert not (root / ".venv-kernel").exists()


def test_ensure_kernel_venv_requirements_install_failure_code(tmp_path: Path) -> None:
    root = tmp_path / "prebuilt"
    requirements = root / "kernel" / "requirements.txt"
    requirements.parent.mkdir(parents=True)
    requirements.write_text("fastapi\n", encoding="utf-8")
    runner = FakeRunner(venv_dir=root / ".venv-kernel")
    runner.fail("-r")

    with pytest.raises(kb.KernelBootstrapError) as excinfo:
        kb.ensure_kernel_venv(
            root, requirements_file=requirements, runner=runner
        )

    assert excinfo.value.code == "kernel_deps_install_failed"


def test_runtime_download_bytes_tracks_classification() -> None:
    assert kb.runtime_download_bytes(("cuda", "driver 580.65.06")) == (
        kb.TORCH_CUDA_DOWNLOAD_BYTES
    )
    assert kb.runtime_download_bytes(("cpu", "")) == (
        kb.TORCH_CPU_RUNTIME_DOWNLOAD_BYTES
    )


def test_verify_kernel_runtime_runs_help_with_project_venv(tmp_path: Path) -> None:
    root = tmp_path / "project"
    venv_python = kb.venv_python_path(root / ".venv-kernel")
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("#!/bin/sh\n", encoding="utf-8")
    venv_python.chmod(0o755)
    kernel_dir = root / "kernel"
    kernel_dir.mkdir()
    runner = FakeRunner(stdout={"--help": "usage: axeuh_kernel"})

    info = kb.verify_kernel_runtime(venv_python, kernel_dir, runner=runner)

    assert info["command"] == [
        str(venv_python),
        "-m",
        "axeuh_kernel",
        "--help",
    ]
    assert Path(runner.calls[0]["cwd"]) == kernel_dir
    assert runner.calls[0]["env"].get("PYTHONPATH") is None


def test_verify_kernel_runtime_reports_stable_failure_code(tmp_path: Path) -> None:
    venv_python = tmp_path / "python"
    venv_python.write_text("#!/bin/sh\n", encoding="utf-8")
    venv_python.chmod(0o755)
    kernel_dir = tmp_path / "kernel"
    kernel_dir.mkdir()
    runner = FakeRunner()
    runner.fail("--help")

    with pytest.raises(kb.KernelBootstrapError) as excinfo:
        kb.verify_kernel_runtime(venv_python, kernel_dir, runner=runner)

    assert excinfo.value.code == "kernel_verify_failed"


def test_bootstrap_kernel_returns_contract_dict(repo: Path) -> None:
    runner = FakeRunner(
        venv_dir=repo / ".venv-kernel",
        stdout={"nvidia-smi": "550.54.14\n"},
    )

    result = kb.bootstrap_kernel(repo, cfg={}, runner=runner)

    assert result["ok"] is True
    assert result["built"] is True
    assert result["artifact_bytes"] == 3072
    assert result["torch"] == "cuda"
    assert result["torch_cpu_fallback"] is False
    assert result["torch_index_url"] == kb.CUDA_INDEX_LEGACY
    assert result["torch_download_bytes_estimate"] == kb.TORCH_CUDA_DOWNLOAD_BYTES
    assert result["venv_python"].endswith(("bin/python", "Scripts/python.exe"))
    assert [step["name"] for step in result["steps"]] == ["build", "venv", "deps"]


def test_bootstrap_kernel_stops_before_venv_when_build_fails(repo: Path) -> None:
    runner = FakeRunner()
    runner.fail("--protection")

    result = kb.bootstrap_kernel(repo, cfg={}, runner=runner)

    assert result["ok"] is False
    assert result["built"] is False
    assert result["error"]["code"] == "build_failed"
    assert not (repo / ".venv-kernel").exists()
    assert not any("torch" in cmd for cmd in runner.commands())


def test_bootstrap_kernel_reports_progress_and_logs(repo: Path) -> None:
    runner = FakeRunner(venv_dir=repo / ".venv-kernel", stdout={"nvidia-smi": "535.1\n"})
    progress: list[tuple[int, int | None]] = []
    lines: list[str] = []

    kb.bootstrap_kernel(
        repo,
        cfg={},
        runner=runner,
        progress=lambda done, total: progress.append((done, total)),
        log=lines.append,
    )

    assert progress == [(0, 3), (1, 3), (2, 3), (3, 3)]
    assert any("phase=build result=ok" in line for line in lines)
    assert any("phase=deps result=ok" in line for line in lines)


def test_bootstrap_kernel_honours_preset_cancel(repo: Path) -> None:
    cancel = threading.Event()
    cancel.set()

    result = kb.bootstrap_kernel(repo, cfg={}, runner=FakeRunner(), cancel_event=cancel)

    assert result["ok"] is False
    assert result["error"]["code"] == "cancelled"
    assert not (repo / ".venv-kernel").exists()


def test_config_torch_index_url_property_defaults_and_override() -> None:
    assert Config({}).KERNEL_TORCH_INDEX_URL == ""
    assert (
        Config({"kernel": {"torch_index_url": " https://example.invalid/cu128 "}})
        .KERNEL_TORCH_INDEX_URL
        == "https://example.invalid/cu128"
    )
