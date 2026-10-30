# -*- coding: utf-8 -*-
"""v4 引导收口：预检、草稿应用与服务就绪审计。

v4 把可见步骤收窄为唯一的 ``finish``。服务面随 lifespan 启动，finish 不再
负责 attempt / validate / promote，只做三件只读或幂等的事：

1. 预检端口与路径（端口由当前服务监听属于正常，被其他进程占用才阻塞）；
2. 一次性应用步骤累积的配置草稿；
3. 按编排器快照审计 ``critical=True`` 的服务：必须 ``ready``，或用户在其
   引导步骤显式 ``skipped``；关键服务未就绪即 409 ``finish_blocked``，
   列出 ``{id, reason_code, detail}``。非关键服务失败只记录，不阻断。

所有面向 HTTP 的失败都收敛为 :class:`FinishError`，携带分层
``groups``（blocking / soft）供前端逐项展示；响应绝不包含令牌或密码。
"""
from __future__ import annotations

import copy
import logging
from collections.abc import Mapping
from typing import Any, Optional

from starlette.concurrency import run_in_threadpool

from config.config import get_config
from config.store import ConfigStoreError, get_config_store
from core.redaction import redact_text
from services import onboarding_service
from services.config_reconciler import apply_staged
from services.orchestrator.runtime import get_orchestrator

logger = logging.getLogger(__name__)

_STEP_LABELS: dict[str, str] = {
    "welcome": "欢迎",
    "account": "管理员账号",
    "dependencies": "依赖检查",
    "kernel": "音频内核",
    "kernel_models": "内核模型",
    "xiaomi": "小米健康云",
    "qq": "QQ 网关",
    "moss": "MOSS 深度音频",
    "loom": "AI 助手",
    "clients": "客户端",
    "finish": "完成",
}

_STEP_ORDER: tuple[str, ...] = (
    "welcome",
    "account",
    "dependencies",
    "kernel",
    "kernel_models",
    "xiaomi",
    "qq",
    "moss",
    "loom",
    "clients",
    "finish",
)

_CRITICAL_SERVICE_STEPS: dict[str, str] = {
    "kernel": "kernel",
    "loom": "loom",
    "moss_watcher": "moss",
}


class FinishError(Exception):
    """finish 编排失败；携带稳定错误码与分层诊断信息。"""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        groups: Optional[dict[str, list[dict[str, Any]]]] = None,
        report: Optional[dict[str, Any]] = None,
        runtime: Optional[dict[str, Any]] = None,
        activation: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.groups = groups if groups is not None else _empty_groups()
        self.report = report or {}
        self.runtime = runtime or {}
        self.activation = activation or {}

    def payload(self) -> dict[str, Any]:
        return {
            "ok": False,
            "code": self.code,
            "message": self.message,
            "groups": copy.deepcopy(self.groups),
            "report": copy.deepcopy(self.report),
            "runtime": copy.deepcopy(self.runtime),
            "activation": copy.deepcopy(self.activation),
        }


def _empty_groups() -> dict[str, list[dict[str, Any]]]:
    return {"blocking": [], "soft": []}


def _item(
    layer: str, item_id: str, title: str, message: str, fix: str = ""
) -> dict[str, Any]:
    return {
        "layer": layer,
        "id": str(item_id),
        "title": redact_text(str(title or item_id)),
        "message": redact_text(str(message or "")),
        "fix": redact_text(str(fix or "")),
    }


