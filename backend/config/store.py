# -*- coding: utf-8 -*-
"""配置存储编排层（N02）：默认值兜底 + 分层覆盖 + 原子热写 + 应用器 + 外部 watcher。

职责边界：
- 只做加载/合并/校验/落盘编排，不解析具体后端格式（N01 providers 负责）。
- 启动永不因配置缺失/损坏而抛异常：降级到默认值并记录 ``degraded`` 原因。
- 写路径永远只落 base 层；env 覆盖层只读，命中即拒绝（ConfigEnvLocked）。
- 快照发布后不再原地修改，读方拿到的引用是稳定的历史值。

线程模型：save / 重载 / 快照替换在同一把 RLock 下串行；``snapshot()`` 直接返回
当前引用（只读约定），不复制。watcher 线程只负责发现 revision 变化，并把
``apply`` 经 ``asyncio.run_coroutine_threadsafe`` 投递回给定事件循环。
"""

# allow: SIZE_OK - N02 交付面冻结为单文件 store 编排层（拆分需改任务契约）

from __future__ import annotations

import asyncio
import contextlib
import copy
import hashlib
import inspect
import json
import logging
import os
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Final, Iterable, Mapping, NoReturn

from .config_schema import (
    SchemaError,
    defaults_document,
    get_field,
    has_blocking_errors,
    mask_document,
    resolve_apply_strategy,
    validate_changes,
    validate_document,
)
from .paths import project_root
from .providers import (
    ComposedProvider,
    ConfigProvider,
    ProviderError,
    ProviderInfo,
    YamlFileProvider,
    _deep_merge,
    build_provider,
)

REPO_ROOT: Final[Path] = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH: Final[Path] = REPO_ROOT / "config.yaml"
WATCHER_THREAD_NAME: Final[str] = "axeuh-config-watch"
_DRAFT_VERSION: Final[int] = 1
_DRAFT_FILENAME: Final[str] = "config_draft.json"
_MIN_WATCH_INTERVAL_S: Final[float] = 0.01
_STOP_JOIN_TIMEOUT_S: Final[float] = 5.0
_MISSING: Final[object] = object()
_LEGACY_SERVER_PORT_KEYS: Final[tuple[str, str]] = ("http_port", "https_port")
_WARNED_LEGACY_PORT_MIGRATIONS: set[tuple[str, str]] = set()
_LEGACY_PORT_MIGRATION_LOCK: Final[threading.Lock] = threading.Lock()

logger = logging.getLogger(__name__)


# ── 错误类型（code 供 N13 API 直接映射） ───────────────────


