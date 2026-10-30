"""Content scanner for the Kinship public export gate.

The scanner is intentionally independent of the allowlist: the allowlist decides
which paths may leave the repository, while this module decides whether an
allowed file still contains a known secret or personal identifier.

Findings are reported as ``(path, category, count)`` only. Matched bytes are
never returned, logged, or embedded in a report.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from pathlib import Path

try:  # pragma: no cover - exercised by direct script imports
    from . import scanner_patterns as patterns
    from .report import ScanHit
except ImportError:  # pragma: no cover
    import scanner_patterns as patterns  # type: ignore[no-redef]
    from report import ScanHit  # type: ignore[no-redef]

MAX_SCAN_BYTES = 16 * 1024 * 1024

CATEGORIES: tuple[str, ...] = (
    "private_key",
    "aws_access_key",
    "github_token",
    "slack_token",
    "google_api_key",
    "openai_key",
    "anthropic_key",
    "stripe_live_key",
    "npm_token",
    "pypi_token",
    "telegram_bot_token",
    "discord_webhook",
    "google_oauth_secret",
    "jwt",
    "bearer_token",
    "database_url_credentials",
    "password_assignment",
    "phone_cn",
    "id_card_cn",
    "email_personal",
    "qq_number",
    "qq_identifier",
    "windows_user_path",
    "windows_drive_path",
    "wsl_user_path",
    "wsl_path",
    "home_path",
    "gps_coord",
    "personal_literal",
)


def scan_bytes(data: bytes, path: str) -> tuple[ScanHit, ...]:
    """Return one hit per matching category, never including the match itself."""

    counters = (
        ("private_key", _count(patterns.PRIVATE_KEY, data)),
        ("aws_access_key", _count(patterns.AWS_ACCESS_KEY, data)),
        ("github_token", _count(patterns.GITHUB_TOKEN, data)),
        ("slack_token", _count(patterns.SLACK_TOKEN, data)),
        ("google_api_key", _count(patterns.GOOGLE_API_KEY, data)),
        ("openai_key", _count(patterns.OPENAI_KEY, data)),
        ("anthropic_key", _count(patterns.ANTHROPIC_KEY, data)),
        ("stripe_live_key", _count(patterns.STRIPE_LIVE_KEY, data)),
        ("npm_token", _count(patterns.NPM_TOKEN, data)),
        ("pypi_token", _count(patterns.PYPI_TOKEN, data)),
        ("telegram_bot_token", _count(patterns.TELEGRAM_BOT_TOKEN, data)),
        ("discord_webhook", _count(patterns.DISCORD_WEBHOOK, data)),
        ("google_oauth_secret", _count(patterns.GOOGLE_OAUTH_SECRET, data)),
        ("jwt", _count(patterns.JWT, data)),
        ("bearer_token", _count(patterns.BEARER_TOKEN, data)),
        ("database_url_credentials", _count(patterns.DATABASE_URL, data)),
        ("password_assignment", _count_passwords(data)),
        ("phone_cn", _count_phones(data)),
        ("id_card_cn", _count(patterns.ID_CARD, data)),
        ("email_personal", _count_emails(data)),
        ("qq_number", _count_qq(data)),
        ("qq_identifier", _count_qq_identifiers(data)),
        ("windows_user_path", _count_windows_users(data)),
        ("windows_drive_path", _count_windows_drive_paths(data)),
        ("wsl_user_path", _count_wsl_users(data)),
        ("wsl_path", _count_wsl_paths(data)),
        ("home_path", _count_home_users(data)),
        ("gps_coord", _count_gps(data)),
        ("personal_literal", _count_personal_literals(data)),
    )
    return tuple(
        ScanHit(path=path, category=category, count=count)
        for category, count in counters
        if count > 0
    )


def scan_file(file_path: Path, rel_path: str) -> tuple[ScanHit, ...]:
    """Scan one regular file, refusing files above the size limit."""

    if file_path.stat().st_size > MAX_SCAN_BYTES:
        raise ValueError("file exceeds scanner size limit")
    return scan_bytes(file_path.read_bytes(), rel_path)


def _count(pattern: re.Pattern[bytes], data: bytes) -> int:
    return sum(1 for _ in pattern.finditer(data))


def _count_passwords(data: bytes) -> int:
    count = 0
    for match in patterns.PASSWORD_ASSIGN.finditer(data):
        value = match.group(1)
        if _is_placeholder(value):
            continue
        if len(value) >= 12 and _entropy(value) >= 3.5:
            count += 1
    return count


def _count_phones(data: bytes) -> int:
    return sum(
        1
        for match in patterns.PHONE.finditer(data)
        if match.group(0) not in patterns.SAFE_PHONES
    )


def _count_emails(data: bytes) -> int:
    count = 0
    for match in patterns.EMAIL.finditer(data):
        local = match.group(1).lower()
        domain = match.group(2).lower()
        if domain in patterns.SAFE_EMAIL_DOMAINS:
            continue
        if domain not in patterns.PERSONAL_EMAIL_DOMAINS:
            continue
        if local in patterns.SAFE_EMAIL_LOCALS or _is_placeholder(local):
            continue
        count += 1
    return count


def _count_qq(data: bytes) -> int:
    count = 0
    for match in patterns.QQ_NUMBER.finditer(data):
        value = match.group(1)
        if len(set(value)) <= 2:
            continue
        count += 1
    return count


def _count_qq_identifiers(data: bytes) -> int:
    count = 0
    for pattern in (patterns.QQ_NUMERIC_LABEL, patterns.QQ_CLI_TARGET):
        for match in pattern.finditer(data):
            count += _is_reportable_qq(match.group(1), patterns.SAFE_QQ_IDS)
    for pattern in (patterns.QQ_COOKIE_LABEL, patterns.QQ_NORMALIZE_UIN):
        for match in pattern.finditer(data):
            count += _is_reportable_qq(
                match.group(1), patterns.SAFE_COOKIE_UINS, strip_cookie=True
            )
    for match in patterns.QQ_ALLOWLIST.finditer(data):
        for value in patterns.QQ_VALUE.finditer(match.group(1)):
            token = value.group(0)
            if token.startswith(b"o"):
                count += _is_reportable_qq(
                    token, patterns.SAFE_COOKIE_UINS, strip_cookie=True
                )
            else:
                count += _is_reportable_qq(token, patterns.SAFE_QQ_IDS)
    return count


def _is_reportable_qq(
    value: bytes, safe_values: frozenset[bytes], *, strip_cookie: bool = False
) -> int:
    if value.lower() in safe_values:
        return 0
    digits = value[1:] if strip_cookie else value
    if not strip_cookie and digits in patterns.SAFE_QQ_TIMESTAMPS:
        return 0
    if len(set(digits)) <= 2:
        return 0
    return 1


def _count_windows_users(data: bytes) -> int:
    count = 0
    for match in patterns.WINDOWS_USER_PATH.finditer(data):
        user = match.group(1)
        lowered = user.lower()
        if lowered in patterns.SAFE_WINDOWS_USERS:
            continue
        if any(marker in lowered for marker in patterns.PLACEHOLDER_MARKERS):
            continue
        if not user.isascii():
            continue
        count += 1
    return count


def _count_windows_drive_paths(data: bytes) -> int:
    return sum(
        1
        for match in patterns.WINDOWS_DRIVE_PATH.finditer(data)
        if not _is_safe_windows_path(match.group(0))
    )


def _count_wsl_users(data: bytes) -> int:
    count = 0
    for match in patterns.WSL_USER_PATH.finditer(data):
        user = match.group(1)
        lowered = user.lower()
        if lowered in patterns.SAFE_WINDOWS_USERS:
            continue
        if any(marker in lowered for marker in patterns.PLACEHOLDER_MARKERS):
            continue
        count += 1
    return count


def _count_wsl_paths(data: bytes) -> int:
    return sum(1 for _ in patterns.WSL_PATH.finditer(data))


def _is_safe_windows_path(value: bytes) -> bool:
    normalised = value.replace(b"\\\\", b"\\").lower()
    return any(
        normalised.startswith(prefix.encode("ascii"))
        for prefix in patterns.SAFE_WINDOWS_PATH_PREFIXES
    )


def _count_home_users(data: bytes) -> int:
    return sum(
        1
        for match in patterns.HOME_PATH.finditer(data)
        if match.group(1).lower() not in patterns.SAFE_HOME_USERS
    )


def _count_gps(data: bytes) -> int:
    count = 0
    for match in patterns.GPS_COORD.finditer(data):
        first = float(match.group(1))
        second = float(match.group(2))
        if not _looks_like_gps(first, second):
            continue
        if _is_safe_gps(first, second):
            continue
        count += 1
    return count


def _count_personal_literals(data: bytes) -> int:
    return sum(data.count(term) for term in patterns.PERSONAL_LITERALS)


def _looks_like_gps(first: float, second: float) -> bool:
    if abs(first) > 180 or abs(second) > 180:
        return False
    if abs(first) < 1 and abs(second) < 1:
        return False
    if first.is_integer() and second.is_integer():
        return False
    return min(abs(first), abs(second)) <= 90


def _is_safe_gps(first: float, second: float) -> bool:
    pair = (round(first, 4), round(second, 4))
    reverse = (pair[1], pair[0])
    return any(
        candidate == pair or candidate == reverse
        for candidate in patterns.SAFE_GPS_POINTS
    )


def _is_placeholder(value: bytes) -> bool:
    lowered = value.lower()
    return any(marker in lowered for marker in patterns.PLACEHOLDER_MARKERS)


def _entropy(value: bytes) -> float:
    if not value:
        return 0.0
    length = len(value)
    counts = Counter(value)
    return -sum(
        (count / length) * math.log2(count / length) for count in counts.values()
    )
