"""Pattern and placeholder tables for the public export scanner.

This module is data only. Keeping the tables separate from the counting logic
makes the security surface reviewable without reading control flow.
"""

from __future__ import annotations

import re

PRIVATE_KEY = re.compile(rb"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----")
AWS_ACCESS_KEY = re.compile(
    rb"\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b"
)
GITHUB_TOKEN = re.compile(
    rb"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b"
)
SLACK_TOKEN = re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")
GOOGLE_API_KEY = re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b")
OPENAI_KEY = re.compile(rb"\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{40,}\b")
ANTHROPIC_KEY = re.compile(rb"\bsk-ant-[A-Za-z0-9_-]{20,}\b")
STRIPE_LIVE_KEY = re.compile(rb"\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b")
NPM_TOKEN = re.compile(rb"\bnpm_[A-Za-z0-9]{36}\b")
PYPI_TOKEN = re.compile(rb"\bpypi-[A-Za-z0-9_-]{50,}\b")
TELEGRAM_BOT_TOKEN = re.compile(rb"\b\d{8,10}:[A-Za-z0-9_-]{35}\b")
DISCORD_WEBHOOK = re.compile(
    rb"https://(?:canary\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_-]+"
)
GOOGLE_OAUTH_SECRET = re.compile(rb"GOCSPX-[A-Za-z0-9_-]{28}")
JWT = re.compile(
    rb"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"
)
BEARER_TOKEN = re.compile(rb"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{24,}")
DATABASE_URL = re.compile(
    rb"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s:@/]+:[^\s@/]+@[^\s/]+"
)
PASSWORD_ASSIGN = re.compile(
    rb"(?i)(?<![-\w])(?:password|passwd|pwd)\s*[:=]\s*[\"']([^\"'\s]{8,})[\"']"
)
PHONE = re.compile(rb"(?<!\d)1[3-9]\d{9}(?!\d)")
ID_CARD = re.compile(
    rb"(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])"
    rb"(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)"
)
EMAIL = re.compile(rb"\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")
QQ_NUMBER = re.compile(
    rb"(?i)\bqq(?:\s*(?:number|no\.?))?\s*[:=]\s*([1-9][0-9]{4,11})\b"
)
# Labeled chat identifiers: bot/owner QQ numbers, group ids, cookie uins, and
# the CLI/watermark/allowlist forms that carry them. The labels are narrow on
# purpose so ordinary type annotations and short numeric ids do not match.
QQ_NUMERIC_LABEL = re.compile(
    rb"(?i)(?<![\w-])(?:self_qq|group_id|group|user_id|target|friend|uin)"
    rb"[\"']?\s*[:=]\s*[\"']?([1-9][0-9]{4,11})(?![0-9])"
)
QQ_COOKIE_LABEL = re.compile(
    rb"(?i)\b(?:self_cookie_uin|p_uin|uin)"
    rb"[\"']?\s*[:=]\s*[\"']?(o[0-9]{5,11})(?![0-9])"
)
QQ_NORMALIZE_UIN = re.compile(
    rb"(?i)\bnormalize_uin\s*\(\s*[\"'](o[0-9]{5,11})[\"']"
)
QQ_CLI_TARGET = re.compile(
    rb"(?i)--(?:group|friend)\b[\"']?\s*[,=]?\s*[\"']?([1-9][0-9]{4,11})(?![0-9])"
)
QQ_ALLOWLIST = re.compile(
    rb"(?i)\b(?:peer|group)_allowlist\s*[:=]\s*[\[(]([^\])]*)[\])]"
)
QQ_VALUE = re.compile(rb"(?<![0-9])o?[1-9][0-9]{4,11}(?![0-9])")

# Synthetic fixture ids used by the public tree. Security-critical: never add a
# live account or group id here, because every value listed is exempted.
SAFE_QQ_IDS = frozenset(
    {
        b"10001",
        b"10002",
        b"10003",
        b"12345",
        b"123456",
        b"445566",
        b"12345678",
        b"123456789",
        b"1234567890",
        b"1000000001",
        b"1000000002",
        b"20001",
        b"20002",
    }
)
SAFE_COOKIE_UINS = frozenset({b"o010001", b"o010002"})
# Fixed Unix-second fixtures that also look like 10-digit chat ids. This is a
# pinned list, not a numeric range: exempting a whole range would hide a real
# account whose number happens to fall inside it.
SAFE_QQ_TIMESTAMPS = frozenset({b"1700000000", b"1761331200"})
WINDOWS_USER_PATH = re.compile(
    rb"[A-Za-z]:\\{1,2}Users\\{1,2}([^\\\r\n\t\"'`,;)]{1,64})"
)
# Any other absolute Windows drive path. ``Users`` is deliberately excluded:
# those paths are counted by ``windows_user_path`` and must not be double
# counted here. The first segment requires at least two path characters so
# ordinary source-code escapes such as ``"key:\\n value"`` do not match.
WINDOWS_DRIVE_PATH = re.compile(
    rb"(?<![A-Za-z0-9])[A-Za-z]:\\{1,2}(?!Users(?:\\|/))"
    rb"([A-Za-z0-9_][A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+)*"
    rb"(?:\\[^\\\r\n\t\"'`,;)]*)*)"
)
WSL_USER_PATH = re.compile(
    rb"/mnt/[A-Za-z]/Users/([^/\\\r\n\t\"'`,;)]{1,64})"
)
# Any other WSL host mount path (``/mnt/<drive>/...``). ``Users`` is excluded
# for the same reason as above: it belongs to ``wsl_user_path``.
WSL_PATH = re.compile(
    rb"/mnt/[A-Za-z]/(?!Users/)([^/\\\r\n\t\"'`,;)]{1,64})"
)
HOME_PATH = re.compile(rb"/home/([A-Za-z0-9._-]{1,64})/")
# Decimal coordinate pairs. Both values must carry at least three fractional
# digits; the separator accepts ASCII or full-width commas. Either lat,lon or
# lon,lat order is accepted because real dumps differ.
GPS_COORD = re.compile(
    rb"(?<![\d.])(-?\d{1,3}\.\d{3,8})\s*(?:,|\xef\xbc\x8c)\s*(-?\d{1,3}\.\d{3,8})(?![\d.])"
)

