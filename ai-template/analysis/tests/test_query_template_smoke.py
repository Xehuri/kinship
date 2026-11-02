"""模板空库冒烟：query.py 必须能在模板自带的空索引上正常返回。

模板只保留空的 data/index 表，因此这里不造业务数据，也不用任何个人内容；
只验证 CLI 契约、空结果 schema 与全量扫描保护。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

AI_ROOT = Path(__file__).resolve().parents[2]
QUERY = AI_ROOT / "analysis" / "query.py"
EXPECTED_TOP_LEVEL = {
    "schema_version", "query", "counts", "groups", "items", "warnings", "bytes",
}
EXPECTED_COUNTS = {
    "total", "returned", "by_scope", "deduped", "omitted_by_limit",
    "omitted_by_budget", "truncated",
}


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(QUERY), "--root", str(AI_ROOT), *args],
        cwd=str(AI_ROOT),
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_query_all_json_on_empty_template_tables() -> None:
    result = _run("--scope", "all", "--allow-full-scan", "--format", "json")
    assert result.returncode == 0, result.stderr

    payload = json.loads(result.stdout)
    assert set(payload) == EXPECTED_TOP_LEVEL
    assert payload["schema_version"] == 1
    assert set(payload["counts"]) == EXPECTED_COUNTS
    assert payload["counts"]["total"] == 0
    assert payload["counts"]["returned"] == 0
    assert payload["counts"]["by_scope"] == {}
    assert payload["counts"]["deduped"] == 0
    assert payload["items"] == []
    assert payload["groups"] == []
    assert payload["bytes"] == 0
    assert payload["query"]["scopes"] == ["event", "observation", "report"]
    assert any("memory skipped" in warning for warning in payload["warnings"])
    assert any("chat skipped" in warning for warning in payload["warnings"])


def test_query_all_without_filters_requires_allow_full_scan() -> None:
    result = _run("--scope", "all", "--format", "json")
    assert result.returncode == 2
    assert "allow-full-scan" in result.stderr


def test_query_scope_accepts_comma_and_slash() -> None:
    for value in ("event,observation", "event/observation"):
        result = _run("--scope", value, "--allow-full-scan", "--format", "json")
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        assert payload["query"]["scopes"] == ["event", "observation"]
        assert payload["counts"]["total"] == 0


def test_query_all_include_linked_evidence_expands_layer() -> None:
    result = _run(
        "--scope", "all", "--allow-full-scan",
        "--include-linked-evidence", "--format", "json",
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["query"]["scopes"] == [
        "event", "observation", "report", "evidence",
    ]
    assert payload["counts"]["total"] == 0




def _run_request(payload: dict) -> subprocess.CompletedProcess[str]:
    body = {"root": str(AI_ROOT), **payload}
    return subprocess.run(
        [sys.executable, str(QUERY), "--request", json.dumps(body, ensure_ascii=False)],
        cwd=str(AI_ROOT),
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_query_request_mode_success_on_empty_tables() -> None:
    result = _run_request({"scope": "all", "allow_full_scan": True})
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["ok"] is True
    assert payload["counts"]["total"] == 0
    assert payload["counts"]["returned"] == 0
    assert any("memory skipped" in warning for warning in payload["warnings"])
    assert any("chat skipped" in warning for warning in payload["warnings"])


def test_query_request_mode_error_is_json() -> None:
    result = _run_request({"bogus": 1})
    assert result.returncode == 2
    assert result.stderr == ""
    payload = json.loads(result.stdout)
    assert payload["ok"] is False
    assert payload["error"]["type"] == "InvalidRequest"
