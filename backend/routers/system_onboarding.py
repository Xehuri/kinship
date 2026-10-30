# -*- coding: utf-8 -*-
"""系统引导 HTTP API（N14）。

四个端点都返回稳定的 JSON 契约；错误响应一律为 ``{code, message}``，不依赖
全局异常信封。GET 端点公开只读；写入端点按用户存在性分别使用引导令牌或
Bearer + 当前密码。
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool

import auth
from config.store import (
    ConfigEnvLocked,
    ConfigReadOnly,
    ConfigStoreError,
    ConfigValidationError,
    ConfigWriteError,
    get_config_store,
)
from core.redaction import redact_text
from services import (
    config_authz,
    config_reconciler,
    kernel_assets,
    kernel_bootstrap,
    kernel_model_assets,
    kernel_model_manifest,
    onboarding_jobs,
    onboarding_service,
    release_assets,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/system/onboarding", tags=["system-onboarding"]
)


class PreflightCheck(BaseModel):
    id: str
    label: str
    status: Literal["pass", "warn", "fail"]
    blocking: bool
    category: str
    detail: str
    fix: str = ""


class PreflightResult(BaseModel):
    checks: list[PreflightCheck]
    can_proceed: bool
    blocking_failures: list[str]
    soft_failures: list[str]
    summary: dict[str, int]


class OnboardingStepStatus(BaseModel):
    id: str
    title: str
    description: str
    required: bool
    skippable: bool
    state: Literal["completed", "skipped", "current", "pending"]
    auth: str = "none"
    write_auth: str = "bearer"


class OnboardingStatus(BaseModel):
    state: dict[str, Any]
    needs_setup: bool
    degraded: bool
    onboarding_complete: bool
    config_revision: str
    steps: list[OnboardingStepStatus]
    bootstrap: bool
    state_version: int
    legacy_upgraded: bool
    degraded_reasons: list[str]


class OnboardingStateRequest(BaseModel):
    step_id: str = Field(min_length=1)
    status: Literal["completed", "skipped"]
    data: dict[str, Any] | None = None
    dry_run: bool = False


class OnboardingActionRequest(BaseModel):
    action: Literal["copy_ai_template", "generate_self_signed_cert"]
    overwrite: bool = False
    current_password: str | None = None


class AssetDownloadRequest(BaseModel):
    asset: str = Field(min_length=1)
    password: str | None = None


class ModelDownloadRequest(BaseModel):
    models: list[str] | None = None
    tiers: list[str] | None = None
    password: str | None = None


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code, content={"code": code, "message": message}
    )


def _preflight_gate_error(exc: onboarding_service.PreflightGateError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "code": exc.code,
            "message": exc.message,
            "checks": exc.checks,
            "can_proceed": exc.can_proceed,
            "blocking_failures": exc.blocking_failures,
            "soft_failures": exc.soft_failures,
            "summary": exc.summary,
        },
    )


def _validation_message(exc: ValidationError) -> str:
    errors = exc.errors()
    if not errors:
        return "请求体格式无效"
    first = errors[0]
    location = ".".join(str(part) for part in first.get("loc", ()))
    message = str(first.get("msg", "invalid"))
    return f"{location}: {message}" if location else message


async def _json_object(
    request: Request,
) -> tuple[dict[str, Any] | None, JSONResponse | None]:
    try:
        payload = await request.json()
    except (ValueError, UnicodeDecodeError):
        return None, _error(400, "invalid_json", "请求体必须是 JSON")
    if not isinstance(payload, dict):
        return None, _error(422, "invalid_request", "请求体必须是 JSON 对象")
    return payload, None


async def _optional_json_object(
    request: Request,
) -> tuple[dict[str, Any], JSONResponse | None]:
    try:
        raw = await request.body()
    except Exception:
        raw = b""
    if not raw.strip():
        return {}, None
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}, _error(400, "invalid_json", "请求体必须是 JSON")
    if payload is None:
        return {}, None
    if not isinstance(payload, dict):
        return {}, _error(422, "invalid_request", "请求体必须是 JSON 对象")
    return payload, None


def _progress_auth_error(request: Request) -> JSONResponse | None:
    user_id = getattr(request.state, "user_id", None)
    token_kind = getattr(request.state, "token_kind", None)
    if not user_id:
        return _error(401, "auth_required", "未授权访问，请先登录")
    if token_kind != "user":
        return _error(403, "token_kind_forbidden", "该 Token 类型无权记录引导进度")
    return None


async def _require_state_auth(request: Request) -> JSONResponse | None:
    if not auth.is_setup_required():
        return _progress_auth_error(request)
    try:
        await config_authz.require_config_write(request)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


async def _require_action_auth(
    request: Request, password: str | None
) -> JSONResponse | None:
    try:
        await config_authz.require_config_write(request, password)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


def _project_root() -> Path:
    return onboarding_service.default_project_root()


def _safe_message(exc: BaseException) -> str:
    return redact_text(str(exc))[:300]


async def _require_read_auth(request: Request) -> JSONResponse | None:
    try:
        await config_authz.require_config_read(request)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


async def _require_write_auth(
    request: Request, password: str | None
) -> JSONResponse | None:
    try:
        await config_authz.require_config_write(request, password)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


def _release_settings() -> tuple[str, str]:
    """读取发行清单配置；空串表示未配置（内核发行下载必须显式配置）。

    ``KERNEL_MANIFEST_URL`` 环境变量优先于 config ``onboarding.release_manifest_url``。
    """
    from config.config import get_config

    cfg = get_config()
    env_manifest = os.environ.get("KERNEL_MANIFEST_URL", "").strip()
    manifest_url = env_manifest or str(
        getattr(cfg, "ONBOARDING_RELEASE_MANIFEST_URL", "") or ""
    ).strip()
    return (
        manifest_url,
        str(getattr(cfg, "ONBOARDING_RELEASE_BASE_URL", "") or "").strip(),
    )


async def _fetch_manifest() -> release_assets.ReleaseManifest:
    manifest_url, base_url = _release_settings()
    return await run_in_threadpool(
        release_assets.load_manifest,
        manifest_url,
        base_url=base_url,
        timeout=5.0,
        retries=0,
    )


def _ensure_ai_before_job(
    project_root: Path, job: onboarding_jobs.Job
) -> None:
    """下载前确保 AI 实例存在；失败只记录稳定错误码并让作业终止。"""
    try:
        result = onboarding_service.ensure_ai_instance(
            project_root=project_root
        )
    except Exception as exc:  # noqa: BLE001 - 失败需先落日志再原样抛出
        code = getattr(exc, "code", None)
        if not isinstance(code, str) or not code:
            code = "ai_instance_failed"
        job.log(
            f"[OnboardingAssets] phase=ai_instance result=error code={code}"
        )
        raise
    copied = result.get("copied_files")
    if not isinstance(copied, int):
        copied = 0
    job.log(f"[OnboardingAssets] phase=ai_instance result=ok copied={copied}")


def _kernel_bootstrap_runner(
    project_root: Path, job: onboarding_jobs.Job
) -> dict[str, Any]:
    """内核步骤：本地构建 + 建 venv + 装依赖，复用同一 job 快照上报。"""
    _ensure_ai_before_job(project_root, job)
    job.set_current("kernel_build")
    job.log("[OnboardingAssets] phase=kernel_bootstrap result=start")
    result = kernel_bootstrap.bootstrap_kernel(project_root, job=job)
    if not isinstance(result, dict) or result.get("ok") is not True:
        error = result.get("error") if isinstance(result, dict) else None
        code = str((error or {}).get("code") or "kernel_bootstrap_failed")
        job.log(
            f"[OnboardingAssets] phase=kernel_bootstrap result=error code={code}"
        )
        raise kernel_bootstrap.KernelBootstrapError(
            code,
            f"kernel bootstrap failed: {code}",
            detail=str((error or {}).get("detail") or ""),
        )
    job.log("[OnboardingAssets] phase=kernel_bootstrap result=ok")
    return result


class _KernelJobProgress:
    """内核作业的单调整体进度：下载字节 + 运行时安装预算。"""

    def __init__(self, job: onboarding_jobs.Job, download_bytes: int, runtime_bytes: int) -> None:
        self._job = job
        self.runtime_bytes = max(int(runtime_bytes), 0)
        self.done = 0
        self.total = max(int(download_bytes), 0) + self.runtime_bytes
        self.pct = 0

    @staticmethod
    def _percent(done: int, total: int) -> int:
        return int(done * 100 / total) if total else 0

    def _set(self, done: int, total: int) -> None:
        total = max(int(total), self.total, 1)
        done = min(max(int(done), self.done), total)
        pct = self._percent(done, total)
        if pct < self.pct:
            done = min(total, max(done, (self.pct * total + 99) // 100))
        self.done = done
        self.total = total
        self.pct = max(self.pct, self._percent(done, total))
        self._job.update_progress(done, total, phase=self._job.current)

    def download(self, done: int, total: int | None) -> None:
        base = int(total or 0) or max(self.total - self.runtime_bytes, 0)
        self._set(int(done), base + self.runtime_bytes)

    def downloaded(self, byte_count: int) -> None:
        self._set(int(byte_count), int(byte_count) + self.runtime_bytes)

    def step(self, share: float, download_bytes: int) -> None:
        download_bytes = max(int(download_bytes), 0)
        self._set(
            download_bytes + int(self.runtime_bytes * share),
            download_bytes + self.runtime_bytes,
        )

    def complete(self) -> None:
        self._set(self.total, self.total)


def _kernel_release_runner(
    project_root: Path, job: onboarding_jobs.Job
) -> dict[str, Any]:
    """内核步骤：下载预构建发行包，再安装运行期（venv + torch + 依赖）。

    非源码检出环境没有 pyproject/源码，依赖来自发行包根的
    ``kernel/requirements.txt``；运行时失败不回滚已安装的内核包。
    """
    manifest_url, base_url = _release_settings()
    if not manifest_url and not base_url:
        code = "kernel_release_not_configured"
        job.log(
            f"[OnboardingAssets] phase=manifest asset=kernel result=error code={code}"
        )
        raise release_assets.ReleaseAssetError(
            code,
            f"未配置内核发行清单，无法下载内核；开发 checkout 可在本地构建（{code}）",
        )
    _ensure_ai_before_job(project_root, job)
    job.set_current("manifest")
    job.log("[OnboardingAssets] phase=manifest asset=kernel result=start")
    manifest = release_assets.load_manifest(manifest_url, base_url=base_url)
    job.log("[OnboardingAssets] phase=manifest asset=kernel result=ok")
    asset = manifest.assets.get("kernel")
    if asset is None:
        raise release_assets.ManifestError(
            "kernel_asset_missing", "manifest has no kernel asset"
        )

    classification = kernel_bootstrap.gpu_classify()
    runtime_budget = kernel_bootstrap.runtime_download_bytes(classification)
    download_size = int(getattr(asset, "size", 0) or 0)
    job.log(
        "[OnboardingAssets] phase=classify kind=%s detail=%s runtime_bytes=%d"
        % (classification[0], classification[1], runtime_budget)
    )
    progress = _KernelJobProgress(job, download_size, runtime_budget)
    job.set_current("download")

    def on_progress(done: int, total: int | None) -> None:
        job.set_current("download")
        progress.download(done, total)

    try:
        result = kernel_assets.download_kernel(
            manifest,
            project_root,
            progress=on_progress,
            cancel_event=job.cancel_event,
            phase=job.set_current,
        )
    except release_assets.ReleaseAssetError as exc:
        job.log(
            "[OnboardingAssets] phase=kernel_release asset=kernel "
            f"result=error code={exc.code}"
        )
        raise
    downloaded = int(result.get("bytes") or download_size or 0)
    progress.downloaded(downloaded)
    progress.step(0.05, downloaded)
    job.log(
        "[OnboardingAssets] phase=kernel_release asset=kernel result=ok "
        f"version={result.get('version') or ''} bytes={downloaded}"
    )

    from config.config import get_config

    try:
        cfg = get_config()
    except Exception:  # 配置读取失败不阻断：无显式 torch 源时按驱动自动判定
        cfg = None
    torch_index = kernel_bootstrap.torch_index_url(cfg, classification)

    def _runtime_phase(name: str) -> None:
        if name == "venv":
            progress.step(0.08, downloaded)
            job.log("[OnboardingAssets] phase=kernel_venv result=start")
        elif name == "torch":
            job.set_current("kernel_torch")
            progress.step(0.15, downloaded)
            job.log(
                "[OnboardingAssets] phase=kernel_torch result=start kind=%s index=%s"
                % (classification[0], torch_index or "pypi")
            )
        elif name == "deps":
            job.set_current("kernel_deps")
            progress.step(0.85, downloaded)
            job.log("[OnboardingAssets] phase=kernel_deps result=start")

    job.set_current("kernel_venv")
    job.log(
        "[OnboardingAssets] phase=kernel_runtime result=start "
        f"kind={classification[0]}"
    )
    try:
        venv_info = kernel_bootstrap.ensure_kernel_venv(
            project_root,
            requirements_file=project_root / "kernel" / "requirements.txt",
            classification=classification,
            torch_index=torch_index,
            phase=_runtime_phase,
            log=job.log,
            cancel_event=job.cancel_event,
        )
    except kernel_bootstrap.KernelBootstrapError as exc:
        job.log(
            f"[OnboardingAssets] phase=kernel_runtime result=error code={exc.code}"
        )
        raise
    progress.step(0.95, downloaded)

    job.set_current("kernel_verify")
    job.log("[OnboardingAssets] phase=kernel_verify result=start")
    try:
        verification = kernel_bootstrap.verify_kernel_runtime(
            venv_info["venv_python"],
            project_root / "kernel",
            cancel_event=job.cancel_event,
        )
    except kernel_bootstrap.KernelBootstrapError as exc:
        job.log(
            f"[OnboardingAssets] phase=kernel_verify result=error code={exc.code}"
        )
        raise
    progress.complete()
    job.log("[OnboardingAssets] phase=kernel_verify result=ok")
    job.log(
        "[OnboardingAssets] phase=kernel_runtime result=ok "
        f"venv={venv_info['venv_python']} torch={venv_info['torch']}"
    )
    enriched = dict(result)
    enriched.update(
        {
            "venv_python": venv_info["venv_python"],
            "runtime_venv": venv_info["venv_dir"],
            "torch": venv_info["torch"],
            "torch_cpu_fallback": venv_info["torch_cpu_fallback"],
            "deps_mode": venv_info["deps_mode"],
            "requirements_file": venv_info["requirements_file"],
            "classification": classification[0],
            "verify_command": verification["command"],
        }
    )
    return enriched


def _download_runner(project_root: Path, asset_name: str):
    if asset_name == "kernel":
        def kernel_runner(job: onboarding_jobs.Job) -> dict[str, Any]:
            guard = kernel_assets.kernel_install_guard(project_root)
            if guard == "kernel_install_forbidden_dev_checkout":
                job.log(
                    "[OnboardingAssets] phase=kernel_source result=dev_checkout"
                )
                return _kernel_bootstrap_runner(project_root, job)
            return _kernel_release_runner(project_root, job)

        return kernel_runner

    from config.config import get_config

    cfg = get_config()
    manifest_url = cfg.ONBOARDING_RELEASE_MANIFEST_URL
    base_url = cfg.ONBOARDING_RELEASE_BASE_URL

    def runner(job: onboarding_jobs.Job) -> dict[str, Any]:
        job.set_current("manifest")
        job.log(f"[OnboardingAssets] phase=manifest asset={asset_name} result=start")
        manifest = release_assets.load_manifest(manifest_url, base_url=base_url)
        job.log(f"[OnboardingAssets] phase=manifest asset={asset_name} result=ok")
        asset = manifest.assets.get(asset_name)
        if asset is None:
            raise release_assets.ManifestError(
                "asset_missing", f"manifest has no {asset_name} asset"
            )
        job.set_current(asset_name)
        return release_assets.install_frontend_asset(
            asset,
            project_root,
            progress=job.update_progress,
            cancel_event=job.cancel_event,
        )

    return runner


def _model_download_runner(
    project_root: Path, models: list[str] | None, tiers: list[str] | None
):
    def runner(job: onboarding_jobs.Job) -> dict[str, Any]:
        _ensure_ai_before_job(project_root, job)
        manifest = kernel_model_manifest.load_manifest(
            kernel_model_assets.manifest_path()
        )
        job.set_current("models")
        job.log("[KernelModels] phase=download result=start")
        result = kernel_model_assets.download(
            manifest,
            {"models": models, "tiers": tiers},
            project_root,
            progress=job.update_progress,
            cancel_event=job.cancel_event,
            log=job.log,
        )
        blocked = list(result["failed"]) + list(result["unsupported"])
        if not blocked and result["gated"] and not (
            result["installed"] or result["present"]
        ):
            blocked = list(result["gated"])
        if blocked:
            raise kernel_model_assets.KernelModelAssetError(
                "model_download_failed", "模型下载未完成: " + ", ".join(blocked)
            )
        return result

    return runner


def _startup_status(
    request: Request,
) -> onboarding_service.StartupStatus | None:
    runtime = getattr(request.app.state, "bootstrap_runtime", None)
    if runtime is None:
        return None
    runtime_state = str(getattr(runtime, "state", "") or "")
    reporter = getattr(runtime, "report", None)
    runtime_report = reporter() if callable(reporter) else {"state": runtime_state}
    validation = getattr(request.app.state, "startup_validation", None)
    validation_reporter = getattr(validation, "report", None)
    report = validation_reporter() if callable(validation_reporter) else {}
    return onboarding_service.StartupStatus(
        runtime_state=runtime_state,
        validation_report=report if isinstance(report, dict) else {},
        runtime_report=runtime_report if isinstance(runtime_report, dict) else {},
    )


def _startup_gate_error(
    exc: onboarding_service.StartupGateError,
) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "code": exc.code,
            "message": exc.message,
            "startup": exc.startup,
            "runtime": exc.runtime,
        },
    )


def _activation_failed(activation: dict[str, Any]) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={
            "code": "activation_failed",
            "message": "服务提交失败，引导尚未完成",
            "activation": activation,
        },
    )


def _config_error(exc: ConfigStoreError) -> JSONResponse:
    errors = [
        {
            "path": error.path,
            "code": error.code,
            "message": error.message,
            "severity": error.severity,
        }
        for error in getattr(exc, "errors", ())
    ]
    if isinstance(exc, ConfigValidationError):
        return JSONResponse(
            status_code=422,
            content={
                "code": exc.code,
                "message": exc.message,
                "errors": errors,
            },
        )
    if isinstance(exc, (ConfigEnvLocked, ConfigReadOnly)):
        content: dict[str, Any] = {
            "code": exc.code,
            "message": exc.message,
            "errors": errors,
        }
        if isinstance(exc, ConfigEnvLocked):
            content["paths"] = list(exc.paths)
        return JSONResponse(status_code=409, content=content)
    if isinstance(exc, ConfigWriteError):
        return _error(500, exc.code, exc.message)
    return _error(
        500,
        getattr(exc, "code", "") or "config_error",
        getattr(exc, "message", "") or str(exc),
    )


async def _stage_step_config(
    step_id: str, data: dict[str, Any] | None
) -> tuple[dict[str, Any] | None, JSONResponse | None]:
    """把已完成步骤的配置意图写入草稿；不 apply、不写 config.yaml。"""
    try:
        store = get_config_store()
        changes = onboarding_service.step_config_changes(
            step_id, data, store.snapshot()
        )
        if not changes:
            return None, None
        pending = await run_in_threadpool(store.stage, changes)
    except ConfigStoreError as exc:
        return None, _config_error(exc)
    return {"pending": len(pending), "paths": sorted(pending)}, None


async def _apply_staged_once() -> tuple[dict[str, Any] | None, JSONResponse | None]:
    """finish 唯一一次草稿应用；任一键失败都返回 409 且不写 completed。"""
    try:
        result = await config_reconciler.apply_staged(get_config_store())
    except ConfigStoreError as exc:
        return None, _config_error(exc)
    except Exception:
        logger.exception("onboarding finish apply failed")
        return None, _error(500, "finish_apply_failed", "配置应用异常，引导尚未完成")
    failed = list(result.get("failed") or [])
    if failed:
        return None, JSONResponse(
            status_code=409,
            content={
                "code": "finish_apply_failed",
                "message": "配置应用失败，引导尚未完成",
                "apply": result,
            },
        )
    return result, None


@router.get("/preflight", response_model=PreflightResult)
async def get_preflight(request: Request) -> PreflightResult | JSONResponse:
    auth_error = await _require_read_auth(request)
    if auth_error is not None:
        return auth_error
    result = await run_in_threadpool(
        onboarding_service.run_preflight, _project_root()
    )
    return PreflightResult.model_validate(result)


@router.get("/status", response_model=OnboardingStatus)
async def get_status(request: Request) -> OnboardingStatus | JSONResponse:
    needs_setup = auth.is_setup_required()
    if not needs_setup:
        auth_error = await _require_read_auth(request)
        if auth_error is not None:
            return auth_error
    runtime = onboarding_service.read_config_runtime_status()
    onboarding_complete = onboarding_service.legacy_complete(
        not needs_setup, runtime.degraded
    )
    state = onboarding_service.get_state()
    if needs_setup:
        state = {
            key: value
            for key, value in state.items()
            if key not in ("step_data", "legacy_step_data")
        }
    degraded_reasons: list[str] = []
    if runtime.degraded:
        degraded_reasons.append(runtime.detail or "config_degraded")
    return OnboardingStatus(
        state=state,
        needs_setup=needs_setup,
        degraded=runtime.degraded,
        onboarding_complete=onboarding_complete,
        config_revision=runtime.revision or "",
        steps=onboarding_service.steps_metadata(state),
        bootstrap=onboarding_service.is_bootstrap_mode(),
        state_version=int(state.get("version") or onboarding_service.STATE_VERSION),
        legacy_upgraded=bool(state.get("legacy_upgraded")),
        degraded_reasons=degraded_reasons,
    )


@router.post("/state", response_model=None)
async def record_state(
    request: Request,
) -> dict[str, Any] | JSONResponse:
    payload, body_error = await _json_object(request)
    if body_error is not None:
        return body_error
    if payload is None:
        return _error(422, "invalid_request", "请求体必须是 JSON 对象")
    try:
        body = OnboardingStateRequest.model_validate(payload)
    except ValidationError as exc:
        return _error(422, "invalid_request", _validation_message(exc))

    auth_error = await _require_state_auth(request)
    if auth_error is not None:
        return auth_error

    runtime = getattr(request.app.state, "bootstrap_runtime", None)
    runtime_active = bool(getattr(runtime, "active", False))
    runtime_committed = bool(getattr(runtime, "committed", False))
    startup_status = _startup_status(request)

    activation: dict[str, Any] | None = None
    apply_result: dict[str, Any] | None = None
    finish_request = (
        body.step_id == "finish"
        and body.status == "completed"
        and not body.dry_run
    )
    if (
        finish_request
        and runtime is not None
        and (runtime_active or runtime_committed)
    ):
        try:
            await run_in_threadpool(
                onboarding_service.record_step,
                body.step_id,
                body.status,
                body.data,
                True,
                startup_status=startup_status,
            )
        except onboarding_service.StepOutOfOrder as exc:
            return _error(409, "step_out_of_order", str(exc))
        except onboarding_service.PreflightGateError as exc:
            return _preflight_gate_error(exc)
        except onboarding_service.StartupGateError as exc:
            return _startup_gate_error(exc)
        except ValueError as exc:
            return _error(422, "invalid_step", str(exc))
        apply_result, apply_error = await _apply_staged_once()
        if apply_error is not None:
            return apply_error
        promoter = getattr(runtime, "promote", None)
        if (
            runtime_active
            and getattr(runtime, "state", "") == "validated"
            and callable(promoter)
        ):
            await promoter("onboarding_finish")
            startup_status = _startup_status(request)
        committer = getattr(runtime, "commit", None)
        if not callable(committer):
            return _activation_failed(
                {"ok": False, "committed": False, "status": "commit_unavailable"}
            )
        activation = await committer("onboarding_finish")
        if not activation.get("ok") or not activation.get("committed"):
            return _activation_failed(activation)

    staged: dict[str, Any] | None = None
    if (
        not finish_request
        and body.status == "completed"
        and not body.dry_run
    ):
        try:
            await run_in_threadpool(
                onboarding_service.record_step,
                body.step_id,
                body.status,
                body.data,
                True,
                startup_status=startup_status,
            )
        except onboarding_service.StepOutOfOrder as exc:
            return _error(409, "step_out_of_order", str(exc))
        except onboarding_service.PreflightGateError as exc:
            return _preflight_gate_error(exc)
        except onboarding_service.StartupGateError as exc:
            return _startup_gate_error(exc)
        except ValueError as exc:
            return _error(422, "invalid_step", str(exc))
        staged, staged_error = await _stage_step_config(
            body.step_id, body.data
        )
        if staged_error is not None:
            return staged_error

    try:
        state = await run_in_threadpool(
            onboarding_service.record_step,
            body.step_id,
            body.status,
            body.data,
            body.dry_run,
            startup_status=startup_status,
        )
    except onboarding_service.StepOutOfOrder as exc:
        return _error(409, "step_out_of_order", str(exc))
    except onboarding_service.PreflightGateError as exc:
        return _preflight_gate_error(exc)
    except onboarding_service.StartupGateError as exc:
        return _startup_gate_error(exc)
    except ValueError as exc:
        return _error(422, "invalid_step", str(exc))

    recorded = not body.dry_run and (
        body.step_id in state["completed_steps"]
        or body.step_id in state["skipped_steps"]
    )
    result: dict[str, Any] = {"state": state, "recorded": recorded}
    if activation is not None:
        result["activation"] = activation
    if apply_result is not None:
        result["apply"] = apply_result
    if staged is not None:
        result["staged"] = staged
    return result


@router.post("/action", response_model=None)
async def run_action(
    request: Request,
) -> dict[str, Any] | JSONResponse:
    payload, body_error = await _json_object(request)
    if body_error is not None:
        return body_error
    if payload is None:
        return _error(422, "invalid_request", "请求体必须是 JSON 对象")
    try:
        body = OnboardingActionRequest.model_validate(payload)
    except ValidationError as exc:
        return _error(422, "invalid_request", _validation_message(exc))

    auth_error = await _require_action_auth(request, body.current_password)
    if auth_error is not None:
        return auth_error

    try:
        match body.action:
            case "copy_ai_template":
                result = onboarding_service.copy_ai_template(
                    _project_root(), overwrite=body.overwrite
                )
            case "generate_self_signed_cert":
                result = onboarding_service.generate_self_signed_cert(
                    _project_root(), overwrite=body.overwrite
                )
            case unreachable:
                raise AssertionError(f"unsupported action: {unreachable}")
    except onboarding_service.OnboardingActionError as exc:
        return _error(exc.status_code, exc.code, exc.message)
    except Exception:
        logger.exception("onboarding action failed: %s", body.action)
        return _error(500, "action_failed", "执行初始化操作失败")
    return {"ok": True, "result": result}


@router.get("/assets", response_model=None)
async def get_assets(request: Request) -> dict[str, Any] | JSONResponse:
    auth_error = await _require_read_auth(request)
    if auth_error is not None:
        return auth_error
    try:
        dependencies = await run_in_threadpool(
            kernel_assets.inspect, _project_root()
        )
    except Exception:
        logger.exception("onboarding dependency status failed")
        dependencies = None
    try:
        manifest = await _fetch_manifest()
    except release_assets.ReleaseAssetError as exc:
        return {
            "configured": True,
            "manifest": None,
            "assets": {},
            "dependencies": dependencies,
            "error": exc.code,
        }
    return {
        "configured": True,
        **manifest.public(),
        "dependencies": dependencies,
    }


@router.post("/assets/download", response_model=None)
async def start_asset_download(request: Request) -> JSONResponse | dict[str, Any]:
    payload, body_error = await _json_object(request)
    if body_error is not None:
        return body_error
    if payload is None:
        return _error(422, "invalid_request", "请求体必须是 JSON 对象")
    try:
        body = AssetDownloadRequest.model_validate(payload)
    except ValidationError as exc:
        return _error(422, "invalid_request", _validation_message(exc))

    auth_error = await _require_write_auth(request, body.password)
    if auth_error is not None:
        return auth_error

    asset_name = body.asset.strip().lower()
    if asset_name == "models":
        return _error(
            400,
            "model_download_not_implemented",
            "模型下载由后续引导步骤负责",
        )
    if asset_name not in {"kernel", "frontend"}:
        return _error(400, "unsupported_asset", f"不支持的发行资产: {asset_name}")

    root = _project_root()
    if asset_name == "frontend" and (
        root / "frontend" / "mobile" / "dist" / "index.html"
    ).is_file():
        return _error(409, "frontend_dist_present", "前端 dist 已存在，不覆盖")
    if asset_name == "kernel":
        guard = kernel_assets.kernel_install_guard(root)
        # 源码检出允许本地构建，不算发行包覆盖；其余守卫码仍然拒绝。
        if guard is not None and guard != "kernel_install_forbidden_dev_checkout":
            return _error(409, guard, "当前内核目录不允许发行包覆盖")

    manager = onboarding_jobs.get_job_manager()
    try:
        job = manager.start(
            f"download:{asset_name}",
            _download_runner(root, asset_name),
            asset=asset_name,
        )
    except onboarding_jobs.JobAlreadyRunning as exc:
        return _error(
            409,
            "download_in_progress",
            f"已有下载作业在进行: {exc.job_id}",
        )
    return JSONResponse(status_code=202, content={"job": job.snapshot()})


@router.get("/models", response_model=None)
async def get_models(request: Request) -> dict[str, Any] | JSONResponse:
    auth_error = await _require_read_auth(request)
    if auth_error is not None:
        return auth_error
    try:
        return await run_in_threadpool(kernel_model_assets.status, _project_root())
    except kernel_model_manifest.KernelModelManifestError as exc:
        return _error(500, exc.code, _safe_message(exc))
    except Exception:
        logger.exception("kernel model status failed")
        return _error(500, "models_status_failed", "读取内核模型状态失败")


@router.post("/models/download", response_model=None)
async def start_model_download(request: Request) -> JSONResponse | dict[str, Any]:
    payload, body_error = await _json_object(request)
    if body_error is not None:
        return body_error
    if payload is None:
        return _error(422, "invalid_request", "请求体必须是 JSON 对象")
    try:
        body = ModelDownloadRequest.model_validate(payload)
    except ValidationError as exc:
        return _error(422, "invalid_request", _validation_message(exc))

    auth_error = await _require_write_auth(request, body.password)
    if auth_error is not None:
        return auth_error

    selection = {"models": body.models, "tiers": body.tiers}
    try:
        manifest = await run_in_threadpool(
            kernel_model_manifest.load_manifest,
            kernel_model_assets.manifest_path(),
        )
        kernel_model_assets.select_models(manifest, selection)
    except kernel_model_manifest.KernelModelManifestError as exc:
        status = 422 if exc.code in {"invalid_tier", "unknown_model_id"} else 500
        return _error(status, exc.code, _safe_message(exc))
    except kernel_model_assets.KernelModelAssetError as exc:
        return _error(422, exc.code, _safe_message(exc))

    if not kernel_model_assets.download_enabled():
        return _error(
            409, "model_download_disabled", "配置已禁用内核模型下载"
        )

    root = _project_root()
    manager = onboarding_jobs.get_job_manager()
    try:
        job = manager.start(
            "download:models",
            _model_download_runner(root, body.models, body.tiers),
            asset="models",
        )
    except onboarding_jobs.JobAlreadyRunning as exc:
        return _error(
            409,
            "download_in_progress",
            f"已有下载作业在进行: {exc.job_id}",
        )
    return JSONResponse(status_code=202, content={"job": job.snapshot()})


@router.get("/jobs/{job_id}", response_model=None)
async def get_job(request: Request, job_id: str) -> dict[str, Any] | JSONResponse:
    auth_error = await _require_read_auth(request)
    if auth_error is not None:
        return auth_error
    try:
        snapshot = onboarding_jobs.get_job_manager().snapshot(job_id)
    except onboarding_jobs.JobNotFound:
        return _error(404, "job_not_found", "下载作业不存在")
    return {"job": snapshot}


@router.post("/jobs/{job_id}/cancel", response_model=None)
async def cancel_job(request: Request, job_id: str) -> dict[str, Any] | JSONResponse:
    payload, body_error = await _optional_json_object(request)
    if body_error is not None:
        return body_error
    password = payload.get("password") if isinstance(payload, dict) else None
    if password is not None and not isinstance(password, str):
        return _error(422, "invalid_request", "password 必须是字符串")
    auth_error = await _require_write_auth(request, password)
    if auth_error is not None:
        return auth_error
    try:
        snapshot = onboarding_jobs.get_job_manager().cancel(job_id)
    except onboarding_jobs.JobNotFound:
        return _error(404, "job_not_found", "下载作业不存在")
    return {"job": snapshot}