# Narrative terms that identify the project owner or their private life. They
# are stored as escaped code points so this module can itself pass the public
# export scanner without an exemption. Keep the list short and reviewed; every
# entry is a hard blocker when it appears in an allowed file.
_PERSONAL_LITERAL_TEXTS = (
    "\u73cd\u59ae",
    "\u897f\u590f\u5885",
    "\u7259\u9f88\u51fa\u8840",
    "C \u8bed\u8a00\u4e66",
    "C\u8bed\u8a00\u4e66",
    "\u5e38\u5dde\u4f4f\u5904",
    "\u8d3a\u5438\u547c",
    "\u4e13\u8f6c\u672c",
)
PERSONAL_LITERALS = tuple(text.encode("utf-8") for text in _PERSONAL_LITERAL_TEXTS)

PLACEHOLDER_MARKERS = (
    b"test",
    b"fake",
    b"dummy",
    b"example",
    b"sample",
    b"placeholder",
    b"changeme",
    b"change-me",
    b"your",
    b"xxx",
    b"***",
    b"redacted",
    b"none",
    b"null",
    b"wrong",
    b"invalid",
    b"default",
    b"demo",
    b"admin",
    b"user",
)

# Canonical Chinese test numbers and obvious fillers. A real mobile number is
# still reported; these values exist in fixtures and documentation examples.
SAFE_PHONES = frozenset(
    {
        b"12345678901",
        b"13000000000",
        b"13100000000",
        b"13200000000",
        b"13300000000",
        b"13400000000",
        b"13500000000",
        b"13600000000",
        b"13700000000",
        b"13800000000",
        b"13800138000",
        b"13812345678",
        b"13900000000",
        b"13912345678",
        b"15000000000",
        b"15100000000",
        b"15200000000",
        b"15500000000",
        b"15600000000",
        b"15700000000",
        b"15800000000",
        b"15900000000",
        b"18000000000",
        b"18100000000",
        b"18200000000",
        b"18300000000",
        b"18400000000",
        b"18500000000",
        b"18600000000",
        b"18700000000",
        b"18800000000",
        b"18888888888",
        b"18900000000",
        b"19999999999",
    }
)

SAFE_EMAIL_DOMAINS = frozenset(
    {
        b"example.com",
        b"example.org",
        b"example.net",
        b"example.invalid",
        b"test.invalid",
    }
)

PERSONAL_EMAIL_DOMAINS = frozenset(
    {
        b"qq.com",
        b"163.com",
        b"126.com",
        b"gmail.com",
        b"outlook.com",
        b"hotmail.com",
        b"foxmail.com",
        b"yahoo.com",
        b"icloud.com",
        b"me.com",
        b"sina.com",
        b"sohu.com",
        b"yeah.net",
        b"139.com",
        b"aliyun.com",
        b"protonmail.com",
        b"proton.me",
        b"gmx.com",
        b"yandex.com",
        b"aol.com",
        b"live.com",
        b"msn.com",
        b"zoho.com",
    }
)

SAFE_EMAIL_LOCALS = frozenset(
    {
        b"test",
        b"user",
        b"example",
        b"admin",
        b"info",
        b"support",
        b"noreply",
        b"no-reply",
        b"git",
        b"bot",
        b"contact",
        b"hello",
        b"team",
        b"security",
        b"mail",
        b"root",
    }
)

SAFE_WINDOWS_USERS = frozenset(
    {
        b"test",
        b"user",
        b"username",
        b"runner",
        b"admin",
        b"administrator",
        b"public",
        b"default",
        b"demo",
        b"example",
        b"node",
        b"app",
        b"your",
        b"yourname",
        b"your_name",
        b"name",
        b"home",
        b"dir",
        b"path",
    }
)

# Generic Windows roots used by the documentation and by cross-platform test
# fixtures. These are placeholders, system/toolchain locations, or obvious
# sample directories, not a machine-specific user path. The public placeholder
# roots are ``C:\Kinship`` and ``D:\Kinship``; ``%LOCALAPPDATA%`` is not a
# drive-letter path at all.
SAFE_WINDOWS_PATH_PREFIXES = tuple(
    value.lower()
    for value in (
        r"C:\Kinship",
        r"D:\Kinship",
        r"C:\Program Files",
        r"C:\Windows",
        r"C:\Python",
        r"C:\Apps",
        r"C:\app",
        r"C:\models",
        r"C:\repo",
        r"C:\project",
        r"C:\notes",
    )
)

SAFE_HOME_USERS = frozenset(
    {
        b"test",
        b"user",
        b"username",
        b"runner",
        b"node",
        b"app",
        b"admin",
        b"administrator",
        b"demo",
        b"example",
        b"u",
        b"vscode",
        b"linuxbrew",
    }
)

# Public city-center fixtures used by UI/collector tests. They are landmarks,
# not a private location, so the scanner treats them as neutral sample data.
SAFE_GPS_POINTS: frozenset[tuple[float, float]] = frozenset(
    {
        (39.9042, 116.4074),
        (31.2304, 121.4737),
        (22.5431, 114.0579),
    }
)
