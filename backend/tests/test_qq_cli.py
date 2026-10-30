from __future__ import annotations

import asyncio
import importlib.util
import time
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "ai"
    / "skills"
    / "qq-cli"
    / "qq_cli.py"
)


def _load_cli() -> ModuleType:
    spec = importlib.util.spec_from_file_location("qq_cli_test_module", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = _load_cli()


def test_parser_requires_a_target() -> None:
    parser = cli._build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["history"])


def test_parser_rejects_both_targets() -> None:
    parser = cli._build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["history", "--group", "10003", "--friend", "10002"])


def test_parser_maps_history_flags() -> None:
    parser = cli._build_parser()
    args = parser.parse_args([
        "history",
        "--group",
        "10003",
        "--unread",
        "--compact",
        "--mark-read",
        "--count",
        "5",
        "--format",
        "json",
    ])
    assert args.command == "history"
    assert args.group == "10003"
    assert args.friend is None
    assert args.unread is True
    assert args.compact is True
    assert args.mark_read is True
    assert args.count == 5
    assert args.since_minutes is None
    assert args.format == "json"
    assert args.json is False


def test_parser_json_alias() -> None:
    parser = cli._build_parser()
    args = parser.parse_args(["history", "--friend", "10002", "--json"])
    assert args.json is True
    assert args.format == "markdown"


def test_run_history_json_alias_maps_to_json(monkeypatch: pytest.MonkeyPatch) -> None:
    from services import qq_mcp_server

    seen: list[object] = []

    async def fake_group(params: object) -> str:
        seen.append(params.response_format)
        return "ok"

    monkeypatch.setattr(qq_mcp_server, "qq_get_group_msg_history", fake_group)
    args = cli._build_parser().parse_args(
        ["history", "--group", "10003", "--json"]
    )
    assert asyncio.run(cli._run_history(args)) == "ok"
    assert seen == [qq_mcp_server.ResponseFormat.JSON]


def test_parser_defaults() -> None:
    parser = cli._build_parser()
    args = parser.parse_args(["history", "--friend", "10002"])
    assert args.group is None
    assert args.friend == "10002"
    assert args.unread is False
    assert args.compact is False
    assert args.mark_read is False
    assert args.count == 50
    assert args.format == "markdown"


