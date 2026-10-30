# -*- coding: utf-8 -*-
"""内核模型清单：加载、校验、目标路径解析与本地落地状态。

清单真源 ``backend/resources/kernel-models.json`` 只描述模型元数据，不做任何
下载或网络访问。默认源为 ModelScope；HuggingFace gated 仓库只作为显式回退。
``status_for`` 只读文件系统，用于 onboarding 展示与预检。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable, Mapping
from urllib.parse import urlsplit

SCHEMA_VERSION = 1
TIERS: "tuple[str, ...]" = ("required", "recommended", "optional")
SOURCES: "tuple[str, ...]" = (
    "bundled",
    "modelscope",
    "huggingface_gated",
    "release",
    "upstream",
)
KINDS: "tuple[str, ...]" = ("directory", "file")
MODEL_FIELDS: "tuple[str, ...]" = (
    "id",
    "tier",
    "source",
    "repo",
    "target",
    "kind",
    "size_bytes",
    "sha256",
    "md5",
    "gated",
    "required_files",
    "url",
    "mirrors",
    "notes",
)
TOP_FIELDS = ("schema", "product", "version", "default_source", "models")
DEFAULT_MANIFEST_PATH = (
    Path(__file__).resolve().parents[1] / "resources" / "kernel-models.json"
)
DEFAULT_PROJECT_ROOT = Path(__file__).resolve().parents[2]

_ID_RE = re.compile(r"^[a-z][a-z0-9-]*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MD5_RE = re.compile(r"^[0-9a-f]{32}$")
_DRIVE_RE = re.compile(r"^[A-Za-z]:")
_GLOB_CHARS = frozenset("*?[")


class KernelModelManifestError(Exception):
    """清单错误；``code`` 是稳定、可上报且不含敏感值的错误码。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class ModelEntry:
    id: str
    tier: str
    source: str
    repo: str
    target: str
    kind: str
    size_bytes: int
    sha256: str | None
    md5: str | None
    gated: bool
    required_files: "tuple[str, ...]"
    url: str | None
    mirrors: "tuple[str, ...]"
    notes: str

    def resolved_target(
        self,
        *,
        project_root: Path | str | None = None,
        kernel_root: Path | str | None = None,
        home: Path | str | None = None,
    ) -> Path:
        return resolve_target(
            self.target,
            project_root=project_root,
            kernel_root=kernel_root,
            home=home,
        )

    def public(self) -> dict:
        return {
            "id": self.id,
            "tier": self.tier,
            "source": self.source,
            "repo": self.repo,
            "target": self.target,
            "kind": self.kind,
            "size_bytes": self.size_bytes,
            "sha256": self.sha256,
            "md5": self.md5,
            "gated": self.gated,
            "required_files": list(self.required_files),
            "url": self.url,
            "mirrors": list(self.mirrors),
            "notes": self.notes,
        }


@dataclass(frozen=True, slots=True)
class KernelModelManifest:
    schema: int
    product: str
    version: str
    default_source: str
    models: "tuple[ModelEntry, ...]"

    def select(
        self,
        *,
        ids: Iterable[str] | str | None = None,
        tiers: Iterable[str] | str | None = None,
    ) -> "tuple[ModelEntry, ...]":
        tier_filter = _normalize_filter(tiers, TIERS, "invalid_tier")
        id_filter = _normalize_filter(
            ids, tuple(model.id for model in self.models), "unknown_model_id"
        )
        selected = []
        for model in self.models:
            if tier_filter is not None and model.tier not in tier_filter:
                continue
            if id_filter is not None and model.id not in id_filter:
                continue
            selected.append(model)
        return tuple(selected)

    def total_size(
        self,
        *,
        ids: Iterable[str] | str | None = None,
        tiers: Iterable[str] | str | None = None,
    ) -> int:
        return sum(
            model.size_bytes for model in self.select(ids=ids, tiers=tiers)
        )

    def status_for(
        self,
        paths: Mapping[str, Path | str] | None = None,
        *,
        ids: Iterable[str] | str | None = None,
        tiers: Iterable[str] | str | None = None,
        project_root: Path | str | None = None,
        kernel_root: Path | str | None = None,
        home: Path | str | None = None,
    ) -> "list[dict]":
        """返回所选模型的本地落地状态；只读文件系统，不下载、不联网。"""
        overrides = dict(paths or {})
        unknown = sorted(set(overrides) - {model.id for model in self.models})
        if unknown:
            raise KernelModelManifestError(
                "unknown_model_id", "unknown model ids: %s" % ", ".join(unknown)
            )
        rows = []
        for model in self.select(ids=ids, tiers=tiers):
            if model.id in overrides:
                target = Path(overrides[model.id]).expanduser()
            else:
                target = model.resolved_target(
                    project_root=project_root,
                    kernel_root=kernel_root,
                    home=home,
                )
            present, missing, error = _check_presence(model, target)
            rows.append(
                {
                    "id": model.id,
                    "tier": model.tier,
                    "source": model.source,
                    "gated": model.gated,
                    "kind": model.kind,
                    "target": str(target),
                    "size_bytes": model.size_bytes,
                    "present": present,
                    "missing_files": missing,
                    "error": error,
                }
            )
        return rows