class ConfigStoreError(Exception):
    """配置存储层统一异常基类。"""

    code: str
    message: str
    errors: list[SchemaError]

    def __init__(
        self,
        code: str,
        message: str,
        errors: Iterable[SchemaError] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.errors = list(errors) if errors is not None else []


class ConfigValidationError(ConfigStoreError):
    """校验失败：errors 内含全部阻塞错误（可能同时含 warning）。"""

    def __init__(self, errors: Iterable[SchemaError], message: str | None = None) -> None:
        resolved = list(errors)
        super().__init__(
            "validation_failed",
            message if message is not None else f"配置校验失败：{len(resolved)} 项问题",
            resolved,
        )


class ConfigRevisionConflict(ConfigStoreError):
    """乐观并发令牌不匹配。"""

    current_revision: str

    def __init__(self, current_revision: str, message: str | None = None) -> None:
        self.current_revision = current_revision
        super().__init__(
            "revision_conflict",
            message
            if message is not None
            else f"配置 revision 冲突，当前为 {current_revision!r}",
        )


class ConfigReadOnly(ConfigStoreError):
    """provider 声明只读（env 后端 / 只读覆盖层）。"""

    def __init__(self, message: str = "配置后端只读，无法写入") -> None:
        super().__init__("read_only", message)


class ConfigEnvLocked(ConfigStoreError):
    """变更命中 env 覆盖层的叶子路径。"""

    paths: tuple[str, ...]

    def __init__(self, paths: Iterable[str], message: str | None = None) -> None:
        self.paths = tuple(paths)
        errors = [
            SchemaError(path, "env_locked", f"{path} 被环境变量覆盖层锁定")
            for path in self.paths
        ]
        super().__init__(
            "env_locked",
            message
            if message is not None
            else f"环境变量覆盖层锁定以下配置项: {', '.join(self.paths)}",
            errors,
        )


class ConfigWriteError(ConfigStoreError):
    """provider 写入失败（非并发、非只读）。"""

    def __init__(self, message: str) -> None:
        super().__init__("write_failed", message)


# 兼容两种命名习惯的别名；新代码优先用无 Error 后缀的名字。
ConfigReadOnlyError = ConfigReadOnly
ConfigEnvLockedError = ConfigEnvLocked


# ── 变更 / 应用结果 ────────────────────────────────────────


@dataclass(frozen=True)
class ConfigChange:
    old: dict[str, Any]
    new: dict[str, Any]
    changed_paths: tuple[str, ...]


@dataclass
class ApplyReport:
    applied: tuple[str, ...] = ()
    failed: dict[str, str] = field(default_factory=dict)
    deferred_restart: tuple[dict[str, Any], ...] = ()


@dataclass
class ConfigSaveOutcome:
    change: ConfigChange
    revision: str
    warnings: list[SchemaError]
    applied: tuple[str, ...] = ()
    failed: dict[str, str] = field(default_factory=dict)


# ── 通用工具 ───────────────────────────────────────────────


def _error_text(exc: BaseException) -> str:
    detail = str(exc).strip()
    return f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__


_SKIP_APPLIER_STRATEGIES: Final[frozenset[str]] = frozenset(
    {"deployment", "none"}
)


def _filter_executable_change(change: ConfigChange) -> ConfigChange:
    kept = tuple(
        path
        for path in change.changed_paths
        if resolve_apply_strategy(path) not in _SKIP_APPLIER_STRATEGIES
    )
    if kept == change.changed_paths:
        return change
    return ConfigChange(old=change.old, new=change.new, changed_paths=kept)


def _strategy_report_parts(
    result: Any,
) -> tuple[tuple[str, ...], dict[str, str], tuple[dict[str, Any], ...]]:
    if isinstance(result, ApplyReport):
        return (
            result.applied,
            dict(result.failed),
            tuple(result.deferred_restart),
        )
    if isinstance(result, Mapping):
        applied = tuple(str(name) for name in result.get("applied") or ())
        failed_raw = result.get("failed") or {}
        failed = {str(key): str(value) for key, value in failed_raw.items()}
        deferred = tuple(
            dict(entry) for entry in result.get("deferred_restart") or ()
        )
        return applied, failed, deferred
    raise TypeError(f"策略分派器返回了不支持的结果类型: {type(result)!r}")


def _flatten_leaves(document: Mapping[str, Any]) -> dict[str, Any]:
    leaves: dict[str, Any] = {}

    def walk(node: Mapping[str, Any], prefix: str) -> None:
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if isinstance(value, Mapping) and value:
                walk(value, path)
            else:
                leaves[path] = value

    walk(document, "")
    return leaves


def _lookup(document: Mapping[str, Any], path: str, default: Any) -> Any:
    node: Any = document
    for part in path.split("."):
        if not isinstance(node, Mapping) or part not in node:
            return default
        node = node[part]
    return node


def _path_exists(document: Mapping[str, Any], path: str) -> bool:
    return _lookup(document, path, _MISSING) is not _MISSING


def _default_draft_path() -> Path:
    """草稿真源：``<项目根>/backend/data/config_draft.json``。

    ``AXEUH_PROJECT_ROOT``（staging / 测试隔离）经 ``config.paths`` 生效。
    """
    return project_root() / "backend" / "data" / _DRAFT_FILENAME


def _is_masked_sensitive_change(path: str, value: Any) -> bool:
    """与 save() 同口径：敏感字段的遮罩/空值不是一次真实写入。"""
    field = get_field(path)
    return bool(
        field is not None
        and field.sensitive
        and (value is None or value == "" or value == "***")
    )


def _draft_revision(
    changes: Mapping[str, Any], clear_keys: Iterable[str]
) -> str:
    """staged 内容的稳定指纹；内容不变则 revision 不变。"""
    payload = {
        "changes": dict(changes),
        "clear": sorted(str(path) for path in clear_keys),
    }
    digest = hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
    ).hexdigest()
    return f"draft-{digest[:16]}"


