# -*- coding: utf-8 -*-
"""日志脱敏工具：遮盖密钥、令牌与常见凭证。

红线：启动日志允许出现完整的 64 位十六进制引导令牌（仅供管理员在服务器
上读取），因此裸十六进制串不做脱敏；其余已知形态一律替换为 ``***``。
"""

import logging
import re
from typing import Any, Mapping

_PLACEHOLDER = "***"

_AUTH_HEADER_RE = re.compile(
    r"(?i)\b(authorization[\"']?\s*[:=]\s*[\"']?\s*(?:bearer|basic)\s+)([^\s,;\"']+)"
)
_QUERY_SECRET_RE = re.compile(
    r"(?i)([?&](?:access_token|ws_token|passToken|pass_token|api_key|token|ticket"
    r"|key|secret|sig|signature|password|passwd)=)([^&\s#\"']+)"
)
_COOKIE_HEADER_RE = re.compile(
    r"(?i)\b(cookie[\"']?\s*[:=]\s*[\"']?)([^\r\n\"']+)"
)
_COOKIE_SECRET_RE = re.compile(r"(?i)\b(userId|passToken)=([^;\s,]+)")
_JWT_RE = re.compile(
    r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"
)
_PREFIX_SECRET_RE = re.compile(r"\b(?:sk|tvly|xai)-[A-Za-z0-9_-]{2,}")

_SECRET_SUFFIXES = ("token", "key", "secret", "password", "credential", "credentials")
_PATH_EXCLUDED_EXACT = {"setup_require_token"}
_PATH_EXCLUDED_FULL = {"ssl.key", "p2p.allow_shared_token"}
_PATH_EXCLUDED_SUFFIXES = (
    "_env",
    "_file",
    "_path",
    "_url",
    "_ttl",
    "_enabled",
    "_count",
)


def mask_secret(value: str, visible: int = 4) -> str:
    """遮盖密钥，仅保留首尾各 ``visible`` 个字符。"""
    if not isinstance(value, str) or not value or visible <= 0:
        return _PLACEHOLDER
    if len(value) <= visible * 2:
        return _PLACEHOLDER
    return f"{value[:visible]}...{value[-visible:]}"


def _redact_cookie_header(match: re.Match[str]) -> str:
    prefix, header = match.group(1), match.group(2)
    return f"{prefix}{_redact_cookie_value(header)}"


def _redact_cookie_value(header: str) -> str:
    return _COOKIE_SECRET_RE.sub(
        lambda m: f"{m.group(1)}={_PLACEHOLDER}", header
    )


def redact_text(text: str) -> str:
    """遮盖文本中的 Authorization、查询参数、Cookie、JWT 与常见密钥前缀。"""
    if not isinstance(text, str) or not text:
        return text

    text = _AUTH_HEADER_RE.sub(
        lambda m: f"{m.group(1)}{_PLACEHOLDER}", text
    )
    text = _COOKIE_HEADER_RE.sub(_redact_cookie_header, text)
    text = _QUERY_SECRET_RE.sub(
        lambda m: f"{m.group(1)}{_PLACEHOLDER}", text
    )
    text = _JWT_RE.sub(_PLACEHOLDER, text)
    text = _PREFIX_SECRET_RE.sub(_PLACEHOLDER, text)
    return text


def is_secret_path(path: str) -> bool:
    """判断配置键名是否承载密钥（按最后一段键名匹配）。"""
    if not path or not isinstance(path, str):
        return False
    normalized = path.strip().lower()
    if normalized in _PATH_EXCLUDED_FULL:
        return False
    name = normalized.split(".")[-1].strip()
    if not name:
        return False
    if name in _PATH_EXCLUDED_EXACT:
        return False
    if name.endswith(_PATH_EXCLUDED_SUFFIXES):
        return False
    return name.endswith(_SECRET_SUFFIXES)


def _redact_mapping(mapping: Mapping[Any, Any]) -> dict[Any, Any]:
    result: dict[Any, Any] = {}
    for key, value in mapping.items():
        if isinstance(key, str):
            lowered = key.strip().lower()
            if lowered in {"authorization", "proxy-authorization"}:
                result[key] = _PLACEHOLDER
                continue
            if lowered in {"cookie", "set-cookie"} and isinstance(value, str):
                result[key] = _redact_cookie_value(value)
                continue
            if is_secret_path(key):
                result[key] = _PLACEHOLDER
                continue
        result[key] = redact_value(value)
    return result


def redact_value(value: Any) -> Any:
    """递归脱敏 dict/list 中的字符串，并按密钥类键名遮盖整个值。"""
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, Mapping):
        return _redact_mapping(value)
    if isinstance(value, (list, tuple, set, frozenset)):
        return [redact_value(item) for item in value]
    return value


def _redact_arg(arg: Any) -> Any:
    if isinstance(arg, str):
        return redact_text(arg)
    if isinstance(arg, Mapping):
        return _redact_mapping(arg)
    return arg


class SecretRedactionFilter(logging.Filter):
    """在日志记录进入 Handler 前脱敏消息模板与参数。"""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_text(record.msg)
        args = record.args
        if isinstance(args, Mapping):
            record.args = _redact_mapping(args)
        elif isinstance(args, tuple):
            record.args = tuple(_redact_arg(arg) for arg in args)
        elif isinstance(args, str):
            record.args = redact_text(args)
        return True


class RedactingFormatter(logging.Formatter):
    """对最终格式化结果（含 traceback）统一脱敏。"""

    def format(self, record: logging.LogRecord) -> str:
        return redact_text(super().format(record))


_REDACTION_FILTER = SecretRedactionFilter()
_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")


def install_uvicorn_redaction() -> None:
    """为 uvicorn 三个 logger 安装脱敏过滤器（幂等）。"""
    for name in _UVICORN_LOGGERS:
        target = logging.getLogger(name)
        if not any(isinstance(f, SecretRedactionFilter) for f in target.filters):
            target.addFilter(_REDACTION_FILTER)