def _normalize_filter(
    values: Iterable[str] | str | None,
    allowed: "tuple[str, ...]",
    code: str,
) -> "set[str] | None":
    if values is None:
        return None
    items = (values,) if isinstance(values, str) else tuple(values)
    unknown = sorted({item for item in items if item not in allowed})
    if unknown:
        raise KernelModelManifestError(
            code, "unknown values: %s" % ", ".join(unknown)
        )
    return set(items)


def _require_str(
    value: object, name: str, *, allow_empty: bool = False
) -> str:
    if not isinstance(value, str):
        raise KernelModelManifestError(
            "manifest_invalid_schema", "%s must be a string" % name
        )
    text = value.strip()
    if not text and not allow_empty:
        raise KernelModelManifestError(
            "manifest_invalid_schema", "%s is required" % name
        )
    return text


def _require_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise KernelModelManifestError(
            "manifest_invalid_schema", "%s must be an integer" % name
        )
    if value < 0:
        raise KernelModelManifestError(
            "manifest_invalid_schema", "%s must be non-negative" % name
        )
    return value


def _safe_relative(value: str, *, allow_glob: bool) -> str:
    text = value.strip()
    if not text or "\x00" in text:
        raise KernelModelManifestError(
            "manifest_invalid_target", "empty or invalid relative path"
        )
    if _DRIVE_RE.match(text):
        raise KernelModelManifestError(
            "manifest_invalid_target", "Windows drive paths are not supported"
        )
    normalized = text.replace("\\", "/")
    pure = PurePosixPath(normalized)
    if pure.is_absolute():
        raise KernelModelManifestError(
            "manifest_invalid_target", "path must be relative"
        )
    for part in pure.parts:
        if part == "..":
            raise KernelModelManifestError(
                "manifest_invalid_target", "path traversal is not allowed"
            )
        if not allow_glob and any(char in _GLOB_CHARS for char in part):
            raise KernelModelManifestError(
                "manifest_invalid_target", "glob characters are not allowed here"
            )
    return normalized


def _validate_target(value: object) -> str:
    text = _require_str(value, "target")
    if "\x00" in text or _DRIVE_RE.match(text):
        raise KernelModelManifestError(
            "manifest_invalid_target", "target contains an unsupported path"
        )
    if text.startswith("<kernel>"):
        remainder = text[len("<kernel>") :]
        if not remainder.startswith(("/", "\\")):
            raise KernelModelManifestError(
                "manifest_invalid_target",
                "<kernel> target must be followed by a separator",
            )
        if "<kernel>" in remainder:
            raise KernelModelManifestError(
                "manifest_invalid_target", "<kernel> placeholder must be unique"
            )
        _safe_relative(remainder.lstrip("/\\"), allow_glob=False)
        return text
    if text.startswith("~"):
        if not text.startswith("~/"):
            raise KernelModelManifestError(
                "manifest_invalid_target", "only ~/ targets are supported"
            )
        _safe_relative(text[2:], allow_glob=False)
        return text
    if text.startswith("/"):
        pure = PurePosixPath(text)
        if ".." in pure.parts or str(pure) == "/":
            raise KernelModelManifestError(
                "manifest_invalid_target", "absolute target is not safe"
            )
        return text
    _safe_relative(text, allow_glob=False)
    return text


def resolve_target(
    target: str,
    *,
    project_root: Path | str | None = None,
    kernel_root: Path | str | None = None,
    home: Path | str | None = None,
) -> Path:
    """解析清单目标；``<kernel>`` 指向内核目录，``~`` 指向 home。"""
    text = _validate_target(target)
    if text.startswith("<kernel>"):
        base = (
            Path(kernel_root).expanduser()
            if kernel_root is not None
            else _project_path(project_root) / "kernel"
        )
        remainder = _safe_relative(text[len("<kernel>") :].lstrip("/\\"), allow_glob=False)
        return base / remainder
    if text.startswith("~/"):
        return _home_path(home) / _safe_relative(text[2:], allow_glob=False)
    if text.startswith("/"):
        return Path(text)
    return _project_path(project_root) / _safe_relative(text, allow_glob=False)


