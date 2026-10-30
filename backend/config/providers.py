# -*- coding: utf-8 -*-
"""可插拔配置存储层（N01）：YAML / JSON / SQLite 持久化 + env 只读覆盖层。

所有持久化 provider 共用同一套写入纪律：先比对 revision，序列化后备份旧文件，
再经同目录唯一临时文件 fsync + chmod 0600 + os.replace 原子替换。
revision 是乐观并发令牌：文件取 mtime/size/内容摘要，SQLite 取自增整数。

已知限制：
- SQLite 用 "." 拼接叶路径重建嵌套字典，键名本身不允许包含 "."；
- env 覆盖层只读，且只认 ``AXEUH_SETTINGS__`` 前缀（``__`` 为层级分隔符）；
- 非 POSIX 平台跳过 fcntl.flock，仅保留进程内 RLock。
"""

# allow: SIZE_OK - N01 交付面冻结为单文件 provider 层（拆分需改任务契约）

from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, Protocol

import yaml

if os.name == "posix":
    import fcntl
else:
    fcntl = None

DEFAULT_ENV_PREFIX = "AXEUH_SETTINGS__"
PROVIDER_ENV_KEYS: tuple[str, ...] = (
    "AXEUH_CONFIG_BACKEND",
    "AXEUH_CONFIG_PATH",
    "AXEUH_CONFIG_SQLITE_PATH",
)
_VALID_BACKENDS = ("yaml", "json", "sqlite", "env")
_LOCK_TIMEOUT_S = 5.0
_LOCK_POLL_S = 0.02
_SQLITE_TIMEOUT_S = 10.0
_SCHEMA_VERSION = "1"
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_CONFIG_PATH = _REPO_ROOT / "config.yaml"
_DEFAULT_SQLITE_PATH = _REPO_ROOT / "backend" / "data" / "settings.db"


class ProviderError(Exception):
    """配置存储层统一异常（读取、校验、并发、写入失败）。"""


@dataclass(frozen=True)
class ProviderInfo:
    """provider 自述信息：后端类型、绝对位置、是否可写。"""

    kind: str
    location: str
    writable: bool
    detail: str = ""


class ConfigProvider(Protocol):
    """配置后端最小契约。"""

    def load(self) -> dict[str, Any]: ...

    def save(
        self, document: dict[str, Any], *, expected_revision: str | None = None
    ) -> str: ...

    def revision(self) -> str: ...

    def describe(self) -> ProviderInfo: ...


# ── 通用工具 ────────────────────────────────────────────────


def _require_mapping(document: Any, *, source: str) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ProviderError(
            f"{source} settings document must be a mapping, got {type(document).__name__}"
        )
    return document