def _merge_groups(*groups: Mapping[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    merged = _empty_groups()
    seen: set[tuple[str, str, str, str]] = set()
    for group in groups:
        for bucket in ("blocking", "soft"):
            for item in group.get(bucket) or ():
                key = (
                    bucket,
                    str(item.get("layer") or ""),
                    str(item.get("id") or ""),
                    str(item.get("message") or ""),
                )
                if key in seen:
                    continue
                seen.add(key)
                merged[bucket].append(copy.deepcopy(item))
    return merged


def group_preflight(result: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """把预检结果转成分层诊断项；硬失败归 blocking，软失败归 soft。

    必需内核模型缺失（kernel_models=fail）即使 allow_degraded 也归 blocking。
    """
    groups = _empty_groups()
    checks = {
        str(check.get("id")): check
        for check in result.get("checks") or ()
        if isinstance(check, Mapping)
    }

    def add(bucket: str, check_id: Any) -> None:
        key = str(check_id)
        check = checks.get(key) or {}
        resolved_id = str(check.get("id") or key)
        groups[bucket].append(
            _item(
                "preflight",
                resolved_id,
                str(check.get("label") or resolved_id),
                str(check.get("detail") or ""),
                str(check.get("fix") or ""),
            )
        )

    blocking_ids = {str(check_id) for check_id in result.get("blocking_failures") or ()}
    for check_id in blocking_ids:
        add("blocking", check_id)
    kernel_models_failed = (
        str((checks.get("kernel_models") or {}).get("status")) == "fail"
    )
    for check_id in result.get("soft_failures") or ():
        if kernel_models_failed and str(check_id) == "kernel_models":
            if "kernel_models" not in blocking_ids:
                add("blocking", check_id)
            continue
        add("soft", check_id)
    return groups


def _state_attr(app: Any, name: str) -> Any:
    state = getattr(app, "state", app)
    return getattr(state, name, None)


def _set_state_attr(app: Any, name: str, value: Any) -> None:
    state = getattr(app, "state", app)
    setattr(state, name, value)


def _runtime_report(runtime: Any) -> dict[str, Any]:
    reader = getattr(runtime, "report", None)
    if not callable(reader):
        return {}
    try:
        value = reader()
    except Exception:  # noqa: BLE001
        logger.warning("[OnboardingFinish] 运行时报告读取失败", exc_info=True)
        return {}
    return copy.deepcopy(value) if isinstance(value, dict) else {}


def _safe_config() -> Any:
    try:
        return get_config()
    except Exception:  # noqa: BLE001
        return None


def _qq_gateway_enabled() -> bool:
    try:
        from services.qq_gateway.config import QQGatewayConfig

        return bool(QQGatewayConfig.load().enabled)
    except Exception:  # noqa: BLE001
        return False


def _feature_enabled(
    state: Mapping[str, Any], step_id: str, fallback: bool = False
) -> bool:
    """读取步骤保存的 enabled；缺失时回退到部署配置（兼容旧状态）。"""
    data = (state.get("step_data") or {}).get(step_id)
    if isinstance(data, Mapping) and "enabled" in data:
        return data.get("enabled") is True
    return fallback


def closing(
    state: Mapping[str, Any],
    groups: Optional[Mapping[str, list[dict[str, Any]]]] = None,
) -> dict[str, Any]:
    """构造完成页收口数据：已启用、已跳过、降级项与进入按钮。"""
    completed = {str(item) for item in state.get("completed_steps") or ()}
    skipped = {str(item) for item in state.get("skipped_steps") or ()}
    config = _safe_config()

    enabled: list[dict[str, str]] = []
    if _feature_enabled(
        state, "xiaomi", bool(getattr(config, "HEALTH_CLOUD_ENABLED", False))
    ):
        enabled.append({"id": "xiaomi", "label": _STEP_LABELS["xiaomi"]})
    if _feature_enabled(state, "qq", _qq_gateway_enabled()):
        enabled.append({"id": "qq", "label": _STEP_LABELS["qq"]})
    if _feature_enabled(
        state, "moss", bool(getattr(config, "MOSS_ENABLED", False))
    ):
        enabled.append({"id": "moss", "label": _STEP_LABELS["moss"]})
    loom_backend = str(getattr(config, "AI_BACKEND", "") or "").strip().lower()
    loom_enabled = "loom" in completed and loom_backend == "loom"
    if loom_enabled:
        enabled.append({"id": "loom", "label": _STEP_LABELS["loom"]})
    enabled.append({"id": "clients", "label": _STEP_LABELS["clients"]})

    skipped_items: list[dict[str, str]] = []
    seen_skipped: set[str] = set()
    for step_id in _STEP_ORDER:
        if step_id in skipped:
            skipped_items.append(
                {"id": step_id, "label": _STEP_LABELS.get(step_id, step_id)}
            )
            seen_skipped.add(step_id)
    for step_id in ("xiaomi", "qq", "moss", "loom"):
        if step_id in seen_skipped or step_id not in completed:
            continue
        active = step_id == "loom" and loom_enabled
        if step_id == "xiaomi":
            active = _feature_enabled(
                state, step_id, bool(getattr(config, "HEALTH_CLOUD_ENABLED", False))
            )
        elif step_id == "qq":
            active = _feature_enabled(state, step_id, _qq_gateway_enabled())
        elif step_id == "moss":
            active = _feature_enabled(
                state, step_id, bool(getattr(config, "MOSS_ENABLED", False))
            )
        if not active:
            skipped_items.append(
                {"id": step_id, "label": _STEP_LABELS.get(step_id, step_id)}
            )
    soft = (groups or {}).get("soft") or []
    degraded = [
        {
            "id": str(item.get("id") or ""),
            "message": str(item.get("message") or ""),
        }
        for item in soft
        if isinstance(item, Mapping)
    ]
    return {
        "title": "初始化完成",
        "message": "系统已完成初始化，你可以开始使用了。",
        "enabled": enabled,
        "skipped": skipped_items,
        "degraded": degraded,
        "enter_label": "进入主界面",
    }


def _orchestrator_snapshot() -> dict[str, Any]:
    """读取编排器服务快照；独立函数便于测试替换，不启动任何服务。"""
    return get_orchestrator().snapshot()


def _service_step(service_id: str) -> str:
    """编排器服务 id -> 引导步骤 id；未知服务退回服务 id 自身。"""
    return _CRITICAL_SERVICE_STEPS.get(service_id, service_id)


def readiness_audit(state: Mapping[str, Any]) -> dict[str, Any]:
    """按编排器快照审计关键服务；纯读，绝不启动或停止服务。

    规则：``critical=True`` 的服务必须 ``ready``，或用户在其引导步骤显式
    ``skipped``。未就绪的关键服务进入 ``blocking``（稳定三元组
    ``id/reason_code/detail``）；非关键服务即使 ``failed`` 也只记录在
    ``non_critical``，不阻断完成。
    """
    try:
        snapshot = _orchestrator_snapshot()
    except Exception as exc:  # noqa: BLE001 - 无法审计时按未就绪处理
        logger.warning("[OnboardingFinish] 编排器快照读取失败: %s", exc)
        return {
            "ok": False,
            "orchestrator": "unavailable",
            "services": [],
            "blocking": [
                {
                    "id": "orchestrator",
                    "reason_code": "snapshot_failed",
                    "detail": type(exc).__name__,
                }
            ],
            "non_critical": [],
        }

    mode = str(snapshot.get("orchestrator") or "")
    if mode != "on":
        return {
            "ok": False,
            "orchestrator": mode or "unknown",
            "services": [],
            "blocking": [
                {
                    "id": "orchestrator",
                    "reason_code": "orchestrator_off",
                    "detail": "服务编排器未启用，无法完成就绪审计",
                }
            ],
            "non_critical": [],
        }

    skipped = {str(item) for item in state.get("skipped_steps") or ()}
    services: list[dict[str, Any]] = []
    blocking: list[dict[str, Any]] = []
    non_critical: list[dict[str, Any]] = []
    for entry in snapshot.get("services") or ():
        if not isinstance(entry, Mapping):
            continue
        service_id = str(entry.get("id") or "")
        if not service_id:
            continue
        service_state = str(entry.get("state") or "")
        record = {
            "id": service_id,
            "state": service_state,
            "reason_code": str(entry.get("reason_code") or ""),
            "detail": str(entry.get("detail") or ""),
        }
        if entry.get("critical") is not True:
            if service_state == "failed":
                non_critical.append(dict(record))
            services.append(
                {
                    **record,
                    "critical": False,
                    "step": _service_step(service_id),
                    "skipped": False,
                    "ok": service_state != "failed",
                }
            )
            continue
        step_id = _service_step(service_id)
        waived = step_id in skipped
        ok = service_state == "ready" or waived
        services.append(
            {
                **record,
                "critical": True,
                "step": step_id,
                "skipped": waived,
                "ok": ok,
            }
        )
        if not ok:
            blocking.append(
                {
                    "id": service_id,
                    "reason_code": record["reason_code"],
                    "detail": record["detail"],
                }
            )
    return {
        "ok": not blocking,
        "orchestrator": mode,
        "services": services,
        "blocking": blocking,
        "non_critical": non_critical,
    }


def _readiness_groups(
    audit: Mapping[str, Any],
) -> dict[str, list[dict[str, Any]]]:
    """把审计阻断项转成 finish 统一的分层诊断项。"""
    groups = _empty_groups()
    for entry in audit.get("blocking") or ():
        if not isinstance(entry, Mapping):
            continue
        service_id = str(entry.get("id") or "")
        step_id = _service_step(service_id)
        detail = str(entry.get("detail") or "")
        reason = str(entry.get("reason_code") or "")
        groups["blocking"].append(
            _item(
                "readiness",
                service_id,
                _STEP_LABELS.get(step_id, service_id),
                detail or reason or "服务未就绪",
                "修复该服务后重试完成引导，或在其引导步骤显式跳过。",
            )
        )
    return groups


def _audit_startup_status(audit: Mapping[str, Any]) -> onboarding_service.StartupStatus:
    """把审计结果包装成 record_step 的启动门禁快照。

    finish 不再驱动 bootstrap runtime；服务面在 lifespan 已启动，审计通过
    即等价于旧流程的 committed。``validation_report`` 保留审计摘要，供
    ``record_step`` 的结构化门禁使用。
    """
    warnings = [
        {
            "subsystem": str(item.get("id") or ""),
            "warning": str(item.get("detail") or item.get("reason_code") or ""),
        }
        for item in audit.get("non_critical") or ()
        if isinstance(item, Mapping)
    ]
    return onboarding_service.StartupStatus(
        runtime_state="committed",
        validation_report={
            "ok": True,
            "state": "ready",
            "errors": [],
            "warnings": warnings,
            "services": copy.deepcopy(audit.get("services") or []),
        },
        runtime_report={
            "state": "committed",
            "source": "readiness_audit",
            "readiness": copy.deepcopy(dict(audit)),
        },
    )


def _idempotent_success(app: Any, state: dict[str, Any]) -> dict[str, Any]:
    activation = _state_attr(app, "finish_activation")
    if not isinstance(activation, dict) or not activation:
        activation = _runtime_report(_state_attr(app, "bootstrap_runtime"))
    groups = _state_attr(app, "finish_groups")
    if not isinstance(groups, dict):
        stored = (state.get("step_data") or {}).get("finish") or {}
        candidate = stored.get("groups") if isinstance(stored, Mapping) else None
        groups = candidate if isinstance(candidate, dict) else _empty_groups()
    return {
        "ok": True,
        "state": copy.deepcopy(state),
        "activation": copy.deepcopy(activation),
        "groups": copy.deepcopy(groups),
        "closing": closing(state, groups),
        "idempotent": True,
    }


async def _apply_staged_drafts() -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    """应用引导步骤累积的配置草稿；失败项保留在草稿里可重试。"""
    groups = _empty_groups()
    try:
        result = await apply_staged(get_config_store())
    except ConfigStoreError as exc:
        groups["blocking"].append(
            _item("apply", exc.code, "配置应用", exc.message or str(exc))
        )
        return {}, groups
    except Exception as exc:  # noqa: BLE001 - 异常收敛为阻塞项，绝不写 completed
        logger.exception("[OnboardingFinish] 配置草稿应用异常")
        groups["blocking"].append(
            _item("apply", "apply_failed", "配置应用", type(exc).__name__)
        )
        return {}, groups
    for failure in result.get("failed") or ():
        if not isinstance(failure, Mapping):
            continue
        path = str(failure.get("path") or "")
        groups["blocking"].append(
            _item(
                "apply",
                path or "apply_failed",
                path or "配置应用",
                str(failure.get("error") or ""),
                "修正后重新完成引导，或到设置里应用草稿。",
            )
        )
    return result, groups


async def run_finish(app: Any, *, allow_degraded: bool = False) -> dict[str, Any]:
    """执行 v4 唯一收口步骤；成功返回结果，失败抛 :class:`FinishError`。

    服务面随 lifespan 启动，本函数不再 attempt / validate / promote。
    顺序固定：预检 -> 应用草稿 -> 就绪审计 -> 记录 completed。预检在进程内
    复用同一份结果（``app.state.finish_preflight_result``）交给
    ``record_step``，避免记录阶段重复探测端口。
    """
    state = onboarding_service.get_state()
    if state.get("completed") is True:
        return _idempotent_success(app, state)

    # 1) 预检：端口与路径。端口由当前服务监听属于正常。
    preflight = await run_in_threadpool(
        onboarding_service.run_preflight, onboarding_service.default_project_root()
    )
    _set_state_attr(app, "finish_preflight_result", copy.deepcopy(preflight))
    groups = group_preflight(preflight)
    if groups["blocking"]:
        raise FinishError(
            409,
            "finish_blocked",
            "预检存在阻塞项，处理后重试",
            groups=groups,
            report=preflight,
        )
    if groups["soft"] and not allow_degraded:
        raise FinishError(
            409,
            "finish_degraded_requires_ack",
            "存在降级项，需要显式确认 allow_degraded=true",
            groups=groups,
            report=preflight,
        )

    # 2) 一次性应用步骤草稿；失败立即 409，绝不写 completed。
    apply_result, apply_groups = await _apply_staged_drafts()
    if apply_groups["blocking"]:
        raise FinishError(
            409,
            "finish_apply_failed",
            "配置应用失败，处理后重试",
            groups=_merge_groups(groups, apply_groups),
            report={"apply": apply_result, "preflight": preflight},
        )

    # 3) 就绪审计：critical 服务必须 ready 或已被用户跳过。
    audit = readiness_audit(state)
    if not audit["ok"]:
        raise FinishError(
            409,
            "finish_blocked",
            "服务就绪审计未通过，处理后重试",
            groups=_merge_groups(groups, _readiness_groups(audit)),
            report={
                "readiness": audit,
                "apply": apply_result,
                "preflight": preflight,
            },
        )

    # 4) 审计通过才记录 completed；复用预检结果，绝不重跑。
    activation = {
        "ok": True,
        "committed": True,
        "activated": False,
        "state": "ready",
        "source": "readiness_audit",
        "orchestrator": audit.get("orchestrator"),
        "services": copy.deepcopy(audit.get("services") or []),
    }
    data = {
        "allow_degraded": bool(allow_degraded),
        "degraded": bool(groups["soft"]),
        "warnings": [item.get("message") for item in groups["soft"]],
        "groups": copy.deepcopy(groups),
        "readiness": copy.deepcopy(audit),
    }
    try:
        final_state = await run_in_threadpool(
            onboarding_service.record_step,
            "finish",
            "completed",
            data,
            False,
            startup_status=_audit_startup_status(audit),
            preflight_result=copy.deepcopy(
                _state_attr(app, "finish_preflight_result")
            ),
        )
    except Exception as exc:  # noqa: BLE001 - 状态写入失败必须如实上报
        logger.exception("[OnboardingFinish] finish 状态写入失败")
        raise FinishError(
            409,
            "finish_record_failed",
            "就绪审计已通过，但完成状态写入失败，请重试",
            groups=groups,
            report={"readiness": audit, "apply": apply_result},
            activation=activation,
        ) from exc

    _set_state_attr(app, "finish_groups", copy.deepcopy(groups))
    _set_state_attr(app, "finish_activation", copy.deepcopy(activation))
    return {
        "ok": True,
        "state": copy.deepcopy(final_state),
        "activation": copy.deepcopy(activation),
        "apply": copy.deepcopy(apply_result),
        "readiness": copy.deepcopy(audit),
        "groups": copy.deepcopy(groups),
        "closing": closing(final_state, groups),
    }