def _project_path(project_root: Path | str | None) -> Path:
    if project_root is None:
        return DEFAULT_PROJECT_ROOT
    return Path(project_root).expanduser()


def _home_path(home: Path | str | None) -> Path:
    if home is None:
        return Path.home()
    return Path(home).expanduser()


def _https_url(value: object, name: str) -> str:
    text = _require_str(value, name)
    parts = urlsplit(text)
    if parts.scheme != "https" or not parts.hostname:
        raise KernelModelManifestError(
            "manifest_invalid_schema", "%s must be an HTTPS URL" % name
        )
    return text


def _validate_url(value: object, name: str) -> str | None:
    if value is None:
        return None
    return _https_url(value, name)


def _parse_model(raw: object, index: int) -> ModelEntry:
    if not isinstance(raw, Mapping):
        raise KernelModelManifestError(
            "manifest_invalid_schema", "models[%d] must be an object" % index
        )
    keys = set(raw)
    expected = set(MODEL_FIELDS)
    if keys != expected:
        missing = sorted(expected - keys)
        extra = sorted(keys - expected)
        raise KernelModelManifestError(
            "manifest_invalid_schema",
            "models[%d] keys mismatch (missing=%s extra=%s)"
            % (index, missing, extra),
        )
    model_id = _require_str(raw["id"], "id")
    if not _ID_RE.match(model_id):
        raise KernelModelManifestError(
            "manifest_invalid_schema", "invalid model id: %s" % model_id
        )
    tier = _require_str(raw["tier"], "tier")
    if tier not in TIERS:
        raise KernelModelManifestError(
            "manifest_invalid_schema", "invalid tier for %s: %s" % (model_id, tier)
        )
    source = _require_str(raw["source"], "source")
    if source not in SOURCES:
        raise KernelModelManifestError(
            "manifest_invalid_schema", "invalid source for %s: %s" % (model_id, source)
        )
    repo = _require_str(raw["repo"], "repo")
    target = _validate_target(raw["target"])
    kind = _require_str(raw["kind"], "kind")
    if kind not in KINDS:
        raise KernelModelManifestError(
            "manifest_invalid_schema", "invalid kind for %s: %s" % (model_id, kind)
        )
    size_bytes = _require_int(raw["size_bytes"], "size_bytes")
    sha256 = raw["sha256"]
    if sha256 is not None:
        sha256 = _require_str(sha256, "sha256").lower()
        if not _SHA256_RE.match(sha256):
            raise KernelModelManifestError(
                "manifest_invalid_schema", "invalid sha256 for %s" % model_id
            )
    md5 = raw["md5"]
    if md5 is not None:
        md5 = _require_str(md5, "md5").lower()
        if not _MD5_RE.match(md5):
            raise KernelModelManifestError(
                "manifest_invalid_schema", "invalid md5 for %s" % model_id
            )
    gated = raw["gated"]
    if not isinstance(gated, bool):
        raise KernelModelManifestError(
            "manifest_invalid_schema", "gated must be boolean for %s" % model_id
        )
    if source == "huggingface_gated" and not gated:
        raise KernelModelManifestError(
            "manifest_invalid_schema",
            "huggingface_gated model %s must set gated=true" % model_id,
        )
    raw_required = raw["required_files"]
    if not isinstance(raw_required, list) or any(
        not isinstance(item, str) for item in raw_required
    ):
        raise KernelModelManifestError(
            "manifest_invalid_schema", "required_files must be a string list"
        )
    required_files = tuple(
        _safe_relative(item, allow_glob=True) for item in raw_required
    )
    if len(set(required_files)) != len(required_files):
        raise KernelModelManifestError(
            "manifest_invalid_schema", "duplicate required_files for %s" % model_id
        )
    if kind == "directory" and not required_files:
        raise KernelModelManifestError(
            "manifest_invalid_schema",
            "directory model %s needs required_files" % model_id,
        )
    if kind == "file" and required_files:
        raise KernelModelManifestError(
            "manifest_invalid_schema",
            "file model %s must not declare required_files" % model_id,
        )
    url = _validate_url(raw["url"], "url")
    if source in ("upstream", "release") and url is None:
        raise KernelModelManifestError(
            "manifest_invalid_schema",
            "%s model %s needs an upstream URL" % (source, model_id),
        )
    raw_mirrors = raw["mirrors"]
    if not isinstance(raw_mirrors, list) or any(
        not isinstance(item, str) for item in raw_mirrors
    ):
        raise KernelModelManifestError(
            "manifest_invalid_schema", "mirrors must be a string list"
        )
    mirrors = tuple(_https_url(item, "mirrors") for item in raw_mirrors)
    if len(set(mirrors)) != len(mirrors):
        raise KernelModelManifestError(
            "manifest_invalid_schema", "duplicate mirrors for %s" % model_id
        )
    if mirrors and source not in ("upstream", "release"):
        raise KernelModelManifestError(
            "manifest_invalid_schema",
            "%s model %s must not declare mirrors" % (source, model_id),
        )
    notes = _require_str(raw["notes"], "notes", allow_empty=True)
    return ModelEntry(
        id=model_id,
        tier=tier,
        source=source,
        repo=repo,
        target=target,
        kind=kind,
        size_bytes=size_bytes,
        sha256=sha256,
        md5=md5,
        gated=gated,
        required_files=required_files,
        url=url,
        mirrors=mirrors,
        notes=notes,
    )


