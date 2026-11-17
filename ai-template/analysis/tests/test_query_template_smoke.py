"""模板空库冒烟：query.py 在模板 AI 根上的契约、弃用闸门与空结果 schema。

模板的 `data/index/` 带 `DEPRECATED` 标记（索引层已冻结）：默认路径下的
event/observation/report/evidence 四个 scope 必须拒绝读取；要验证空结果 schema，
就把空的 JSONL 表复制到临时目录、用 `--index-dir` 显式指向副本。
这里不造业务数据，也不用任何个人内容。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

AI_ROOT = Path(__file__).resolve().parents[2]
QUERY = AI_ROOT / "analysis" / "query.py"
INDEX_DIR = AI_ROOT / "data" / "index"
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


def _index_copy(tmp_path: Path) -> Path:
    """复制空索引表（不带 DEPRECATED 标记），模拟明确的考古副本。"""
    target = tmp_path / "index"
    target.mkdir()
    for path in INDEX_DIR.glob("*.jsonl"):
        shutil.copyfile(path, target / path.name)
    meta = INDEX_DIR / "index.meta.json"
    if meta.exists():
        shutil.copyfile(meta, target / meta.name)
    assert not (target / "DEPRECATED").exists()
    return target


def test_default_index_is_deprecated_and_refused() -> None:
    result = _run("--scope", "all", "--allow-full-scan", "--format", "json")
    assert result.returncode == 1, result.stdout
    assert "deprecated" in result.stderr
    assert "stratum query" in result.stderr


def test_query_all_json_on_empty_index_copy(tmp_path: Path) -> None:
    result = _run(
        "--scope", "all", "--allow-full-scan",
        "--index-dir", str(_index_copy(tmp_path)), "--format", "json",
    )
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


def test_query_memory_scope_does_not_read_deprecated_index() -> None:
    result = _run("--scope", "memory", "--grep", "睡眠", "--format", "json")
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["query"]["scopes"] == ["memory"]
    assert "deprecated" not in result.stderr


def test_query_all_without_filters_requires_allow_full_scan() -> None:
    result = _run("--scope", "all", "--format", "json")
    assert result.returncode == 2
    assert "allow-full-scan" in result.stderr


def test_query_scope_accepts_comma_and_slash(tmp_path: Path) -> None:
    index_dir = _index_copy(tmp_path)
    for value in ("event,observation", "event/observation"):
        result = _run(
            "--scope", value, "--allow-full-scan",
            "--index-dir", str(index_dir), "--format", "json",
        )
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        assert payload["query"]["scopes"] == ["event", "observation"]
        assert payload["counts"]["total"] == 0


def test_query_all_include_linked_evidence_expands_layer(tmp_path: Path) -> None:
    result = _run(
        "--scope", "all", "--allow-full-scan",
        "--index-dir", str(_index_copy(tmp_path)),
        "--include-linked-evidence", "--format", "json",
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["query"]["scopes"] == [
        "event", "observation", "report", "evidence",
    ]
    assert payload["counts"]["total"] == 0
