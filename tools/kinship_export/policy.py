"""Fail-closed evaluator for the Kinship public export allowlist.

The allowlist is the single source of truth: a path is public only when an
explicit allow entry matches it and no exclude entry matches it. Anything else
is denied. Invalid paths (absolute, drive-letter, traversal, empty) are denied
instead of guessed.
"""

from __future__ import annotations

import fnmatch
import tomllib
from pathlib import Path
from typing import Any

ALLOWLIST_PATH = Path(__file__).with_name("allowlist.toml")

_REQUIRED_MODE = "allowlist"
_REQUIRED_DEFAULT = "deny"
_WILDCARDS = frozenset("*?[")
_TRUSTED_BINARY_PATHS = frozenset({"gradle/wrapper/gradle-wrapper.jar"})


class AllowlistError(ValueError):
    """Raised when the allowlist is missing, malformed, or not fail-closed."""


def load_allowlist(path: Path | str = ALLOWLIST_PATH) -> dict[str, Any]:
    """Load and validate the allowlist TOML."""
    allowlist_path = Path(path)
    if not allowlist_path.is_file():
        raise AllowlistError(f"allowlist not found: {allowlist_path}")
    try:
        data = tomllib.loads(allowlist_path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise AllowlistError(f"allowlist is not valid TOML: {exc}") from exc
    validate_allowlist(data)
    return data


def validate_allowlist(data: dict[str, Any]) -> None:
    """Reject allowlists that are not explicit and fail-closed."""
    if not isinstance(data, dict):
        raise AllowlistError("allowlist root must be a table")
    if data.get("schema_version") != 1:
        raise AllowlistError("schema_version must be 1")
    if data.get("mode") != _REQUIRED_MODE:
        raise AllowlistError(f"mode must be {_REQUIRED_MODE!r}")
    if data.get("default_action") != _REQUIRED_DEFAULT:
        raise AllowlistError(f"default_action must be {_REQUIRED_DEFAULT!r}")

    allow = data.get("allow")
    if not isinstance(allow, dict):
        raise AllowlistError("[allow] table is required")
    files = _string_list(allow.get("files"), "allow.files")
    trees = _string_list(allow.get("trees"), "allow.trees")
    patterns = _string_list(allow.get("patterns"), "allow.patterns")
    if not (files or trees or patterns):
        raise AllowlistError("at least one allow entry is required")

    seen: set[str] = set()
    for entry in files:
        _reject_repo_escape(entry)
        if _has_wildcard(entry):
            raise AllowlistError(f"allow.files entry must be exact: {entry!r}")
        if entry.endswith("/"):
            raise AllowlistError(f"allow.files entry must not be a tree: {entry!r}")
        _reject_duplicate(seen, f"file:{entry}")
    for entry in trees:
        _reject_repo_escape(entry)
        if not entry.endswith("/"):
            raise AllowlistError(f"allow.trees entry must end with '/': {entry!r}")
        if _has_wildcard(entry):
            raise AllowlistError(f"allow.trees entry must be literal: {entry!r}")
        _reject_duplicate(seen, f"tree:{entry}")
    for entry in patterns:
        _reject_repo_escape(entry)
        if not _literal_prefix(entry):
            raise AllowlistError(f"allow.patterns entry is not bounded: {entry!r}")
        _reject_duplicate(seen, f"pattern:{entry}")

    exclude = data.get("exclude")
    if not isinstance(exclude, dict):
        raise AllowlistError("[exclude] table is required")
    exclude_patterns = _string_list(exclude.get("patterns"), "exclude.patterns")
    if not exclude_patterns:
        raise AllowlistError("exclude.patterns must not be empty")
    for entry in exclude_patterns:
        _reject_repo_escape(entry)
        if not entry:
            raise AllowlistError("exclude.patterns entry must not be empty")


def is_public_path(rel_path: str, allowlist: dict[str, Any] | None = None) -> bool:
    """Return True only when rel_path is explicitly allowed and not excluded."""
    data = allowlist if allowlist is not None else load_allowlist()
    try:
        rel = _normalise(rel_path)
    except AllowlistError:
        return False

    if rel in _TRUSTED_BINARY_PATHS:
        return True

    exclude_patterns = data["exclude"].get("patterns", [])
    allow = data["allow"]

    if any(_glob_match(rel, pattern) for pattern in exclude_patterns):
        return False
    if rel in set(allow.get("files", [])):
        return True
    for tree in allow.get("trees", []):
        if rel.startswith(tree):
            return True
    return any(_glob_match(rel, pattern) for pattern in allow.get("patterns", []))


def _string_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise AllowlistError(f"{field} must be a list of strings")
    return value


def _has_wildcard(value: str) -> bool:
    return any(char in value for char in _WILDCARDS)


def _literal_prefix(pattern: str) -> str:
    positions = [pattern.find(char) for char in _WILDCARDS if char in pattern]
    if not positions:
        return pattern
    return pattern[: min(positions)]


def _reject_duplicate(seen: set[str], key: str) -> None:
    if key in seen:
        raise AllowlistError(f"duplicate allow entry: {key!r}")
    seen.add(key)


def _reject_repo_escape(value: str) -> None:
    _normalise(value, allow_trailing_slash=True)


def _normalise(rel_path: str, *, allow_trailing_slash: bool = False) -> str:
    if not isinstance(rel_path, str):
        raise AllowlistError("path must be a string")
    value = rel_path.replace("\\", "/").strip()
    if not value:
        raise AllowlistError("path must not be empty")
    trailing_slash = value.endswith("/")
    value = value.rstrip("/")
    if not value:
        raise AllowlistError("path must not be empty")
    first_segment = value.split("/", 1)[0]
    if value.startswith("/") or (len(first_segment) == 2 and first_segment[1] == ":"):
        raise AllowlistError(f"path must be repository-relative: {rel_path!r}")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise AllowlistError(f"path must not contain empty, '.' or '..' segments: {rel_path!r}")
    if trailing_slash and not allow_trailing_slash:
        raise AllowlistError(f"unexpected trailing slash: {rel_path!r}")
    return value


def _glob_match(path: str, pattern: str) -> bool:
    path_parts = path.split("/")
    pattern_parts = pattern.rstrip("/").split("/")
    return _match_parts(path_parts, pattern_parts)


def _match_parts(path_parts: list[str], pattern_parts: list[str]) -> bool:
    if not pattern_parts:
        return not path_parts
    head = pattern_parts[0]
    if head == "**":
        return any(
            _match_parts(path_parts[index:], pattern_parts[1:])
            for index in range(len(path_parts) + 1)
        )
    if not path_parts:
        return False
    if not fnmatch.fnmatchcase(path_parts[0], head):
        return False
    return _match_parts(path_parts[1:], pattern_parts[1:])