def _deep_merge(base: Mapping[str, Any], overlay: Mapping[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(dict(base))
    for key, value in overlay.items():
        current = merged.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            merged[key] = _deep_merge(current, value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def _assign_path(document: dict[str, Any], parts: list[str], value: Any) -> None:
    node = document
    for part in parts[:-1]:
        child = node.get(part)
        if not isinstance(child, dict):
            child = {}
            node[part] = child
        node = child
    node[parts[-1]] = value


def _flatten_document(document: Mapping[str, Any]) -> list[tuple[str, Any]]:
    leaves: list[tuple[str, Any]] = []

    def walk(node: Mapping[str, Any], prefix: str) -> None:
        for key, value in node.items():
            if not isinstance(key, str):
                raise ProviderError(
                    f"sqlite settings keys must be strings, got {type(key).__name__}"
                )
            if "." in key:
                raise ProviderError(
                    f"sqlite settings does not support dotted keys: {prefix + key!r}"
                )
            full_path = f"{prefix}{key}"
            if isinstance(value, dict) and value:
                walk(value, f"{full_path}.")
            else:
                leaves.append((full_path, value))

    walk(document, "")
    return leaves


def _parse_error_detail(exc: Exception) -> str:
    mark = getattr(exc, "problem_mark", None)
    if mark is not None:
        return f"{type(exc).__name__} at line {mark.line + 1}"
    lineno = getattr(exc, "lineno", None)
    if lineno is not None:
        return f"{type(exc).__name__} at line {lineno}"
    return type(exc).__name__


_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


def _thread_lock(path: Path) -> threading.RLock:
    key = str(path.resolve())
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _LOCKS[key] = lock
        return lock


@contextlib.contextmanager
def _file_lock(path: Path, timeout: float = _LOCK_TIMEOUT_S) -> Iterator[None]:
    if fcntl is None:
        yield
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ProviderError(f"timed out waiting for settings lock: {path}") from None
                time.sleep(_LOCK_POLL_S)
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _fsync_dir(directory: Path) -> None:
    if not hasattr(os, "O_DIRECTORY"):
        return
    try:
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _backup_path(path: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = path.with_name(f"{path.name}.bak-{stamp}")
    counter = 1
    while candidate.exists():
        counter += 1
        candidate = path.with_name(f"{path.name}.bak-{stamp}-{counter}")
    return candidate


def _write_backup(path: Path, payload: bytes) -> Path:
    backup = _backup_path(path)
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    return backup


def _write_atomic(path: Path, payload: bytes) -> None:
    if path.is_symlink():
        raise ProviderError(f"refusing to write through symlink: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        _write_backup(path, path.read_bytes())
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
        _fsync_dir(path.parent)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp_path.unlink()
        raise


# ── 文件 provider：YAML / JSON ──────────────────────────────


class _FileProvider:
    kind = "file"

    def __init__(self, path: str | os.PathLike[str], *, lock_timeout: float = _LOCK_TIMEOUT_S):
        self._path = Path(path).expanduser()
        self._lock_timeout = lock_timeout
        self._lock = _thread_lock(self._path)

    def _parse(self, text: str) -> Any:
        raise NotImplementedError

    def _serialize(self, document: dict[str, Any]) -> bytes:
        raise NotImplementedError

    def load(self) -> dict[str, Any]:
        path = self._path
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return {}
        except OSError as exc:
            raise ProviderError(f"cannot read settings file {path}") from exc
        if not raw.strip():
            return {}
        try:
            parsed = self._parse(raw.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise ProviderError(f"settings file is not valid UTF-8: {path}") from exc
        except (yaml.YAMLError, json.JSONDecodeError) as exc:
            raise ProviderError(
                f"invalid {self.kind} settings file {path}: {_parse_error_detail(exc)}"
            ) from exc
        if not isinstance(parsed, dict):
            raise ProviderError(
                f"{self.kind} settings file must contain a mapping at top level: {path}"
            )
        return copy.deepcopy(parsed)

    def save(
        self, document: dict[str, Any], *, expected_revision: str | None = None
    ) -> str:
        document = _require_mapping(document, source=self.kind)
        try:
            payload = self._serialize(copy.deepcopy(document))
        except (TypeError, ValueError, yaml.YAMLError) as exc:
            raise ProviderError(
                f"cannot serialize settings document as {self.kind}: {type(exc).__name__}"
            ) from exc
        path = self._path
        lock_path = path.with_name(f"{path.name}.lock")
        with self._lock, _file_lock(lock_path, self._lock_timeout):
            current = self.revision()
            if expected_revision is not None and expected_revision != current:
                raise ProviderError(
                    f"stale settings revision: expected {expected_revision!r}, "
                    f"current {current!r}"
                )
            _write_atomic(path, payload)
            return self.revision()

    def revision(self) -> str:
        path = self._path
        try:
            stat = path.stat()
            payload = path.read_bytes()
        except FileNotFoundError:
            return "missing"
        except OSError as exc:
            raise ProviderError(f"cannot read settings file {path}") from exc
        digest = hashlib.sha256(payload).hexdigest()[:12]
        return f"{stat.st_mtime_ns}-{stat.st_size}-{digest}"

    def describe(self) -> ProviderInfo:
        return ProviderInfo(
            kind=self.kind,
            location=str(self._path.resolve()),
            writable=True,
        )


class YamlFileProvider(_FileProvider):
    kind = "yaml"

    def _parse(self, text: str) -> Any:
        return yaml.safe_load(text)

    def _serialize(self, document: dict[str, Any]) -> bytes:
        text = yaml.safe_dump(document, allow_unicode=True, sort_keys=False)
        if not text.endswith("\n"):
            text += "\n"
        return text.encode("utf-8")


class JsonFileProvider(_FileProvider):
    kind = "json"

    def _parse(self, text: str) -> Any:
        return json.loads(text)

    def _serialize(self, document: dict[str, Any]) -> bytes:
        text = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=False)
        return (text + "\n").encode("utf-8")


# ── SQLite provider ─────────────────────────────────────────

_SETTINGS_DDL = """
CREATE TABLE IF NOT EXISTS settings (
    path TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""
_META_DDL = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)
"""


class SqliteProvider:
    kind = "sqlite"

    def __init__(self, path: str | os.PathLike[str]):
        self._path = Path(path).expanduser()
        self._lock = _thread_lock(self._path)

    def _empty_db(self) -> bool:
        try:
            return self._path.stat().st_size == 0
        except FileNotFoundError:
            return True
        except OSError as exc:
            raise ProviderError(f"cannot stat sqlite settings database {self._path}") from exc

    def _connect(self, *, readonly: bool) -> sqlite3.Connection:
        uri = self._path.resolve().as_uri()
        if readonly:
            uri += "?mode=ro"
        conn: sqlite3.Connection | None = None
        try:
            conn = sqlite3.connect(uri, uri=True, timeout=_SQLITE_TIMEOUT_S)
            conn.execute(f"PRAGMA busy_timeout = {int(_SQLITE_TIMEOUT_S * 1000)}")
            if not readonly:
                conn.execute("PRAGMA journal_mode = WAL")
        except sqlite3.Error as exc:
            if conn is not None:
                with contextlib.suppress(sqlite3.Error):
                    conn.close()
            raise ProviderError(
                f"cannot open sqlite settings database {self._path}"
            ) from exc
        return conn

    @staticmethod
    def _read_revision(conn: sqlite3.Connection) -> str | None:
        try:
            row = conn.execute("SELECT value FROM meta WHERE key = 'revision'").fetchone()
        except sqlite3.OperationalError as exc:
            if "no such table" in str(exc).lower():
                return None
            raise
        return str(row[0]) if row else None

    def load(self) -> dict[str, Any]:
        if self._empty_db():
            return {}
        conn = self._connect(readonly=True)
        try:
            rows = conn.execute("SELECT path, value FROM settings").fetchall()
        except sqlite3.OperationalError as exc:
            if "no such table" in str(exc).lower():
                return {}
            raise ProviderError(
                f"invalid sqlite settings database {self._path}"
            ) from exc
        except sqlite3.Error as exc:
            raise ProviderError(
                f"invalid sqlite settings database {self._path}"
            ) from exc
        finally:
            conn.close()
        document: dict[str, Any] = {}
        for path, encoded in rows:
            try:
                value = json.loads(encoded)
            except (TypeError, ValueError) as exc:
                raise ProviderError(
                    f"corrupted settings value for {path!r} in {self._path}"
                ) from exc
            _assign_path(document, str(path).split("."), value)
        return document

    def save(
        self, document: dict[str, Any], *, expected_revision: str | None = None
    ) -> str:
        document = _require_mapping(document, source=self.kind)
        leaves = _flatten_document(document)
        with self._lock:
            was_missing = self._empty_db()
            if expected_revision is not None and not was_missing:
                current = self.revision()
                if expected_revision != current:
                    raise ProviderError(
                        f"stale settings revision: expected {expected_revision!r}, "
                        f"current {current!r}"
                    )
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._create_private_file()
            conn = self._connect(readonly=False)
            try:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute(_SETTINGS_DDL)
                conn.execute(_META_DDL)
                revision_row = self._read_revision(conn)
                actual = revision_row if revision_row is not None else (
                    "missing" if was_missing else "0"
                )
                if expected_revision is not None and expected_revision != actual:
                    raise ProviderError(
                        f"stale settings revision: expected {expected_revision!r}, "
                        f"current {actual!r}"
                    )
                new_revision = _next_revision(revision_row)
                conn.execute("DELETE FROM settings")
                now = datetime.now(timezone.utc).isoformat(timespec="seconds")
                conn.executemany(
                    "INSERT INTO settings(path, value, updated_at) VALUES(?, ?, ?)",
                    [
                        (path, json.dumps(value, ensure_ascii=False), now)
                        for path, value in leaves
                    ],
                )
                conn.executemany(
                    "INSERT INTO meta(key, value) VALUES(?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [("schema_version", _SCHEMA_VERSION), ("revision", new_revision)],
                )
                conn.commit()
            except sqlite3.Error as exc:
                with contextlib.suppress(sqlite3.Error):
                    conn.rollback()
                raise ProviderError(
                    f"cannot save sqlite settings database {self._path}"
                ) from exc
            except BaseException:
                with contextlib.suppress(sqlite3.Error):
                    conn.rollback()
                raise
            finally:
                conn.close()
            with contextlib.suppress(OSError):
                os.chmod(self._path, 0o600)
            return new_revision

    def _create_private_file(self) -> None:
        try:
            fd = os.open(self._path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        except FileExistsError:
            return
        os.close(fd)

    def revision(self) -> str:
        if self._empty_db():
            return "missing"
        conn = self._connect(readonly=True)
        try:
            value = self._read_revision(conn)
        except sqlite3.Error as exc:
            raise ProviderError(
                f"invalid sqlite settings database {self._path}"
            ) from exc
        finally:
            conn.close()
        return value if value is not None else "0"

    def describe(self) -> ProviderInfo:
        return ProviderInfo(
            kind=self.kind,
            location=str(self._path.resolve()),
            writable=True,
        )


def _next_revision(raw: str | None) -> str:
    if raw is None:
        return "1"
    try:
        return str(int(raw) + 1)
    except ValueError:
        return "1"


# ── Env 只读覆盖层 ──────────────────────────────────────────


def _coerce_env_value(raw: str) -> Any:
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return raw


class EnvOverlay:
    """只读环境变量覆盖层：PREFIX + 大写路径，``__`` 分隔层级。"""

    kind = "env"

    def __init__(
        self,
        prefix: str = DEFAULT_ENV_PREFIX,
        env: Mapping[str, str] | None = None,
    ):
        self._prefix = prefix
        self._env = env

    def _source(self) -> Mapping[str, str]:
        return os.environ if self._env is None else self._env

    def _pairs(self) -> list[tuple[str, str]]:
        pairs: list[tuple[str, str]] = []
        for name, raw in self._source().items():
            if not name.startswith(self._prefix):
                continue
            parts = [part.lower() for part in name[len(self._prefix):].split("__") if part]
            if parts:
                pairs.append((".".join(parts), raw))
        pairs.sort(key=lambda item: item[0])
        return pairs

    def load(self) -> dict[str, Any]:
        document: dict[str, Any] = {}
        for dotted, raw in self._pairs():
            _assign_path(document, dotted.split("."), _coerce_env_value(raw))
        return document

    def save(
        self, document: dict[str, Any], *, expected_revision: str | None = None
    ) -> str:
        raise ProviderError("env overlay is read-only")

    def revision(self) -> str:
        payload = json.dumps(
            self._pairs(), ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        return f"env-{hashlib.sha256(payload).hexdigest()[:12]}"

    def describe(self) -> ProviderInfo:
        return ProviderInfo(
            kind=self.kind,
            location=f"env:{self._prefix}",
            writable=False,
            detail=f"{len(self._pairs())} variable(s)",
        )


# ── 组合 provider / 启动选择 ────────────────────────────────


class ComposedProvider:
    """base 负责持久化，overlay（env）只读叠加且优先。"""

    def __init__(self, base: ConfigProvider, overlay: ConfigProvider | None = None):
        self._base = base
        self._overlay = overlay

    @property
    def base(self) -> ConfigProvider:
        """持久化层 provider（写入落到这里）。"""
        return self._base

    @property
    def overlay(self) -> ConfigProvider | None:
        """只读覆盖层 provider；未配置时为 None。"""
        return self._overlay

    def load(self) -> dict[str, Any]:
        document = copy.deepcopy(self._base.load())
        if self._overlay is None:
            return document
        return _deep_merge(document, self._overlay.load())

    def save(
        self, document: dict[str, Any], *, expected_revision: str | None = None
    ) -> str:
        document = _require_mapping(document, source="settings")
        return self._base.save(copy.deepcopy(document), expected_revision=expected_revision)

    def revision(self) -> str:
        base_revision = self._base.revision()
        if self._overlay is None:
            return base_revision
        return f"{base_revision}+{self._overlay.revision()}"

    def describe(self) -> ProviderInfo:
        base_info = self._base.describe()
        if self._overlay is None:
            return base_info
        overlay_info = self._overlay.describe()
        return ProviderInfo(
            kind=base_info.kind,
            location=base_info.location,
            writable=base_info.writable,
            detail=f"base={base_info}; overlay={overlay_info}",
        )


class _MemoryProvider:
    """backend=env 时的空基座：可读空文档，写入明确报只读。"""

    def __init__(self) -> None:
        self._reason = (
            "env settings backend is read-only; "
            "set AXEUH_CONFIG_BACKEND=yaml|json|sqlite to persist"
        )

    def load(self) -> dict[str, Any]:
        return {}

    def save(
        self, document: dict[str, Any], *, expected_revision: str | None = None
    ) -> str:
        raise ProviderError(self._reason)

    def revision(self) -> str:
        return "memory"

    def describe(self) -> ProviderInfo:
        return ProviderInfo(
            kind="env",
            location="memory://settings",
            writable=False,
            detail="in-memory empty base (env backend)",
        )


def build_provider(env: Mapping[str, str] | None = None) -> ConfigProvider:
    """按环境变量选择后端，并始终把 EnvOverlay 叠在持久化层之上。"""
    source = os.environ if env is None else env
    backend = source.get("AXEUH_CONFIG_BACKEND", "").strip().lower()
    if backend and backend not in _VALID_BACKENDS:
        raise ProviderError(
            f"unsupported AXEUH_CONFIG_BACKEND: {backend!r} "
            f"(expected {'|'.join(_VALID_BACKENDS)})"
        )
    config_path_raw = source.get("AXEUH_CONFIG_PATH")
    sqlite_path_raw = source.get("AXEUH_CONFIG_SQLITE_PATH")
    if not backend:
        if config_path_raw:
            backend = "json" if Path(config_path_raw).suffix.lower() == ".json" else "yaml"
        elif sqlite_path_raw:
            backend = "sqlite"
        else:
            backend = "yaml"
    overlay = EnvOverlay(env=source)
    if backend == "env":
        return ComposedProvider(_MemoryProvider(), overlay)
    if backend == "sqlite":
        sqlite_path = Path(sqlite_path_raw) if sqlite_path_raw else _DEFAULT_SQLITE_PATH
        return ComposedProvider(SqliteProvider(sqlite_path), overlay)
    config_path = Path(config_path_raw) if config_path_raw else _DEFAULT_CONFIG_PATH
    if backend == "json":
        return ComposedProvider(JsonFileProvider(config_path), overlay)
    return ComposedProvider(YamlFileProvider(config_path), overlay)
