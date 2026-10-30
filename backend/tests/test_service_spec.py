# -*- coding: utf-8 -*-
"""ServiceSpec 声明模型与注册表契约（GAP-5 / GAP-8）。

全部用例使用真实 ``Config`` 的静态文档模式（``Config({...})``，与
test_config_core_modes.py 相同的既有约定），不读写真实 config.yaml；
注册表是进程级全局，每个用例前后清空。
"""
from __future__ import annotations

from dataclasses import FrozenInstanceError
from typing import Any

import pytest

from config.config import Config
from services.orchestrator.spec import (
    REGISTRY,
    ServiceSpec,
    all_specs,
    clear_registry,
    get,
    register,
    requirements_satisfied,
)

KERNEL_PYTHON = "/opt/kinship/.venv-kernel/bin/python"


async def _noop_action() -> dict[str, Any]:
    return {"ok": True}


def _spec(**overrides: Any) -> ServiceSpec:
    values: dict[str, Any] = {
        "id": "demo",
        "requires": (),
        "gate": None,
        "start": _noop_action,
        "stop": _noop_action,
        "critical": False,
        "restart": True,
        "enable_key": None,
    }
    values.update(overrides)
    return ServiceSpec(**values)


@pytest.fixture(autouse=True)
def _clean_registry():
    clear_registry()
    yield
    clear_registry()


# ── requirements_satisfied ─────────────────────────────────


def test_missing_requirement_reports_missing_config():
    cfg = Config({})
    spec = _spec(requires=("no.such.key",))

    assert requirements_satisfied(spec, cfg) == (
        False,
        "missing_config: no.such.key",
    )


def test_disabled_boolean_requirement_reports_disabled():
    cfg = Config({"moss": {"enabled": False, "python": KERNEL_PYTHON}})
    spec = _spec(requires=("moss.enabled", "moss.python"))

    assert requirements_satisfied(spec, cfg) == (False, "disabled")


@pytest.mark.parametrize(
    ("document", "path"),
    [
        ({"moss": {"python": None}}, "moss.python"),
        ({"moss": {"python": "   "}}, "moss.python"),
        ({"moss": {"models": []}}, "moss.models"),
        ({"moss": {"models": {}}}, "moss.models"),
    ],
)
def test_none_or_empty_requirement_reports_missing_config(
    document: dict[str, Any], path: str
):
    cfg = Config(document)

    assert requirements_satisfied(_spec(requires=(path,)), cfg) == (
        False,
        f"missing_config: {path}",
    )


def test_enable_key_false_with_satisfied_requires_reports_disabled():
    cfg = Config({"moss": {"enabled": False, "python": KERNEL_PYTHON}})
    spec = _spec(requires=("moss.python",), enable_key="moss.enabled")

    assert requirements_satisfied(spec, cfg) == (False, "disabled")


def test_gate_failure_reason_is_propagated():
    cfg = Config({"moss": {"enabled": True, "python": KERNEL_PYTHON}})
    seen: list[Config] = []

    def gate(received: Config) -> tuple[bool, str]:
        seen.append(received)
        return False, "gate_failed: python_missing"

    spec = _spec(requires=("moss.enabled", "moss.python"), gate=gate)

    assert requirements_satisfied(spec, cfg) == (False, "gate_failed: python_missing")
    assert seen == [cfg]


def test_gate_is_not_called_when_requirement_fails():
    cfg = Config({})
    calls: list[Config] = []

    def gate(received: Config) -> tuple[bool, str]:
        calls.append(received)
        return True, ""

    spec = _spec(requires=("no.such.key",), gate=gate)

    assert requirements_satisfied(spec, cfg) == (
        False,
        "missing_config: no.such.key",
    )
    assert calls == []


def test_malformed_gate_result_is_treated_as_failure():
    cfg = Config({"moss": {"enabled": True}})

    def gate(_cfg: Config) -> Any:
        return (True,)

    spec = _spec(requires=("moss.enabled",), gate=gate)

    assert requirements_satisfied(spec, cfg) == (
        False,
        "gate_failed: invalid_result",
    )


def test_all_requirements_satisfied():
    cfg = Config({"moss": {"enabled": True, "python": KERNEL_PYTHON}})
    spec = _spec(requires=("moss.enabled", "moss.python"))

    assert requirements_satisfied(spec, cfg) == (True, "")


# ── 注册表 ─────────────────────────────────────────────────


def test_duplicate_registration_raises_value_error():
    spec = _spec(id="kernel")
    register(spec)

    with pytest.raises(ValueError, match="duplicate service id: kernel"):
        register(_spec(id="kernel"))

    assert REGISTRY["kernel"] is spec
    assert len(REGISTRY) == 1


def test_registry_helpers_read_the_single_source():
    first = _spec(id="alpha")
    second = _spec(id="beta")
    register(first)
    register(second)

    assert get("alpha") is first
    assert get("missing") is None
    assert all_specs() == (first, second)

    clear_registry()

    assert get("alpha") is None
    assert all_specs() == ()


def test_service_spec_is_frozen():
    spec = _spec()

    with pytest.raises(FrozenInstanceError):
        setattr(spec, "id", "other")

    assert spec.id == "demo"