def parse_manifest(payload: Mapping) -> KernelModelManifest:
    if not isinstance(payload, Mapping):
        raise KernelModelManifestError(
            "manifest_invalid_schema", "manifest must be a JSON object"
        )
    keys = set(payload)
    expected = set(TOP_FIELDS)
    if keys != expected:
        missing = sorted(expected - keys)
        extra = sorted(keys - expected)
        raise KernelModelManifestError(
            "manifest_invalid_schema",
            "top-level keys mismatch (missing=%s extra=%s)" % (missing, extra),
        )
    schema = payload["schema"]
    if isinstance(schema, bool) or schema != SCHEMA_VERSION:
        raise KernelModelManifestError(
            "manifest_invalid_schema", "manifest schema must be %d" % SCHEMA_VERSION
        )
    product = _require_str(payload["product"], "product")
    version = _require_str(payload["version"], "version")
    default_source = _require_str(payload["default_source"], "default_source")
    if default_source not in SOURCES:
        raise KernelModelManifestError(
            "manifest_invalid_schema",
            "invalid default_source: %s" % default_source,
        )
    raw_models = payload["models"]
    if not isinstance(raw_models, list) or not raw_models:
        raise KernelModelManifestError(
            "manifest_invalid_schema", "models must be a non-empty list"
        )
    models = tuple(_parse_model(raw, index) for index, raw in enumerate(raw_models))
    ids = [model.id for model in models]
    if len(set(ids)) != len(ids):
        raise KernelModelManifestError(
            "manifest_invalid_schema", "duplicate model ids"
        )
    return KernelModelManifest(
        schema=SCHEMA_VERSION,
        product=product,
        version=version,
        default_source=default_source,
        models=models,
    )


def load_manifest(path: Path | str | None = None) -> KernelModelManifest:
    manifest_path = (
        Path(path).expanduser() if path is not None else DEFAULT_MANIFEST_PATH
    )
    try:
        raw = manifest_path.read_bytes()
    except FileNotFoundError as exc:
        raise KernelModelManifestError(
            "manifest_missing", "manifest not found: %s" % manifest_path
        ) from exc
    except OSError as exc:
        raise KernelModelManifestError(
            "manifest_unreadable", "manifest unreadable: %s" % manifest_path
        ) from exc
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise KernelModelManifestError(
            "manifest_invalid_json", "manifest is not valid JSON"
        ) from exc
    return parse_manifest(payload)


def _check_presence(
    model: ModelEntry, target: Path
) -> "tuple[bool, list[str], str | None]":
    try:
        exists = target.exists()
        if not exists:
            return False, [], "target_missing"
        if model.kind == "file":
            if not target.is_file():
                return False, [], "target_not_file"
            return True, [], None
        if not target.is_dir():
            return False, [], "target_not_directory"
        missing = []
        for pattern in model.required_files:
            if any(char in _GLOB_CHARS for char in pattern):
                try:
                    matches = [path for path in target.glob(pattern) if path.is_file()]
                except (OSError, ValueError):
                    return False, list(model.required_files), "target_unreadable"
                if not matches:
                    missing.append(pattern)
            elif not (target / pattern).is_file():
                missing.append(pattern)
        if missing:
            return False, missing, "required_files_missing"
        return True, [], None
    except OSError:
        return False, [], "target_unreadable"


__all__ = [
    "DEFAULT_MANIFEST_PATH",
    "KernelModelManifest",
    "KernelModelManifestError",
    "ModelEntry",
    "SCHEMA_VERSION",
    "SOURCES",
    "TIERS",
    "load_manifest",
    "parse_manifest",
    "resolve_target",
]
