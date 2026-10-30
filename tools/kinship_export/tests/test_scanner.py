"""Behavioral tests for the public-export content scanner.

PII fixtures are assembled at runtime on purpose: this test module is itself part
of the exported public tree, so a literal path, coordinate pair, or narrative
term in the source would be scanned (and rejected) by the export gate.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from tools.kinship_export import scanner


def _categories(content: bytes) -> set[str]:
    return {hit.category for hit in scanner.scan_bytes(content, "backend/leak.py")}


def _counts(content: bytes) -> dict[str, int]:
    return {hit.category: hit.count for hit in scanner.scan_bytes(content, "backend/leak.py")}


def _profile_fixture() -> bytes:
    return b"\n".join(
        (
            b"name: Example User",
            b"height: 170 cm; weight: 60 kg; sleep: 6h; steps: 8000",
            wsl_user_path(),
            gps_lat_lon(),
            personal_literal(),
        )
    )


def wsl_user_path() -> bytes:
    return b"/mnt/" + b"d/Users/" + b"realperson/Desktop/project"


def windows_user_path() -> bytes:
    return b"C:\\" + b"Users\\" + b"realperson\\Desktop"


def windows_drive_path() -> bytes:
    return b"D:\\" + b"ProgramData\\miniconda3\\python.exe"


def wsl_path() -> bytes:
    return b"/mnt/" + b"d/tmp-opencode/project"


def unix_home_path() -> bytes:
    return b"/home/" + b"realperson" + b"/project"


def gps_lat_lon() -> bytes:
    return b"31." + b"77392,120." + b"04417"


def gps_lon_lat() -> bytes:
    return b"120." + b"04417, 31." + b"77392"


def gps_two_decimals_only() -> bytes:
    return b"31.77,120.04"


def personal_literal() -> bytes:
    return "\u73cd\u59ae".encode("utf-8")


def test_scan_detects_wsl_user_path() -> None:
    assert "wsl_user_path" in _categories(wsl_user_path())


def test_scan_detects_other_wsl_host_mount_paths() -> None:
    assert _counts(wsl_path()) == {"wsl_path": 1}


def test_scan_detects_windows_and_home_user_paths() -> None:
    assert "windows_user_path" in _categories(windows_user_path())
    assert "home_path" in _categories(unix_home_path())


def test_scan_detects_other_windows_drive_paths() -> None:
    assert _counts(windows_drive_path()) == {"windows_drive_path": 1}


def test_scan_does_not_double_count_user_paths() -> None:
    content = wsl_user_path() + b"\n" + windows_user_path()

    counts = _counts(content)

    assert counts.get("wsl_user_path") == 1
    assert counts.get("windows_user_path") == 1
    assert "wsl_path" not in counts
    assert "windows_drive_path" not in counts


def test_scan_detects_gps_pair_in_both_orders() -> None:
    for fixture in (gps_lat_lon, gps_lon_lat):
        hits = _counts(fixture())
        assert hits.get("gps_coord") == 1


@pytest.mark.parametrize(
    "term",
    [
        "\u73cd\u59ae",
        "\u897f\u590f\u5885",
        "\u7259\u9f88\u51fa\u8840",
        "C \u8bed\u8a00\u4e66",
        "\u5e38\u5dde\u4f4f\u5904",
        "\u8d3a\u5438\u547c",
        "\u4e13\u8f6c\u672c",
    ],
)
def test_scan_detects_each_personal_literal(term: str) -> None:
    assert "personal_literal" in _categories(term.encode("utf-8"))


def test_scan_detects_combined_profile_fixture() -> None:
    hits = _categories(_profile_fixture())

    assert {"wsl_user_path", "gps_coord", "personal_literal"} <= hits


@pytest.mark.parametrize(
    "fixture",
    [
        lambda: b"C:\\" + b"Users\\" + b"test\\project",
        lambda: b"C:\\" + b"Users\\" + b"Public\\project",
        lambda: b"/mnt/" + b"c/Users/Public/project",
        lambda: b"/srv/" + b"kinship/staging",
        lambda: b"<TMP_DIR>" + b"/staging",
        lambda: b"C:\\" + b"Kinship\\var",
        lambda: b"D:\\" + b"Kinship\\var",
        lambda: b"%LOCALAPPDATA%" + b"\\Kinship",
        lambda: b'"key:\\n  value"',
        lambda: b"0.000000,0.000000",
        lambda: b"0.100000,-0.100000",
        lambda: b"<lat>,<lon>",
        lambda: b"gps: 39.9042,116.4074",
        lambda: b"version 1.2.3, build 4.5.6",
    ],
)
def test_scan_ignores_placeholders_and_neutral_fixtures(
    fixture: Callable[[], bytes],
) -> None:
    hits = _categories(fixture())

    assert not {
        "wsl_user_path",
        "wsl_path",
        "windows_user_path",
        "windows_drive_path",
        "gps_coord",
        "personal_literal",
    } & hits


def test_scan_does_not_whitelist_the_live_username() -> None:
    # Regression: the safe-user tables must never contain the project owner's
    # account name, otherwise /mnt/<drive>/Users/<owner>/ escapes scanning.
    owner = "Ax" + "euh"
    content = (
        (b"/mnt/" + b"d/Users/" + owner.encode("ascii") + b"/Desktop")
        + b"\n"
        + (b"/home/" + owner.lower().encode("ascii") + b"/")
        + b"\n"
        + (b"C:\\Users\\" + owner.encode("ascii"))
    )

    assert "wsl_user_path" in _categories(content)
    assert "home_path" in _categories(content)
    assert "windows_user_path" in _categories(content)


def test_scan_ignores_low_precision_decimal_pairs() -> None:
    assert "gps_coord" not in _categories(gps_two_decimals_only())


def test_scan_does_not_echo_matched_values() -> None:
    value = wsl_user_path()
    hits = scanner.scan_bytes(value, "backend/leak.py")

    assert hits
    assert all(value.decode("ascii") not in hit.path for hit in hits)


def real_bot_qq() -> bytes:
    return b"3940" + b"961536"


def real_owner_qq() -> bytes:
    return b"2176" + b"284372"


def real_group_qq() -> bytes:
    return b"2219" + b"45468"


def real_cookie_uin() -> bytes:
    return b"o" + b"0394" + b"0961536"


@pytest.mark.parametrize(
    "fixture",
    [
        lambda: b'SELF_QQ = "' + real_bot_qq() + b'"',
        lambda: b'SELF_COOKIE_UIN = "' + real_cookie_uin() + b'"',
        lambda: b"uin=" + real_cookie_uin() + b"; skey=x",
        lambda: b'"uin": "' + real_cookie_uin() + b'"',
        lambda: b'"p_uin": "' + real_cookie_uin() + b'"',
        lambda: b"group_id=" + real_group_qq(),
        lambda: b'group_id="' + real_group_qq() + b'"',
        lambda: b'"group_id": "' + real_group_qq() + b'"',
        lambda: b'user_id="' + real_owner_qq() + b'"',
        lambda: b'"user_id": "' + real_owner_qq() + b'"',
        lambda: b"--group " + real_group_qq(),
        lambda: b'--group "' + real_group_qq() + b'"',
        lambda: b"--group=" + real_group_qq(),
        lambda: b'["--group", "' + real_group_qq() + b'"]',
        lambda: b"--friend " + real_owner_qq(),
        lambda: b"--friend=" + real_owner_qq(),
        lambda: b'"--friend", "' + real_owner_qq() + b'"',
        lambda: b"friend:" + real_owner_qq(),
        lambda: b"group:" + real_group_qq(),
        lambda: b'"target": "' + real_group_qq() + b'"',
        lambda: b'normalize_uin("' + real_cookie_uin() + b'")',
        lambda: b'peer_allowlist: ["' + real_owner_qq() + b'"]',
        lambda: b'group_allowlist: ["' + real_group_qq() + b'"]',
    ],
)
def test_scan_detects_labeled_qq_identifiers(fixture: Callable[[], bytes]) -> None:
    assert _counts(fixture()).get("qq_identifier") == 1


@pytest.mark.parametrize(
    "fixture",
    [
        lambda: b'SELF_QQ = "10001"',
        lambda: b'SELF_COOKIE_UIN = "o010001"',
        lambda: b"uin=o010001; skey=x",
        lambda: b'"p_uin": "o010001"',
        lambda: b'"uin": 20001',
        lambda: b'group_id="10003"',
        lambda: b'"user_id": "10002"',
        lambda: b'"group_id": "123456"',
        lambda: b'"user_id": "445566"',
        lambda: b'group_id="10002"',
        lambda: b"--group \"10003\"",
        lambda: b"--friend 10002",
        lambda: b"friend:10002",
        lambda: b"group:10003",
        lambda: b'"target": "10003"',
        lambda: b'normalize_uin("o010001") == "10001"',
        lambda: b'peer_allowlist: ["10001", "10002", "10003"]',
        lambda: b"last_time=1700000000.0",
        lambda: b'"time": 1761331200',
        lambda: b'"user_id": 123',
        lambda: b'group_id="g1"',
    ],
)
def test_scan_ignores_safe_synthetic_identifiers(fixture: Callable[[], bytes]) -> None:
    assert "qq_identifier" not in _categories(fixture())


@pytest.mark.parametrize(
    "value",
    [
        "10001",
        "10002",
        "10003",
        "123456",
        "445566",
        "o010001",
        "o010002",
        "12345678",
        "123456789",
        "1234567890",
        "1000000001",
        "1000000002",
        "20001",
        "20002",
        "1700000000",
        "1761331200",
    ],
)
def test_scan_ignores_required_safe_values_on_every_label(value: str) -> None:
    token = value.encode()
    content = b"\n".join(
        (
            b'group_id="' + token + b'"',
            b"--group " + token,
            b'peer_allowlist: ["' + token + b'"]',
            b"uin=" + token,
        )
    )

    assert "qq_identifier" not in _categories(content)


@pytest.mark.parametrize("timestamp", [b"1700000000", b"1761331200"])
def test_scan_ignores_unix_timestamps_on_identifier_labels(timestamp: bytes) -> None:
    content = b"\n".join(
        (
            b'self_qq: "' + timestamp + b'"',
            b'group_id="' + timestamp + b'"',
            b'"user_id": "' + timestamp + b'"',
            b"--group " + timestamp,
            b"--friend " + timestamp,
            b"friend:" + timestamp,
            b'"target": "' + timestamp + b'"',
            b'peer_allowlist: ["' + timestamp + b'"]',
            b"uin=" + timestamp,
        )
    )

    assert "qq_identifier" not in _categories(content)


def test_scan_ignores_safe_sequential_ids_and_placeholders() -> None:
    content = b"\n".join(
        (
            b'self_qq: "1234567890"',
            b"self_qq: '12345678'",
            b"self_qq: '123456789'",
            b'peer_allowlist: ["1000000001"]',
            b'--group 1000000002',
        )
    )

    assert "qq_identifier" not in _categories(content)


def test_scan_ignores_identifier_like_prose_and_types() -> None:
    content = b"\n".join(
        (
            b"group_id=group_id",
            b"user_id: int",
            b"target: str",
            b"friend: None",
            b"message_id=1001",
        )
    )

    assert "qq_identifier" not in _categories(content)
