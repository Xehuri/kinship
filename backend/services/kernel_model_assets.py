# -*- coding: utf-8 -*-
"""内核模型资产：只读状态与受控下载。

状态查询只读清单与文件系统，零网络。下载按清单 ``source`` 分派：

- ``bundled``：随内核发行包分发，永不下载；
- ``modelscope``：用内核 Python 调 ``modelscope.snapshot_download`` 到临时目录，
  再原子安装到清单 target；HuggingFace cache 目标物化为
  ``snapshots/<rev>/`` + ``refs/main``；
- ``huggingface_gated``：只从环境变量读 ``HF_TOKEN``，缺失时如实返回 ``gated``，
  绝不静默回退；
- ``upstream`` / ``release``：复用 ``release_assets`` 的流式下载、校验与原子替换。

所有临时目录都在 target 同级创建；目标已存在且不完整时拒绝覆盖（``target_exists``），
不做删除或合并。测试通过注入 ``runner`` / ``opener`` 完全避开网络。
"""
from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional
from urllib.parse import unquote, urlsplit

from core.redaction import redact_text
from config.paths import models_root
from services import kernel_assets, kernel_model_manifest, release_assets
from services.kernel_model_paths import apply_model_env

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = 1800.0
UPSTREAM_CANDIDATE_TIMEOUT_S = 600.0
STAGING_PREFIX = ".kernel-model-staging-"
HF_TOKEN_ENV = "HF_TOKEN"
HF_TOKEN_FALLBACK_ENV = "HUGGING_FACE_HUB_TOKEN"

_MODELSCOPE_SCRIPT = """\
import json
from modelscope.hub.snapshot_download import snapshot_download
path = snapshot_download(
    model_id=%(repo)r,
    revision=None,
    local_dir=%(local_dir)r,
    ignore_file_pattern=None,
)
print(json.dumps({"path": path}))
"""

_HF_SCRIPT = """\
import json, os
from huggingface_hub import snapshot_download
path = snapshot_download(
    repo_id=%(repo)r,
    cache_dir=%(cache_dir)r,
    token=os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"),
)
print(json.dumps({"path": path}))
"""