def test_main_prints_tool_output(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    async def fake_run(args: object) -> str:
        return "history-output"

    monkeypatch.setattr(cli, "_run_history", fake_run)
    assert cli.main(["history", "--group", "10003"]) == 0
    captured = capsys.readouterr()
    assert captured.out.strip() == "history-output"
    assert captured.err == ""


def test_main_reports_errors(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    async def fake_run(args: object) -> str:
        raise RuntimeError("boom")

    monkeypatch.setattr(cli, "_run_history", fake_run)
    assert cli.main(["history", "--group", "10003"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.strip() == "qq: boom"


def test_tools_lists_all_operations(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["tools"]) == 0
    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 23
    assert any(line.startswith("qq_send_message\t") for line in lines)
    assert any(line.startswith("qq_like_qzone\t") for line in lines)


def test_call_rejects_unknown_tool(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["call", "nope", "--input", "{}"]) == 1
    assert "unknown tool" in capsys.readouterr().err


def test_call_invokes_registered_tool(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from services import qq_mcp_server

    async def fake_login(params: object) -> str:
        return "login-ok"

    monkeypatch.setattr(qq_mcp_server, "qq_get_login_info", fake_login)
    assert cli.main(["call", "qq_get_login_info", "--input", "{}"]) == 0
    assert capsys.readouterr().out.strip() == "login-ok"


def test_send_builds_message(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from services import qq_mcp_server

    seen: list[object] = []

    async def fake_send(params: object) -> str:
        seen.append(params)
        return "sent"

    monkeypatch.setattr(qq_mcp_server, "qq_send_message", fake_send)
    assert cli.main(["send", "--group", "10003", "--text", "hi"]) == 0
    assert len(seen) == 1
    params = seen[0]
    assert params.message_type == qq_mcp_server.MessageType.GROUP
    assert params.target_id == "10003"
    assert params.message == "hi"
    assert capsys.readouterr().out.strip() == "sent"


def test_send_file_builds_input(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    from services import qq_mcp_server

    file_path = tmp_path / "pic.png"
    file_path.write_bytes(b"\x89PNG\r\n\x1a\n")
    seen: list[object] = []

    async def fake_send_file(params: object) -> str:
        seen.append(params)
        return "file-sent"

    monkeypatch.setattr(qq_mcp_server, "qq_send_file", fake_send_file)
    assert (
        cli.main(
            ["send-file", "--group", "10003", "--file", str(file_path)]
        )
        == 0
    )
    assert len(seen) == 1
    assert seen[0].file_path == str(file_path)
    assert seen[0].target_id == "10003"
    assert capsys.readouterr().out.strip() == "file-sent"


@pytest.mark.parametrize(
    ("value", "expected"),
    [("30m", 1800.0), ("2h", 7200.0), ("45s", 45.0), ("1d", 86400.0)],
)
def test_parse_duration(value: str, expected: float) -> None:
    assert cli._parse_duration(value) == expected


def test_parser_maps_water_on_flags() -> None:
    args = cli._build_parser().parse_args(
        ["water", "on", "--group", "10003", "--ttl", "5m", "--threshold", "8"]
    )
    assert args.command == "water"
    assert args.water_action == "on"
    assert args.group == "10003"
    assert args.ttl == "5m"
    assert args.threshold == 8.0


class _FakeGateway:
    def __init__(self, state: object) -> None:
        self.state = state
        self.posts: list[tuple[str, dict[str, object]]] = []
        self.gets: list[tuple[str, object]] = []

    async def post(self, path: str, body: dict[str, object]) -> object:
        self.posts.append((path, body))
        return body

    async def get(self, path: str, params: object = None) -> object:
        self.gets.append((path, params))
        return self.state


def _fake_gateway(monkeypatch: pytest.MonkeyPatch, state: object) -> _FakeGateway:
    from services import qq_mcp_server

    fake = _FakeGateway(state)
    monkeypatch.setattr(qq_mcp_server, "client", fake)
    return fake


def test_water_on_posts_water_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _fake_gateway(monkeypatch, {})
    args = cli._build_parser().parse_args(
        ["water", "on", "--group", "10003", "--ttl", "5m", "--threshold", "8"]
    )
    before = time.time()
    asyncio.run(cli._run_water(args))
    after = time.time()
    path, body = fake.posts[0]
    assert path == "/v1/water-state"
    assert body["group_id"] == "10003"
    assert body["mode"] == "water"
    assert body["threshold"] == 8.0
    assert before + 300 <= body["water_until"] <= after + 300


def test_water_off_restores_mentions(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _fake_gateway(monkeypatch, {})
    args = cli._build_parser().parse_args(["water", "off", "--group", "10003"])
    asyncio.run(cli._run_water(args))
    assert fake.posts[0] == (
        "/v1/water-state",
        {"group_id": "10003", "mode": "mentions", "water_until": 0},
    )


def test_water_mute_posts_mute_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _fake_gateway(monkeypatch, {})
    args = cli._build_parser().parse_args(["water", "mute", "--group", "10003"])
    asyncio.run(cli._run_water(args))
    assert fake.posts[0] == (
        "/v1/water-state",
        {"group_id": "10003", "mode": "mute"},
    )


def test_water_status_reads_one_group(monkeypatch: pytest.MonkeyPatch) -> None:
    state = {
        "group_id": "10003",
        "mode": "water",
        "threshold": 8.0,
        "water_until": 1234567890,
        "last_wake_at": 0,
    }
    fake = _fake_gateway(monkeypatch, state)
    args = cli._build_parser().parse_args(["water", "status", "--group", "10003"])
    output = asyncio.run(cli._run_water(args))
    assert fake.gets[0] == ("/v1/water-state", {"group_id": "10003"})
    assert "mode=water" in output
    assert "threshold=8.0" in output


def test_water_list_reads_all_groups(monkeypatch: pytest.MonkeyPatch) -> None:
    states = [
        {
            "group_id": "10003",
            "mode": "water",
            "threshold": 12.0,
            "water_until": 1234567890,
            "last_wake_at": 0,
        }
    ]
    fake = _fake_gateway(monkeypatch, states)
    args = cli._build_parser().parse_args(["water", "list"])
    output = asyncio.run(cli._run_water(args))
    assert fake.gets[0] == ("/v1/water-state", None)
    assert "10003" in output


def test_water_list_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_gateway(monkeypatch, [])
    args = cli._build_parser().parse_args(["water", "list"])
    assert asyncio.run(cli._run_water(args)) == "(no water states)"
