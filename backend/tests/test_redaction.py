# -*- coding: utf-8 -*-
"""日志脱敏原语测试。"""

import logging
import sys

from core.redaction import (
    RedactingFormatter,
    SecretRedactionFilter,
    install_uvicorn_redaction,
    is_secret_path,
    mask_secret,
    redact_text,
)


SETUP_TOKEN = "0123456789abcdef" * 4


def test_mask_secret_short_values_are_fully_hidden():
    assert mask_secret("") == "***"
    assert mask_secret("abc") == "***"
    assert mask_secret("12345678") == "***"


def test_mask_secret_keeps_first_and_last_four_characters():
    assert mask_secret("abcdefghijkl") == "abcd...ijkl"
    assert mask_secret("secret-token-1234", visible=3) == "sec...234"


def test_redact_text_masks_authorization_header():
    text = "Authorization: Bearer abc123SECRET"

    redacted = redact_text(text)

    assert "abc123SECRET" not in redacted
    assert "Bearer ***" in redacted


def test_redact_text_masks_query_token_parameters():
    text = "GET /ws?token=SECRET-TOKEN&access_token=ACCESS-SECRET&x=1"

    redacted = redact_text(text)

    assert "SECRET-TOKEN" not in redacted
    assert "ACCESS-SECRET" not in redacted
    assert "?token=***" in redacted
    assert "access_token=***" in redacted
    assert "&x=1" in redacted


def test_redact_text_masks_jwt_and_known_key_prefixes():
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2ln"
    text = f"{jwt} sk-live-SECRET tvly-tavily-SECRET xai-grok-SECRET"

    redacted = redact_text(text)

    assert jwt not in redacted
    assert "sk-live-SECRET" not in redacted
    assert "tvly-tavily-SECRET" not in redacted
    assert "xai-grok-SECRET" not in redacted


def test_redact_text_masks_cookie_user_and_pass_token():
    text = "Cookie: theme=dark; userId=alice; passToken=COOKIE-SECRET; lang=zh"

    redacted = redact_text(text)

    assert "alice" not in redacted
    assert "COOKIE-SECRET" not in redacted
    assert "theme=dark" in redacted


def test_redact_text_keeps_bare_hex_setup_token_readable():
    redacted = redact_text(f"[Auth] 引导令牌文件已就绪: {SETUP_TOKEN}")

    assert SETUP_TOKEN in redacted


def test_is_secret_path_detects_secret_suffixes():
    assert is_secret_path("loom.token")
    assert is_secret_path("api.mimo_key")
    assert is_secret_path("opencode.server_password")
    assert is_secret_path("health.cloud.credential")
    assert is_secret_path("auth.apiKey")


def test_is_secret_path_excludes_non_secret_suffixes_and_setup_require_token():
    for path in (
        "loom.token_env",
        "loom.token_file",
        "loom.token_path",
        "loom.token_url",
        "auth.token_ttl",
        "api.key_enabled",
        "api.key_count",
        "auth.setup_require_token",
        "ssl.key",
        "p2p.allow_shared_token",
    ):
        assert not is_secret_path(path), path


def test_secret_redaction_filter_redacts_message_and_arguments():
    record = logging.LogRecord(
        "test",
        logging.INFO,
        __file__,
        1,
        "token=%s data=%s",
        ("?token=MSG-SECRET", {"Authorization": "Bearer DICT-SECRET"}),
        None,
    )

    SecretRedactionFilter().filter(record)

    message = record.getMessage()
    assert "MSG-SECRET" not in message
    assert "DICT-SECRET" not in message


def test_redacting_formatter_redacts_exception_text():
    try:
        raise RuntimeError("failed with sk-live-EXC-SECRET")
    except RuntimeError:
        record = logging.LogRecord(
            "test", logging.ERROR, __file__, 1, "boom", (), sys.exc_info()
        )

    output = RedactingFormatter("%(message)s").format(record)

    assert "sk-live-EXC-SECRET" not in output
    assert "boom" in output


def test_install_uvicorn_redaction_is_idempotent():
    install_uvicorn_redaction()
    install_uvicorn_redaction()

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        filters = [
            f
            for f in logging.getLogger(name).filters
            if isinstance(f, SecretRedactionFilter)
        ]
        assert len(filters) == 1