class KernelModelAssetError(Exception):
    """模型资产失败；``code`` 稳定、可上报且不含敏感值。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


Runner = Callable[..., Any]
Opener = Callable[..., Any]


@dataclass(frozen=True)
class _Context:
    manifest: kernel_model_manifest.KernelModelManifest
    project_root: Path | None
    kernel_python: str | None
    config: object
    timeout: float
    cancel_event: object
    runner: Runner | None
    opener: Opener | None
    sleep: Callable[[float], None] | None
    progress: Callable[[int, Optional[int]], None] | None


def _cfg(config: object, *names: str, default: Any = None) -> Any:
    if config is None:
        try:
            from config.config import get_config

            config = get_config()
        except Exception:
            return default
    for name in names:
        if isinstance(config, Mapping):
            if name in config:
                return config[name]
        elif hasattr(config, name):
            return getattr(config, name)
    return default


def _project_paths(
    project_root: Path | str | None, config: object
) -> "tuple[Path | None, Path | None, Path]":
    root = project_root
    if root is None:
        root = _cfg(config, "project_root", "PROJECT_ROOT", default=None)
    kernel_root = _cfg(config, "kernel_root", "KERNEL_ROOT", default=None)
    home = _cfg(config, "home", "HOME", default=None)
    if not home:
        # 清单的 ``~/...`` 目标是假 HOME：默认解析到模型根，而不是真实用户目录。
        home = models_root()
    return (
        Path(root).expanduser() if root is not None else None,
        Path(kernel_root).expanduser() if kernel_root else None,
        Path(home).expanduser(),
    )


def manifest_path(config: object = None) -> Path | None:
    raw = _cfg(
        config,
        "manifest_path",
        "MANIFEST_PATH",
        "KERNEL_MODEL_MANIFEST_PATH",
        default=None,
    )
    return Path(str(raw)).expanduser() if raw else None


def download_enabled(config: object = None) -> bool:
    return bool(
        _cfg(
            config,
            "allow_model_download",
            "ONBOARDING_ALLOW_MODEL_DOWNLOAD",
            default=True,
        )
    )


def status(project_root: Path | str | None = None, config: object = None) -> dict:
    """返回清单版本、逐模型落地状态与档位汇总；只读文件系统，不联网。"""
    manifest = kernel_model_manifest.load_manifest(manifest_path(config))
    project, kernel_root, home = _project_paths(project_root, config)
    rows = manifest.status_for(
        project_root=project, kernel_root=kernel_root, home=home
    )
    by_id = {model.id: model for model in manifest.models}
    models = []
    for row in rows:
        entry = by_id[row["id"]]
        models.append(
            {
                "id": entry.id,
                "tier": entry.tier,
                "source": entry.source,
                "repo": entry.repo,
                "target": row["target"],
                "kind": entry.kind,
                "size_bytes": entry.size_bytes,
                "gated": entry.gated,
                "present": bool(row["present"]),
                "missing_files": list(row["missing_files"]),
                "error": row["error"],
            }
        )
    present_ids = {row["id"] for row in models if row["present"]}
    tiers = []
    for tier in kernel_model_manifest.TIERS:
        members = [model for model in manifest.models if model.tier == tier]
        if not members:
            continue
        tiers.append(
            {
                "id": tier,
                "model_ids": [model.id for model in members],
                "total_size_bytes": sum(model.size_bytes for model in members),
                "missing_size_bytes": sum(
                    model.size_bytes
                    for model in members
                    if model.id not in present_ids
                ),
            }
        )
    return {
        "manifest_version": manifest.version,
        "models": models,
        "tiers": tiers,
        "total_size_bytes": manifest.total_size(),
        "required_size_bytes": manifest.total_size(tiers="required"),
    }


def select_models(
    manifest: kernel_model_manifest.KernelModelManifest,
    selection: object = None,
    config: object = None,
) -> "tuple[kernel_model_manifest.ModelEntry, ...]":
    """解析 ``{models, tiers}`` 选择；全空时回退配置档位（默认 required）。"""
    ids: object = None
    tiers: object = None
    if isinstance(selection, Mapping):
        ids = selection.get("models")
        if ids is None:
            ids = selection.get("ids")
        tiers = selection.get("tiers")
    elif selection is not None:
        ids = getattr(selection, "models", None) or getattr(selection, "ids", None)
        tiers = getattr(selection, "tiers", None)
    if ids is not None and not ids:
        raise KernelModelAssetError("empty_selection", "models selection is empty")
    if tiers is not None and not tiers:
        raise KernelModelAssetError("empty_selection", "tiers selection is empty")
    if ids is None and tiers is None:
        configured = _cfg(
            config,
            "model_tiers",
            "ONBOARDING_MODEL_TIERS",
            default=None,
        )
        tiers = configured if configured else ("required",)
    return manifest.select(ids=ids, tiers=tiers)


def _safe_message(exc: BaseException) -> str:
    return redact_text(str(exc))[:300]


def _scrub_secret(text: str, secret: str) -> str:
    value = redact_text(str(text))
    if secret:
        value = value.replace(secret, "***")
    return value[:300]


def _log_line(log: Callable[[str], None] | None, line: str) -> None:
    logger.info(line)
    if log is not None:
        try:
            log(line)
        except Exception:
            logger.warning("[KernelModels] result=callback_failed")


def _emit(
    progress: Callable[[int, Optional[int]], None] | None,
    done: int,
    total: int | None,
) -> None:
    if progress is None:
        return
    try:
        progress(done, total or None)
    except Exception:
        logger.warning("[KernelModels] result=progress_callback_failed")


def _raise_if_cancelled(cancel_event: object) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise release_assets.DownloadCancelled()


def _make_staging(target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    return Path(
        tempfile.mkdtemp(prefix=STAGING_PREFIX, dir=str(target.parent))
    )


def _dir_size(path: Path) -> int:
    total = 0
    for entry in path.rglob("*"):
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


def _is_hf_cache_target(target: Path) -> bool:
    return target.name.startswith("models--") and len(target.name) > len("models--")


def _synthetic_revision(model: kernel_model_manifest.ModelEntry) -> str:
    seed = "%s\0%s\0%d" % (model.repo, model.source, model.size_bytes)
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:40]


def _install_path(payload: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if target.is_dir() and not target.is_symlink() and not any(target.iterdir()):
            target.rmdir()
        else:
            raise KernelModelAssetError(
                "target_exists", "target already exists and is not empty"
            )
    os.replace(payload, target)


def _validate_payload(
    manifest: kernel_model_manifest.KernelModelManifest,
    model: kernel_model_manifest.ModelEntry,
    payload: Path,
) -> None:
    row = manifest.status_for({model.id: payload}, ids=model.id)[0]
    if not row["present"]:
        missing = ", ".join(row["missing_files"]) or row["error"] or "unknown"
        raise KernelModelAssetError(
            "download_incomplete", "downloaded payload is incomplete: %s" % missing
        )


def _resolve_python(ctx: _Context) -> str:
    configured = ctx.kernel_python
    if configured is None:
        configured = _cfg(
            ctx.config, "kernel_python", "KERNEL_PYTHON", default=None
        )
    info = kernel_assets.resolve_kernel_python(
        ctx.project_root, configured=configured
    )
    if not info.get("exists"):
        raise KernelModelAssetError(
            "kernel_python_missing",
            "kernel python not found: %s" % (info.get("path") or "unset"),
        )
    return str(info["path"])


def _default_runner(
    argv: "list[str]",
    *,
    env: Mapping[str, str],
    timeout: float,
    cancel_event: object,
) -> int:
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        proc = subprocess.Popen(
            argv,
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
        )
        deadline = time.monotonic() + max(1.0, float(timeout))
        try:
            while proc.poll() is None:
                _raise_if_cancelled(cancel_event)
                if time.monotonic() > deadline:
                    proc.kill()
                    raise KernelModelAssetError(
                        "download_timeout", "model download timed out"
                    )
                time.sleep(0.2)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
        if proc.returncode != 0:
            stderr.seek(0)
            raw = stderr.read()
            detail = redact_text(raw.decode("utf-8", "replace").strip())[-300:]
            raise KernelModelAssetError(
                "download_failed",
                "python download failed: %s" % (detail or proc.returncode),
            )
    return 0


def _run_script(
    python: str,
    script: str,
    *,
    timeout: float,
    cancel_event: object,
    runner: Runner | None,
    extra_env: Mapping[str, str] | None = None,
) -> None:
    argv = [python, "-c", script]
    environment = dict(os.environ)
    environment.setdefault("PYTHONUNBUFFERED", "1")
    environment = apply_model_env(environment)
    if extra_env:
        environment.update(extra_env)
    if runner is None:
        _default_runner(
            argv, env=environment, timeout=timeout, cancel_event=cancel_event
        )
    else:
        runner(
            argv, env=environment, timeout=timeout, cancel_event=cancel_event
        )


def _download_modelscope(
    ctx: _Context,
    model: kernel_model_manifest.ModelEntry,
    target: Path,
) -> dict:
    python = _resolve_python(ctx)
    workspace = _make_staging(target)
    try:
        downloaded = workspace / "download"
        script = _MODELSCOPE_SCRIPT % {
            "repo": model.repo,
            "local_dir": str(downloaded),
        }
        _run_script(
            python,
            script,
            timeout=ctx.timeout,
            cancel_event=ctx.cancel_event,
            runner=ctx.runner,
        )
        if not downloaded.is_dir():
            raise KernelModelAssetError(
                "download_incomplete", "snapshot_download produced no directory"
            )
        payload = workspace / "payload"
        verification = "modelscope"
        if _is_hf_cache_target(target):
            revision = _synthetic_revision(model)
            snapshot = payload / "snapshots" / revision
            snapshot.parent.mkdir(parents=True, exist_ok=True)
            os.replace(downloaded, snapshot)
            refs = payload / "refs"
            refs.mkdir(parents=True, exist_ok=True)
            (refs / "main").write_text(revision, encoding="utf-8")
            verification = "modelscope+hf_layout"
        else:
            os.replace(downloaded, payload)
        _validate_payload(ctx.manifest, model, payload)
        _install_path(payload, target)
        return {
            "status": "installed",
            "verification": verification,
            "bytes": _dir_size(target),
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def _hf_token() -> str:
    return (
        os.environ.get(HF_TOKEN_ENV, "").strip()
        or os.environ.get(HF_TOKEN_FALLBACK_ENV, "").strip()
    )


def _download_gated(
    ctx: _Context,
    model: kernel_model_manifest.ModelEntry,
    target: Path,
) -> dict:
    token = _hf_token()
    if not token:
        return {"status": "gated", "error": "gated_token_required"}
    if not _is_hf_cache_target(target):
        return {"status": "unsupported", "error": "unsupported_target_layout"}
    python = _resolve_python(ctx)
    workspace = _make_staging(target)
    try:
        cache = workspace / "cache"
        script = _HF_SCRIPT % {"repo": model.repo, "cache_dir": str(cache)}
        try:
            _run_script(
                python,
                script,
                timeout=ctx.timeout,
                cancel_event=ctx.cancel_event,
                runner=ctx.runner,
                extra_env={HF_TOKEN_ENV: token},
            )
        except release_assets.DownloadCancelled:
            raise
        except KernelModelAssetError as exc:
            raise KernelModelAssetError(
                exc.code, _scrub_secret(str(exc), token)
            ) from None
        except Exception as exc:
            raise KernelModelAssetError(
                "download_failed", _scrub_secret(str(exc), token)
            ) from None
        repo_dir = cache / ("models--" + model.repo.replace("/", "--"))
        if not repo_dir.is_dir():
            raise KernelModelAssetError(
                "download_incomplete", "huggingface snapshot cache is missing"
            )
        payload = workspace / "payload"
        os.replace(repo_dir, payload)
        _validate_payload(ctx.manifest, model, payload)
        _install_path(payload, target)
        return {
            "status": "installed",
            "verification": "huggingface_hub",
            "bytes": _dir_size(target),
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def _url_filename(url: str) -> str:
    return Path(unquote(urlsplit(url).path)).name or "download"


def _download_upstream(
    ctx: _Context,
    model: kernel_model_manifest.ModelEntry,
    target: Path,
) -> dict:
    if not model.url:
        raise KernelModelAssetError("download_url_missing", "upstream URL is missing")
    if model.sha256:
        verification = "sha256"
    elif model.md5:
        verification = "md5"
    else:
        verification = "size"
        logger.warning(
            "[KernelModels] phase=verify model=%s result=size_only", model.id
        )
    file_name = _url_filename(model.url)

    def _asset_for(url: str) -> release_assets.Asset:
        return release_assets.Asset(
            name=model.id,
            file=file_name,
            sha256=model.sha256 or "",
            url=url,
            size=model.size_bytes if model.kind == "file" else None,
            md5=model.md5,
        )

    workspace = _make_staging(target)
    try:
        archive = workspace / "download"
        if model.mirrors:
            downloaded = _download_from_candidates(
                ctx, model, _asset_for, archive
            )
        else:
            downloaded = release_assets.download_asset(
                _asset_for(str(model.url)),
                archive,
                progress=ctx.progress,
                cancel_event=ctx.cancel_event,
                retries=2,
                sleep=ctx.sleep or time.sleep,
                timeout=ctx.timeout,
                opener=ctx.opener,
                allow_unverified=not (model.sha256 or model.md5),
            )
        if model.kind == "file":
            payload = archive
            installed_bytes = int(downloaded.get("bytes") or 0)
        else:
            extracted = workspace / "extracted"
            release_assets.extract_tarball(
                archive,
                extracted,
                asset=model.id,
                cancel_event=ctx.cancel_event,
            )
            candidate = extracted / target.name
            payload = candidate if candidate.is_dir() else extracted
            installed_bytes = _dir_size(payload)
            if verification == "size" and model.size_bytes:
                if installed_bytes != model.size_bytes:
                    raise KernelModelAssetError(
                        "size_mismatch",
                        "extracted size %d != manifest %d"
                        % (installed_bytes, model.size_bytes),
                    )
        _validate_payload(ctx.manifest, model, payload)
        _install_path(payload, target)
        return {
            "status": "installed",
            "verification": verification,
            "bytes": installed_bytes,
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def _download_from_candidates(
    ctx: _Context,
    model: kernel_model_manifest.ModelEntry,
    asset_for: Callable[[str], release_assets.Asset],
    archive: Path,
) -> dict:
    timeout = min(ctx.timeout, UPSTREAM_CANDIDATE_TIMEOUT_S)
    mirrors = tuple(model.mirrors)
    candidates = mirrors + (str(model.url),)
    for index, url in enumerate(candidates):
        label = "canonical" if index == len(mirrors) else str(index)
        try:
            return release_assets.download_asset(
                asset_for(url),
                archive,
                progress=ctx.progress,
                cancel_event=ctx.cancel_event,
                retries=0,
                sleep=ctx.sleep or time.sleep,
                timeout=timeout,
                opener=ctx.opener,
                allow_unverified=not (model.sha256 or model.md5),
            )
        except release_assets.DownloadCancelled:
            raise
        except release_assets.ReleaseAssetError as exc:
            logger.warning(
                "[KernelModels] phase=download model=%s mirror=%s result=failed error=%s",
                model.id,
                label,
                exc.code,
            )
    raise KernelModelAssetError(
        "download_failed", "all download candidates failed"
    )


def _summary(
    manifest: kernel_model_manifest.KernelModelManifest,
    selected: "tuple[kernel_model_manifest.ModelEntry, ...]",
    rows: "list[dict]",
) -> dict:
    def ids(status: str) -> "list[str]":
        return [row["id"] for row in rows if row["status"] == status]

    return {
        "manifest_version": manifest.version,
        "selection": [model.id for model in selected],
        "models": rows,
        "installed": ids("installed"),
        "present": ids("present"),
        "bundled": ids("bundled"),
        "gated": ids("gated"),
        "unsupported": ids("unsupported"),
        "failed": ids("failed"),
        "download_bytes": sum(int(row.get("bytes") or 0) for row in rows),
    }


def download(
    manifest: kernel_model_manifest.KernelModelManifest,
    selection: object = None,
    project_root: Path | str | None = None,
    config: object = None,
    progress: Callable[[int, Optional[int]], None] | None = None,
    cancel_event: object = None,
    timeout: float = DEFAULT_TIMEOUT_S,
    kernel_python: str | None = None,
    *,
    runner: Runner | None = None,
    opener: Opener | None = None,
    sleep: Callable[[float], None] | None = None,
    log: Callable[[str], None] | None = None,
) -> dict:
    """下载所选模型；逐模型汇报结果，单个失败不阻断其余模型。"""
    if not download_enabled(config):
        raise KernelModelAssetError(
            "model_download_disabled", "model download is disabled by config"
        )
    selected = select_models(manifest, selection, config)
    if not selected:
        raise KernelModelAssetError("empty_selection", "no models selected")
    project, kernel_root, home = _project_paths(project_root, config)
    status_by_id = {
        row["id"]: row
        for row in manifest.status_for(
            project_root=project,
            kernel_root=kernel_root,
            home=home,
            ids=[model.id for model in selected],
        )
    }
    ctx = _Context(
        manifest=manifest,
        project_root=project,
        kernel_python=kernel_python,
        config=config,
        timeout=timeout,
        cancel_event=cancel_event,
        runner=runner,
        opener=opener,
        sleep=sleep,
        progress=progress,
    )
    total = sum(max(0, model.size_bytes) for model in selected)
    done = 0
    rows: "list[dict]" = []
    _emit(progress, 0, total)
    for model in selected:
        _raise_if_cancelled(cancel_event)
        target = Path(status_by_id[model.id]["target"])
        result: dict = {
            "id": model.id,
            "tier": model.tier,
            "source": model.source,
            "target": str(target),
            "status": "pending",
            "verification": None,
            "bytes": 0,
            "error": None,
            "message": "",
        }
        _log_line(log, "[KernelModels] phase=download model=%s result=start" % model.id)
        try:
            if status_by_id[model.id]["present"]:
                result["status"] = "present"
            elif model.source == "bundled":
                result["status"] = "bundled"
                result["error"] = "bundled_missing"
            elif model.source == "modelscope":
                result.update(_download_modelscope(ctx, model, target))
            elif model.gated or model.source == "huggingface_gated":
                result.update(_download_gated(ctx, model, target))
            elif model.source in {"upstream", "release"}:
                result.update(_download_upstream(ctx, model, target))
            else:
                result.update(
                    status="unsupported", error="unsupported_source"
                )
        except release_assets.DownloadCancelled:
            _log_line(
                log, "[KernelModels] phase=download model=%s result=cancelled" % model.id
            )
            raise
        except (KernelModelAssetError, release_assets.ReleaseAssetError) as exc:
            result.update(
                status="failed",
                error=getattr(exc, "code", type(exc).__name__),
                message=_safe_message(exc),
            )
            logger.warning(
                "[KernelModels] phase=download model=%s result=failed error=%s",
                model.id,
                result["error"],
            )
        except Exception as exc:
            result.update(
                status="failed",
                error=type(exc).__name__,
                message=_safe_message(exc),
            )
            logger.exception(
                "[KernelModels] phase=download model=%s result=failed", model.id
            )
        done += max(0, model.size_bytes)
        _emit(progress, done, total)
        _log_line(
            log,
            "[KernelModels] phase=download model=%s result=%s error=%s"
            % (model.id, result["status"], result["error"] or "-"),
        )
        rows.append(result)
    return _summary(manifest, selected, rows)


__all__ = [
    "DEFAULT_TIMEOUT_S",
    "HF_TOKEN_ENV",
    "KernelModelAssetError",
    "download",
    "download_enabled",
    "manifest_path",
    "select_models",
    "status",
]
