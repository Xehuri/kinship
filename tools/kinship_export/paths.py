"""Destination and path-level fail-closed checks for the export gate.

The rules here are intentionally independent of the allowlist. The allowlist
decides whether a path may be public; these checks reject destinations and
artifact shapes that must never be published even if a future allowlist edit
would permit them.
"""

from __future__ import annotations

from pathlib import Path


class GateError(RuntimeError):
    """A fail-closed validation error that is safe to show to the operator."""


_FORBIDDEN_PREFIXES: tuple[tuple[str, str], ...] = (
    ("ai/", "runtime AI data"),
    ("validation/", "validation data"),
    ("archive/", "archive data"),
    ("kernel/", "kernel source"),
    ("models/", "model weights"),
    ("tools/public-sync/", "retired publish tool"),
    ("frontend/mobile/public/circuitjs1/", "moved plugin"),
    ("docs/archive/", "archived documentation"),
    ("docs/migration/", "migration documentation"),
    ("loom-harness/state/", "runtime agent state"),
    ("backend/data/", "runtime data"),
    ("backend/logs/", "runtime logs"),
    ("backend/outputs/", "runtime outputs"),
    ("backend/bin/", "runtime binaries"),
    ("backend/models/", "model weights"),
    ("backend/ai/", "runtime AI data"),
    (".git/", "VCS metadata"),
    (".sisyphus/", "agent working state"),
    (".omo/", "agent working state"),
)

_FORBIDDEN_DIR_NAMES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".idea",
        ".gradle",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "build",
        "dist",
        "logs",
        "models",
        "node_modules",
        "outputs",
        "venv",
    }
)

# The Gradle wrapper jar is source-controlled build tooling, not a release
# artifact. Keep it as the only binary exception; the allowlist also has to
# name this exact path.
_TRUSTED_BINARY_PATHS = frozenset({"gradle/wrapper/gradle-wrapper.jar"})

_FORBIDDEN_SUFFIXES = (
    ".7z",
    ".aab",
    ".apk",
    ".bin",
    ".ckpt",
    ".dll",
    ".exe",
    ".gz",
    ".h5",
    ".jar",
    ".jks",
    ".keystore",
    ".log",
    ".onnx",
    ".p12",
    ".pb",
    ".pem",
    ".pfx",
    ".pt",
    ".pth",
    ".pyc",
    ".pyo",
    ".rar",
    ".safetensors",
    ".so",
    ".tar",
    ".tar.gz",
    ".tgz",
    ".zip",
)

_FORBIDDEN_NAMES = frozenset(
    {
        ".env",
        "auth.json",
        "config.local.yaml",
        "config.yaml",
        "config.yaml.lock",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
        "id_rsa",
        "local.properties",
        "pc_sensor_config.json",
    }
)


def prepare_dest(
    source: Path, dest: Path, *, must_exist: bool, require_empty: bool
) -> Path:
    """Validate a destination before export or verify touches it."""

    raw = str(dest)
    if not raw.strip():
        raise GateError("destination must not be empty")
    if "\0" in raw:
        raise GateError("destination contains a NUL byte")
    if ".." in Path(raw).parts:
        raise GateError("destination must not contain '..'")
    _reject_symlink_ancestors(dest, "destination")

    resolved = dest.resolve(strict=False)
    source_resolved = source.resolve()
    if resolved == source_resolved or source_resolved in resolved.parents:
        raise GateError("destination must be outside the source repository")

    exists = resolved.exists()
    if not exists:
        if must_exist:
            raise GateError("destination does not exist")
        return resolved
    if resolved.is_symlink():
        raise GateError("destination is a symlink")
    if not resolved.is_dir():
        raise GateError("destination exists and is not a directory")
    if require_empty and any(resolved.iterdir()):
        raise GateError("destination is not empty; refusing to overwrite")
    return resolved


def has_symlink_component(root: Path, rel: str) -> bool:
    """Return True when any parent directory of rel is a symlink."""

    current = root
    for part in rel.split("/")[:-1]:
        current = current / part
        if current.is_symlink():
            return True
    return False


def forbidden_dir_reason(rel: str, dirname: str) -> str | None:
    """Return why a directory must not be present in a public tree."""

    if dirname in _FORBIDDEN_DIR_NAMES:
        return f"forbidden directory: {dirname}"
    for prefix, reason in _FORBIDDEN_PREFIXES:
        if f"{rel}/".startswith(prefix):
            return reason
    return None


def forbidden_file_reason(rel: str) -> str | None:
    """Return why a file must not be present in a public tree."""

    lowered = rel.lower()
    if lowered in _TRUSTED_BINARY_PATHS:
        return None
    name = lowered.rsplit("/", 1)[-1]
    if name == ".env" or name.startswith(".env."):
        return "environment file"
    if name in _FORBIDDEN_NAMES:
        return "forbidden configuration or credential file"
    if rel.startswith("desktop/pc-sensor/config.json"):
        return "PC sensor runtime configuration"
    for suffix in _FORBIDDEN_SUFFIXES:
        if lowered.endswith(suffix):
            return f"forbidden artifact suffix: {suffix}"
    for prefix, reason in _FORBIDDEN_PREFIXES:
        if rel.startswith(prefix):
            return reason
    return None


def _reject_symlink_ancestors(path: Path, label: str) -> None:
    current = path.absolute()
    for candidate in (current, *current.parents):
        if candidate.is_symlink():
            raise GateError(f"{label} is a symlink or has a symlink ancestor")