def _fsync_directory(path: Path) -> None:
    """目录 fsync（POSIX 原子替换的 durability 补充）；不可用时静默跳过。"""
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write_draft(path: Path, payload: bytes) -> None:
    """与 providers 同款的 mkstemp + fsync + os.replace；权限恒为 0600。"""
    if path.is_symlink():
        raise ConfigWriteError(f"拒绝通过符号链接写配置草稿: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, path)
        _fsync_directory(path.parent)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp_path.unlink()
        raise


def _tls_files_ready(ssl_section: Mapping[str, Any]) -> bool:
    cert = str(ssl_section.get("cert") or "").strip()
    key = str(ssl_section.get("key") or "").strip()
    if not cert or not key:
        return False

    def _is_file(raw: str) -> bool:
        path = Path(raw)
        if not path.is_absolute():
            path = REPO_ROOT / path
        return path.is_file()

    return _is_file(cert) and _is_file(key)


def _migrate_legacy_server_ports(document: dict[str, Any]) -> None:
    """把旧双端口配置折算为单一 server.port（内存内迁移，幂等）。"""
    server = document.get("server")
    if not isinstance(server, dict):
        return
    if server.get("port") is not None:
        return
    present = [name for name in _LEGACY_SERVER_PORT_KEYS if name in server]
    if not present:
        return
    if len(present) == 2:
        ssl_section = document.get("ssl")
        ssl_enabled = (
            isinstance(ssl_section, Mapping)
            and ssl_section.get("enabled") is True
        )
        source = (
            "https_port"
            if ssl_enabled
            and isinstance(ssl_section, Mapping)
            and _tls_files_ready(ssl_section)
            else "http_port"
        )
    else:
        source = present[0]
    value = server[source]
    server["port"] = value
    outcome = (source, repr(value))
    with _LEGACY_PORT_MIGRATION_LOCK:
        first_warning = outcome not in _WARNED_LEGACY_PORT_MIGRATIONS
        if first_warning:
            _WARNED_LEGACY_PORT_MIGRATIONS.add(outcome)
    if not first_warning:
        logger.debug(
            "[ConfigStore] legacy server ports already migrated: server.%s=%r",
            source,
            value,
        )
        return
    logger.warning(
        "[ConfigStore] migrated legacy server ports: chose server.%s=%r -> server.port",
        source,
        value,
    )


def _normalize_changes(changes: Mapping[str, Any]) -> dict[str, Any]:
    """把嵌套字典便利写法展开为点分路径；点分键原样保留。

    schema 的所有叶子都是标量/列表，因此“已知路径配 mapping 值”只可能是类型
    错误，保留给 validate_changes 报 type_mismatch；未知路径配 mapping 才展开。
    """
    normalized: dict[str, Any] = {}
    for path, value in changes.items():
        key = str(path)
        if isinstance(value, Mapping) and get_field(key) is None:
            normalized.update(_flatten_leaves({key: value}))
        else:
            normalized[key] = value
    return normalized


def _values_differ(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is not type(right) or left != right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left != right
    return left != right


_SECTION_NAMES: Final[tuple[str, ...]] = (
    "server",
    "ssl",
    "opencode",
    "loom",
    "data",
    "models",
    "api",
    "health",
    "audio",
    "tts",
    "qq_gateway",
    "p2p",
    "kernel",
    "launcher",
    "pc_sensor",
    "features",
    "scripts",
    "ota",
    "unknown_speaker",
    "audio_compressor",
    "voiceprint",
    "memory",
    "agent",
    "auth",
    "log",
    "sandbox",
)


def _sanitize_section_types(
    document: dict[str, Any],
) -> tuple[list[SchemaError], list[str]]:
    """顶层已知节必须是映射；标量/null 就按空节处理，避免所有属性读取崩溃。"""
    warnings: list[SchemaError] = []
    reasons: list[str] = []
    for name in _SECTION_NAMES:
        if name not in document:
            continue
        value = document[name]
        if isinstance(value, dict):
            continue
        document[name] = {}
        reasons.append(f"invalid_section: {name}")
        warnings.append(
            SchemaError(
                name,
                "type_mismatch",
                f"{name} 配置节必须是映射，已按空节降级",
                "warning",
            )
        )
    return warnings, reasons


class ConfigStore:
    """进程内配置快照 + 热写编排 + 应用器 + 外部变更 watcher。"""

    def __init__(
        self,
        provider: ConfigProvider | None = None,
        *,
        watcher_interval_s: float = 2.0,
        draft_path: str | os.PathLike[str] | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self._static_degraded: list[str] = []
        self._load_degraded: list[str] = []
        self._external_degraded: list[str] = []
        self._section_degraded: list[str] = []
        self._warnings: list[SchemaError] = []
        self._appliers: dict[str, Callable[[ConfigChange], Awaitable[Any] | Any]] = {}
        self._strategy_dispatcher: (
            Callable[[ConfigChange], Awaitable[Any] | Any] | None
        ) = None
        self._apply_failures: dict[str, str] = {}
        self._watcher_event: threading.Event | None = None
        self._watcher_thread: threading.Thread | None = None
        self._watcher_interval_s = max(
            float(watcher_interval_s), _MIN_WATCH_INTERVAL_S
        )
        self._draft_path = (
            Path(draft_path).expanduser()
            if draft_path is not None
            else _default_draft_path()
        )
        self._staged_doc: dict[str, Any] | None = None
        self._staged_clear_keys: list[str] = []
        self._staged_revision: str | None = None
        self._preview_snapshot: dict[str, Any] | None = None
        self._preview_published: dict[str, Any] | None = None

        resolved = provider if provider is not None else self._build_provider()
        self._provider = resolved
        if isinstance(resolved, ComposedProvider):
            self._base = resolved.base
            self._overlay = resolved.overlay
        else:
            self._base = resolved
            self._overlay = None

        self._base_doc: dict[str, Any] = {}
        self._overlay_doc: dict[str, Any] = {}
        self._snapshot: dict[str, Any] = {}
        self._defaults_doc = self._load_defaults()
        self._load_initial_layers()
        self._last_seen_revision = self._safe_revision()
        self._restore_draft()

    # ── 启动加载 ──────────────────────────────────────────

    def _build_provider(self) -> ConfigProvider:
        try:
            return build_provider()
        except Exception as exc:
            self._remember_static_degraded(
                f"provider_build_failed: {_error_text(exc)}"
            )
            return YamlFileProvider(DEFAULT_CONFIG_PATH)

    def _load_defaults(self) -> dict[str, Any]:
        try:
            document = defaults_document()
            if not isinstance(document, dict):
                raise TypeError("defaults_document() 必须返回映射")
            return copy.deepcopy(document)
        except Exception as exc:
            self._remember_static_degraded(
                f"defaults_unavailable: {_error_text(exc)}"
            )
            return {}

    def _load_initial_layers(self) -> None:
        base_doc, base_error = self._safe_load(self._base)
        overlay_doc: dict[str, Any] = {}
        overlay_error: str | None = None
        if self._overlay is not None:
            overlay_doc, overlay_error = self._safe_load(self._overlay)

        reasons: list[str] = []
        if base_error is not None:
            reasons.append(f"base_load_failed: {base_error}")
        else:
            reasons.extend(self._missing_or_empty_reasons(base_doc))
        if overlay_error is not None:
            reasons.append(f"overlay_load_failed: {overlay_error}")

        self._base_doc = base_doc
        self._overlay_doc = overlay_doc
        self._load_degraded = reasons
        self._publish_locked()

    def _safe_load(self, provider: ConfigProvider) -> tuple[dict[str, Any], str | None]:
        try:
            document = provider.load()
            if not isinstance(document, dict):
                raise ProviderError(
                    "settings document must be a mapping, "
                    f"got {type(document).__name__}"
                )
            result = copy.deepcopy(document)
            _migrate_legacy_server_ports(result)
            return result, None
        except Exception as exc:
            return {}, _error_text(exc)

    @staticmethod
    def _load_strict(provider: ConfigProvider) -> dict[str, Any]:
        document = provider.load()
        if not isinstance(document, dict):
            raise ProviderError(
                "settings document must be a mapping, "
                f"got {type(document).__name__}"
            )
        result = copy.deepcopy(document)
        _migrate_legacy_server_ports(result)
        return result

    def _missing_or_empty_reasons(
        self, document: Mapping[str, Any]
    ) -> list[str]:
        if document:
            return []
        try:
            revision = self._base.revision()
        except Exception:
            return []
        if revision == "missing":
            return ["config_missing"]
        if revision == "memory":
            return []
        try:
            info = self._base.describe()
        except Exception:
            info = None
        if info is not None and info.kind == "env":
            return []
        return ["config_empty"]

    # ── 快照发布 ──────────────────────────────────────────

    def _remember_static_degraded(self, reason: str) -> None:
        if reason not in self._static_degraded:
            self._static_degraded.append(reason)

    def _commit_layers_locked(
        self,
        base_doc: dict[str, Any],
        overlay_doc: dict[str, Any],
    ) -> dict[str, Any]:
        effective = _deep_merge(self._defaults_doc, base_doc)
        if overlay_doc:
            effective = _deep_merge(effective, overlay_doc)
        section_warnings, section_reasons = _sanitize_section_types(effective)
        warnings = [*section_warnings, *self._validate_document_safe(effective)]
        # 先完成所有可能抛异常的步骤，再一次性替换引用，避免半发布。
        snapshot = copy.deepcopy(effective)
        self._base_doc = base_doc
        self._overlay_doc = overlay_doc
        self._warnings = warnings
        self._section_degraded = section_reasons
        self._snapshot = snapshot
        return snapshot

    def _publish_locked(self) -> dict[str, Any]:
        return self._commit_layers_locked(self._base_doc, self._overlay_doc)

    def _validate_document_safe(
        self, document: Mapping[str, Any]
    ) -> list[SchemaError]:
        try:
            return validate_document(document, project_root=REPO_ROOT, strict=False)
        except Exception as exc:
            self._remember_static_degraded(
                f"validation_unavailable: {_error_text(exc)}"
            )
            return []

    # ── 只读视图 ──────────────────────────────────────────

    @property
    def degraded(self) -> list[str]:
        with self._lock:
            reasons: list[str] = []
            seen: set[str] = set()
            for reason in (
                *self._static_degraded,
                *self._load_degraded,
                *self._external_degraded,
                *self._section_degraded,
            ):
                if reason in seen:
                    continue
                seen.add(reason)
                reasons.append(reason)
            return reasons

    @property
    def warnings(self) -> list[SchemaError]:
        with self._lock:
            return list(self._warnings)

    @property
    def revision(self) -> str:
        return self._safe_revision()

    @property
    def base_revision(self) -> str:
        return self._safe_base_revision()

    def is_degraded(self) -> bool:
        return bool(self.degraded)

    def degraded_reasons(self) -> list[str]:
        return self.degraded

    def provider_info(self) -> ProviderInfo:
        try:
            return self._provider.describe()
        except Exception as exc:
            return ProviderInfo(
                kind="unknown",
                location="unknown",
                writable=False,
                detail=f"describe_failed: {_error_text(exc)}",
            )

    @property
    def provider(self) -> ConfigProvider:
        """底层 provider（组合对象含 overlay）；只读诊断/集成用。"""
        return self._provider

    @property
    def draft_path(self) -> Path:
        """草稿文件路径（只读诊断/测试断言用）。"""
        return self._draft_path

    @property
    def staged_revision(self) -> str | None:
        """当前 staged 内容指纹；无草稿时为 None。"""
        with self._lock:
            return self._staged_revision

    @property
    def applier_names(self) -> tuple[str, ...]:
        """已注册应用器名称（启动校验只读探针用）。"""
        with self._lock:
            return tuple(self._appliers)

    @property
    def watcher_running(self) -> bool:
        """外部配置 watcher 线程是否存活（启动校验只读探针用）。"""
        with self._lock:
            thread = self._watcher_thread
            return bool(thread is not None and thread.is_alive())

    def snapshot(self) -> dict[str, Any]:
        return self._snapshot

    def base_document(self) -> dict[str, Any]:
        return copy.deepcopy(self._base_doc)

    def overlay_document(self) -> dict[str, Any]:
        return copy.deepcopy(self._overlay_doc)

    def get(self, path: str, default: Any = None) -> Any:
        return _lookup(self._snapshot, path, default)

    def masked_config(self) -> dict[str, Any]:
        return mask_document(self._snapshot)

    @staticmethod
    def changed_paths(
        old: Mapping[str, Any], new: Mapping[str, Any]
    ) -> tuple[str, ...]:
        old_leaves = _flatten_leaves(old)
        new_leaves = _flatten_leaves(new)
        changed: list[str] = []
        for path in set(old_leaves) | set(new_leaves):
            if path not in old_leaves or path not in new_leaves:
                changed.append(path)
            elif _values_differ(old_leaves[path], new_leaves[path]):
                changed.append(path)
        return tuple(sorted(changed))

    def _safe_revision(self) -> str:
        try:
            return self._provider.revision()
        except Exception:
            return "unknown"

    def _safe_base_revision(self) -> str:
        try:
            return self._base.revision()
        except Exception:
            return "unknown"

    # ── 热写 ──────────────────────────────────────────────

    def save(
        self,
        changes: dict[str, Any],
        clear_keys: list[str] | None = None,
        *,
        expected_revision: str | None = None,
    ) -> ConfigSaveOutcome:
        """把点分路径变更合并进 base 层并热发布；不触碰 env 覆盖值。

        ``changes`` 形如 ``{"server.port": 8768}``；嵌套字典会自动展开为
        点分叶子。``clear_keys`` 为要删除的点分路径。校验、env 锁与 revision
        冲突都在写入前完成，失败不落盘。
        """
        info = self.provider_info()
        if not info.writable:
            raise ConfigReadOnly(
                f"配置后端只读，无法写入（{info.kind}: {info.location}）"
            )

        with self._lock:
            normalized_changes = _normalize_changes(changes)
            locked = self._env_locked_paths(
                tuple(normalized_changes), tuple(clear_keys or ())
            )
            if locked:
                raise ConfigEnvLocked(locked)

            merged, errors = validate_changes(
                copy.deepcopy(self._base_doc),
                normalized_changes,
                list(clear_keys) if clear_keys else None,
                project_root=REPO_ROOT,
                strict=False,
            )
            if has_blocking_errors(errors):
                raise ConfigValidationError(errors)

            current_revision = self._safe_revision()
            if (
                expected_revision is not None
                and expected_revision != current_revision
            ):
                raise ConfigRevisionConflict(current_revision)

            try:
                self._base.save(
                    copy.deepcopy(merged),
                    expected_revision=self._safe_base_revision(),
                )
            except ProviderError as exc:
                self._raise_save_error(exc)
            except OSError as exc:
                raise ConfigWriteError(_error_text(exc)) from exc

            overlay_doc = self._overlay_doc
            overlay_error: str | None = None
            if self._overlay is not None:
                try:
                    overlay_doc = self._load_strict(self._overlay)
                except Exception as exc:
                    overlay_error = f"overlay_load_failed: {_error_text(exc)}"

            load_degraded = self._missing_or_empty_reasons(merged)
            if overlay_error is not None:
                load_degraded.append(overlay_error)

            self._load_degraded = load_degraded
            self._external_degraded = []
            old_snapshot = self._snapshot
            new_snapshot = self._commit_layers_locked(merged, overlay_doc)
            revision = self._safe_revision()
            self._last_seen_revision = revision
            return ConfigSaveOutcome(
                change=ConfigChange(
                    old_snapshot,
                    new_snapshot,
                    self.changed_paths(old_snapshot, new_snapshot),
                ),
                revision=revision,
                warnings=list(self._warnings),
            )

    def _raise_save_error(self, exc: ProviderError) -> NoReturn:
        detail = str(exc).lower()
        if "stale" in detail or "revision" in detail:
            raise ConfigRevisionConflict(self._safe_revision()) from exc
        if "read-only" in detail or "readonly" in detail:
            raise ConfigReadOnly(str(exc)) from exc
        raise ConfigWriteError(_error_text(exc)) from exc

    def _env_locked_paths(
        self,
        change_paths: Iterable[str],
        clear_paths: Iterable[str],
    ) -> tuple[str, ...]:
        overlay_leaves = _flatten_leaves(self._overlay_doc)
        if not overlay_leaves:
            return ()
        locked: list[str] = []
        for path in (*change_paths, *clear_paths):
            if any(
                path == leaf or path.startswith(f"{leaf}.")
                for leaf in overlay_leaves
            ) and path not in locked:
                locked.append(path)
        return tuple(locked)

    # ── 草稿层（staged / committed 分离） ──────────────────

    def _draft_payload_locked(
        self,
        changes: Mapping[str, Any],
        clear_keys: Iterable[str],
        revision: str | None,
    ) -> dict[str, Any]:
        return {
            "version": _DRAFT_VERSION,
            "staged_revision": revision,
            "staged": copy.deepcopy(dict(changes)),
            "clear": list(clear_keys),
            "base_revision": self._safe_base_revision(),
        }

    def _persist_staged_locked(
        self,
        changes: Mapping[str, Any],
        clear_keys: Iterable[str],
        revision: str | None,
    ) -> None:
        """草稿文件是 staged 的持久真源；空 staged 等价于删除文件。"""
        clear_list = list(clear_keys)
        if not changes and not clear_list:
            try:
                self._draft_path.unlink()
            except FileNotFoundError:
                return
            except OSError as exc:
                raise ConfigWriteError(_error_text(exc)) from exc
            _fsync_directory(self._draft_path.parent)
            return
        payload = self._draft_payload_locked(changes, clear_list, revision)
        try:
            data = json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                indent=2,
                default=str,
            ).encode("utf-8")
            _atomic_write_draft(self._draft_path, data)
        except ConfigWriteError:
            raise
        except OSError as exc:
            raise ConfigWriteError(_error_text(exc)) from exc

    def _prune_staged_locked(
        self,
        changes: Mapping[str, Any],
        clear_keys: Iterable[str],
    ) -> tuple[dict[str, Any], list[str]]:
        """丢弃已被提交或已无意义的残留（崩溃在 save 与草稿清理之间时自愈）。"""
        pruned_changes = {
            path: copy.deepcopy(value)
            for path, value in changes.items()
            if not _is_masked_sensitive_change(path, value)
            and _values_differ(_lookup(self._snapshot, path, None), value)
        }
        pruned_clears = [
            path for path in clear_keys if _path_exists(self._base_doc, path)
        ]
        return pruned_changes, pruned_clears

    def _restore_draft(self) -> None:
        """启动时恢复草稿；损坏/失效文件只告警，绝不影响启动。"""
        path = self._draft_path
        with self._lock:
            try:
                raw = path.read_text(encoding="utf-8")
            except FileNotFoundError:
                return
            except OSError as exc:
                logger.warning(
                    "[ConfigStore] 无法读取配置草稿 %s，已忽略: %s",
                    path,
                    _error_text(exc),
                )
                return
            try:
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise ValueError("草稿根节点必须是 JSON 对象")
                version = payload.get("version", _DRAFT_VERSION)
                if version != _DRAFT_VERSION:
                    raise ValueError(f"不支持的草稿版本: {version!r}")
                staged_raw = payload.get("staged", {})
                if not isinstance(staged_raw, dict):
                    raise ValueError("staged 必须是 JSON 对象")
                clear_raw = payload.get("clear", [])
                if not isinstance(clear_raw, list) or not all(
                    isinstance(item, str) for item in clear_raw
                ):
                    raise ValueError("clear 必须是字符串数组")
                changes = copy.deepcopy(_normalize_changes(staged_raw))
                clear_keys = [str(item) for item in clear_raw]
                changes, clear_keys = self._prune_staged_locked(
                    changes, clear_keys
                )
                _merged, errors = validate_changes(
                    copy.deepcopy(self._base_doc),
                    changes,
                    clear_keys or None,
                    project_root=REPO_ROOT,
                    strict=False,
                )
                if has_blocking_errors(errors):
                    detail = "；".join(
                        f"{error.path}: {error.message}"
                        for error in errors
                        if error.severity == "error"
                    )
                    raise ValueError(f"草稿校验失败: {detail}")
            except Exception as exc:
                logger.warning(
                    "[ConfigStore] 配置草稿 %s 损坏或已失效，已忽略: %s",
                    path,
                    _error_text(exc),
                )
                return

            revision_raw = payload.get("staged_revision")
            revision = (
                revision_raw
                if isinstance(revision_raw, str) and revision_raw
                else None
            )
            if changes or clear_keys:
                if revision is None:
                    revision = _draft_revision(changes, clear_keys)
            else:
                revision = None
            self._staged_doc = changes or None
            self._staged_clear_keys = clear_keys
            self._staged_revision = revision
            if (
                changes != staged_raw
                or clear_keys != clear_raw
                or revision != revision_raw
            ):
                try:
                    self._persist_staged_locked(changes, clear_keys, revision)
                except ConfigWriteError as exc:
                    logger.warning(
                        "[ConfigStore] 草稿残留修剪未能回写 %s: %s",
                        path,
                        exc,
                    )

    def stage(
        self,
        changes: Mapping[str, Any],
        clear_keys: Iterable[str] | None = None,
    ) -> dict[str, Any]:
        """把变更写入草稿；不写 config.yaml、不发布快照、不触发 applier/watcher。

        校验与 ``save()`` 同口径（provider 可写、env lock、schema/交叉字段），
        任一失败都不改变既有草稿。返回合并后的 staged diff。
        """
        info = self.provider_info()
        if not info.writable:
            raise ConfigReadOnly(
                f"配置后端只读，无法写入（{info.kind}: {info.location}）"
            )

        with self._lock:
            normalized = copy.deepcopy(_normalize_changes(dict(changes)))
            clears = [str(path) for path in (clear_keys or ())]
            merged_changes = copy.deepcopy(self._staged_doc or {})
            merged_clears = list(self._staged_clear_keys)
            for path, value in normalized.items():
                merged_changes[path] = value
                if path in merged_clears:
                    merged_clears.remove(path)
            for path in clears:
                merged_changes.pop(path, None)
                if path not in merged_clears:
                    merged_clears.append(path)

            locked = self._env_locked_paths(
                tuple(normalized), tuple(clears)
            )
            if locked:
                raise ConfigEnvLocked(locked)

            _merged, errors = validate_changes(
                copy.deepcopy(self._base_doc),
                merged_changes,
                merged_clears or None,
                project_root=REPO_ROOT,
                strict=False,
            )
            if has_blocking_errors(errors):
                raise ConfigValidationError(errors)

            merged_changes, merged_clears = self._prune_staged_locked(
                merged_changes, merged_clears
            )
            revision = (
                _draft_revision(merged_changes, merged_clears)
                if merged_changes or merged_clears
                else None
            )
            self._persist_staged_locked(merged_changes, merged_clears, revision)
            self._staged_doc = merged_changes or None
            self._staged_clear_keys = merged_clears
            self._staged_revision = revision
            return self._pending_locked()

    def pending(self) -> dict[str, Any]:
        """staged 相对 committed 快照的差异：``{path: {from, to}}``。

        删除（clear）以 ``to: None`` 表达；与快照相同的 staged 值视为 no-op。
        """
        with self._lock:
            return self._pending_locked()

    def _pending_locked(self) -> dict[str, Any]:
        staged = self._staged_doc or {}
        clears = set(self._staged_clear_keys)
        diff: dict[str, Any] = {}
        for path in sorted(set(staged) | clears):
            from_value = _lookup(self._snapshot, path, None)
            if path in clears:
                if from_value is None and not _path_exists(self._base_doc, path):
                    continue
                diff[path] = {
                    "from": copy.deepcopy(from_value),
                    "to": None,
                }
                continue
            to_value = staged[path]
            if not _values_differ(from_value, to_value):
                continue
            diff[path] = {
                "from": copy.deepcopy(from_value),
                "to": copy.deepcopy(to_value),
            }
        return diff

    def discard(self) -> None:
        """清空内存草稿并删除草稿文件；幂等。"""
        with self._lock:
            self._persist_staged_locked({}, (), None)
            self._staged_doc = None
            self._staged_clear_keys = []
            self._staged_revision = None

    # ── 应用事务的内存预览 ────────────────────────────────

    @property
    def previewing(self) -> bool:
        """是否处于 ``begin_preview()`` 打开的事务预览窗口内。"""
        with self._lock:
            return self._preview_published is not None

    def begin_preview(self, paths: Iterable[str] | None = None) -> None:
        """把草稿子集发布成一次性内存快照，供 apply 事务执行期读取新值。

        只替换 ``_snapshot``：不写 config.yaml、不改已提交 base、不推进
        watcher revision。``paths`` 为空时预览整份草稿；否则只合入该子集
        （clear 语义一并带出）。调用方必须在 ``finally`` 里 ``end_preview()``。
        """
        with self._lock:
            if self._preview_published is not None:
                raise RuntimeError("配置预览已在进行中，拒绝嵌套 begin_preview")
            staged = copy.deepcopy(self._staged_doc or {})
            clears = list(self._staged_clear_keys)
            if paths is not None:
                requested = {str(path) for path in paths}
                staged = {
                    path: value
                    for path, value in staged.items()
                    if path in requested
                }
                clears = [path for path in clears if path in requested]
            merged, errors = validate_changes(
                copy.deepcopy(self._base_doc),
                staged,
                clears or None,
                project_root=REPO_ROOT,
                strict=False,
            )
            if has_blocking_errors(errors):
                raise ConfigValidationError(errors)
            effective = _deep_merge(self._defaults_doc, merged)
            if self._overlay_doc:
                effective = _deep_merge(effective, self._overlay_doc)
            _sanitize_section_types(effective)
            preview = copy.deepcopy(effective)
            self._preview_snapshot = self._snapshot
            self._preview_published = preview
            self._snapshot = preview

    def end_preview(self) -> None:
        """结束 ``begin_preview()`` 并恢复已提交快照；幂等。

        若预览窗口内已有别的快照发布（并发 save 或外部 watcher），保留那个
        更新的快照，避免一次事务收尾把别人的提交回滚掉。
        """
        with self._lock:
            published = self._preview_published
            previous = self._preview_snapshot
            self._preview_published = None
            self._preview_snapshot = None
            if published is not None and self._snapshot is published:
                self._snapshot = (
                    previous if previous is not None else self._snapshot
                )

    def commit(self, paths: list[str] | None = None) -> ConfigSaveOutcome:
        """把草稿经既有 ``save()`` 落盘。

        ``paths is None``：提交整份草稿；否则只提交该子集，其余键留在草稿里
        （任务 6 的部分失败重试依赖此语义）。提交失败的路径不落盘、草稿不动。
        """
        with self._lock:
            staged = copy.deepcopy(self._staged_doc or {})
            clears = list(self._staged_clear_keys)
            if paths is None:
                selected = set(staged) | set(clears)
            else:
                requested = {str(path) for path in paths}
                selected = {
                    path for path in staged if path in requested
                } | {path for path in clears if path in requested}

            if not selected:
                pruned_changes, pruned_clears = self._prune_staged_locked(
                    staged, clears
                )
                if pruned_changes != staged or pruned_clears != clears:
                    revision = (
                        _draft_revision(pruned_changes, pruned_clears)
                        if pruned_changes or pruned_clears
                        else None
                    )
                    try:
                        self._persist_staged_locked(
                            pruned_changes, pruned_clears, revision
                        )
                    except ConfigWriteError as exc:
                        logger.warning(
                            "[ConfigStore] 草稿 no-op 残留清理失败: %s",
                            exc,
                        )
                    self._staged_doc = pruned_changes or None
                    self._staged_clear_keys = pruned_clears
                    self._staged_revision = revision
                return ConfigSaveOutcome(
                    change=ConfigChange(self._snapshot, self._snapshot, ()),
                    revision=self._safe_revision(),
                    warnings=list(self._warnings),
                )

            selected_changes = {
                path: staged[path] for path in staged if path in selected
            }
            selected_clears = [
                path for path in clears if path in selected
            ]
            outcome = self.save(selected_changes, selected_clears or None)

            remaining_changes = {
                path: value
                for path, value in staged.items()
                if path not in selected
            }
            remaining_clears = [
                path for path in clears if path not in selected
            ]
            remaining_changes, remaining_clears = (
                self._prune_staged_locked(
                    remaining_changes, remaining_clears
                )
            )
            revision = (
                _draft_revision(remaining_changes, remaining_clears)
                if remaining_changes or remaining_clears
                else None
            )
            try:
                self._persist_staged_locked(
                    remaining_changes, remaining_clears, revision
                )
            except ConfigWriteError as exc:
                # config.yaml 已是权威落盘结果；草稿文件清理失败时保留内存态，
                # 下次启动会按已提交快照自动修剪残留。
                logger.warning(
                    "[ConfigStore] 配置已提交但草稿清理失败（重启时会自动修剪）: %s",
                    exc,
                )
            self._staged_doc = remaining_changes or None
            self._staged_clear_keys = remaining_clears
            self._staged_revision = revision
            return outcome

    # ── 应用器 ────────────────────────────────────────────

    def register_applier(
        self,
        name: str,
        fn: Callable[[ConfigChange], Awaitable[Any] | Any],
        *,
        replace: bool = False,
    ) -> None:
        with self._lock:
            if not replace and name in self._appliers:
                raise ValueError(f"applier 已注册: {name}")
            self._appliers[name] = fn

    def register_strategy_dispatcher(
        self, fn: Callable[[ConfigChange], Awaitable[Any] | Any]
    ) -> None:
        with self._lock:
            self._strategy_dispatcher = fn

    async def apply(self, change: ConfigChange) -> ApplyReport:
        with self._lock:
            appliers = list(self._appliers.items())
            dispatcher = self._strategy_dispatcher

        applier_change = _filter_executable_change(change)
        applied: list[str] = []
        failed: dict[str, str] = {}
        deferred: list[dict[str, Any]] = []
        for name, fn in appliers:
            try:
                result = fn(applier_change)
                if inspect.isawaitable(result):
                    await result
            except Exception as exc:
                failed[name] = _error_text(exc)
                continue
            applied.append(name)

        if dispatcher is not None:
            try:
                strategy_result = dispatcher(change)
                if inspect.isawaitable(strategy_result):
                    strategy_result = await strategy_result
            except Exception as exc:
                failed["strategy_dispatch"] = _error_text(exc)
            else:
                (
                    strategy_applied,
                    strategy_failed,
                    strategy_deferred,
                ) = _strategy_report_parts(strategy_result)
                for name in strategy_applied:
                    if name not in applied:
                        applied.append(name)
                failed.update(strategy_failed)
                deferred.extend(strategy_deferred)

        with self._lock:
            self._apply_failures = dict(failed)
        return ApplyReport(
            applied=tuple(applied),
            failed=failed,
            deferred_restart=tuple(deferred),
        )

    @property
    def apply_failures(self) -> dict[str, str]:
        with self._lock:
            return dict(self._apply_failures)

    # ── 外部 watcher ──────────────────────────────────────

    def start_watcher(
        self,
        loop: asyncio.AbstractEventLoop,
        interval_s: float | None = None,
    ) -> None:
        with self._lock:
            if (
                self._watcher_thread is not None
                and self._watcher_thread.is_alive()
            ):
                return
            event = threading.Event()
            thread = threading.Thread(
                target=self._watch_loop,
                args=(loop, interval_s, event),
                name=WATCHER_THREAD_NAME,
                daemon=True,
            )
            self._watcher_event = event
            self._watcher_thread = thread
            thread.start()

    def stop_watcher(self) -> None:
        with self._lock:
            event = self._watcher_event
            thread = self._watcher_thread
            self._watcher_event = None
            self._watcher_thread = None
        if event is not None:
            event.set()
        if thread is None or thread is threading.current_thread():
            return
        thread.join(timeout=_STOP_JOIN_TIMEOUT_S)
        if thread.is_alive():
            # 线程卡在不可中断 IO 时保留引用，后续 start 不会叠出第二条线程。
            with self._lock:
                if self._watcher_thread is None:
                    self._watcher_thread = thread

    def _watch_loop(
        self,
        loop: asyncio.AbstractEventLoop,
        interval_s: float | None,
        event: threading.Event,
    ) -> None:
        interval = (
            self._watcher_interval_s
            if interval_s is None
            else max(float(interval_s), _MIN_WATCH_INTERVAL_S)
        )
        while not event.wait(interval):
            change = self._poll_external_change()
            if change is None or not change.changed_paths:
                continue
            try:
                asyncio.run_coroutine_threadsafe(self.apply(change), loop)
            except Exception as exc:
                self._set_external_degraded(
                    [f"external_apply_failed: {_error_text(exc)}"]
                )

    def _poll_external_change(self) -> ConfigChange | None:
        with self._lock:
            try:
                revision = self._provider.revision()
            except Exception as exc:
                self._set_external_degraded(
                    [f"external_revision_failed: {_error_text(exc)}"]
                )
                return None
            if revision == self._last_seen_revision:
                return None
            try:
                base_doc = self._load_strict(self._base)
                overlay_doc = (
                    self._load_strict(self._overlay)
                    if self._overlay is not None
                    else {}
                )
                load_degraded = self._missing_or_empty_reasons(base_doc)
                old_snapshot = self._snapshot
                new_snapshot = self._commit_layers_locked(base_doc, overlay_doc)
                self._load_degraded = load_degraded
                self._external_degraded = []
                self._last_seen_revision = revision
                return ConfigChange(
                    old_snapshot,
                    new_snapshot,
                    self.changed_paths(old_snapshot, new_snapshot),
                )
            except Exception as exc:
                # 读失败绝不把快照替换成默认值，也不推进 last_seen，下一轮重试。
                self._set_external_degraded(
                    [f"external_reload_failed: {_error_text(exc)}"]
                )
                return None

    def _set_external_degraded(self, reasons: list[str]) -> None:
        with self._lock:
            self._external_degraded = list(reasons)


# ── 进程级单例 ─────────────────────────────────────────────


_STORE_LOCK = threading.Lock()
_STORE: ConfigStore | None = None


def get_config_store() -> ConfigStore:
    global _STORE
    with _STORE_LOCK:
        if _STORE is None:
            _STORE = ConfigStore()
        return _STORE


def reset_config_store(provider: ConfigProvider | None = None) -> ConfigStore:
    """测试/重启用：先停旧 watcher，再替换进程级单例。"""
    global _STORE
    with _STORE_LOCK:
        if _STORE is not None:
            _STORE.stop_watcher()
        _STORE = ConfigStore(provider)
        return _STORE


def is_degraded() -> bool:
    return get_config_store().is_degraded()


def degraded_reasons() -> list[str]:
    return get_config_store().degraded_reasons()
