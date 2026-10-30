"""memory_project 的回归测试（tmp_path 造树，绝不写真实 ai/memory）。"""

import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import memory_project as project
from memory_claims_lib import derive_claim_id

FIXED_AT = "2026-10-23T00:00:00+08:00"
CLAIMS_REL = "ai/memory/claims/claims.jsonl"

CORE_LITE = """# core-lite

## 他是谁

- 示例人物，现居示例城市。

## 学业

- 示例学校，示例专业。

## 关系

- 示例联系人。

## 硬禁忌

- 示例禁忌。

## 偏好

- 审美简单整洁。

## 健康 / 作息

- 工作日起床端 06:20~06:46。

## 地点

- 住处片区：示例片区甲 / 示例片区乙（宿舍）。

## 当前事项

- 示例项目系统。

## 来源

- core.md
"""

BIDU = """# 必读

## 当前主线

- 主线一项。

## 当前任务

- 无。

## 红线

- 未检出≠没做。

## 关系/状态

- 无。
"""

INDEX = """# 话题索引

| 话题 | 最近讨论 | 当前一句话结论 | 文件 |
|---|---|---|---|
| 系统定位 | 2026-10-20 | 只服务他一人 | `系统.md` |
"""


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    memory = root / "ai/memory"
    _write(memory / "self/必读.md", BIDU)
    _write(memory / "profile/core-lite.md", CORE_LITE)
    _write(memory / "topics/INDEX.md", INDEX)
    _write(memory / "claims/claims.jsonl", "")
    return root


def _claim(
    object_: str,
    targets: list[str],
    *,
    subject: str = "用户",
    predicate: str = "likes",
    quote: str = "core-lite",
) -> dict:
    return {
        "claim_id": derive_claim_id(subject, predicate, object_),
        "version": 1,
        "subject": subject,
        "predicate": predicate,
        "object": object_,
        "status": "active",
        "confidence": "certain",
        "valid_from": "2099-01-01",
        "source": {
            "path": "ai/memory/profile/core-lite.md",
            "line": 1,
            "quote": quote,
        },
        "supersedes": None,
        "projection_targets": targets,
        "updated_at": FIXED_AT,
    }


def _write_claims(root: Path, rows: list[dict]) -> Path:
    path = root / CLAIMS_REL
    ordered = sorted(rows, key=lambda row: row["claim_id"])
    _write(
        path,
        "\n".join(json.dumps(row, ensure_ascii=False) for row in ordered) + "\n",
    )
    return path


def _snapshot(root: Path) -> dict[str, bytes]:
    memory = root / "ai/memory"
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(memory.rglob("*"))
        if path.is_file()
    }


def _generate(root: Path, tmp_path: Path, name: str = "out") -> dict:
    return project.generate(root, CLAIMS_REL, tmp_path / name, FIXED_AT)


def test_missing_claim_line_is_inserted_under_target_heading(tmp_path):
    root = _repo(tmp_path)
    claim = _claim("仅服务用户一人", ["profile/core-lite.md#当前事项"])
    _write_claims(root, [claim])

    status = _generate(root, tmp_path)
    candidate = (tmp_path / "out/core-lite.candidate.md").read_text(encoding="utf-8")
    line = "- 仅服务用户一人"

    assert line in candidate
    section = candidate.split("## 当前事项", 1)[1].split("## 来源", 1)[0]
    assert section.count(line) == 1
    assert status["changed_lines"] == 1
    assert status["stale"] == [
        {
            "claim_id": claim["claim_id"],
            "target": "profile/core-lite.md#当前事项",
            "object": "仅服务用户一人",
        }
    ]


def test_present_claim_is_left_unchanged(tmp_path):
    root = _repo(tmp_path)
    claim = _claim("示例人物", ["profile/core-lite.md#他是谁"])
    _write_claims(root, [claim])

    status = _generate(root, tmp_path)
    candidate = (tmp_path / "out/core-lite.candidate.md").read_text(encoding="utf-8")

    assert candidate.count("示例人物") == 1
    assert claim["claim_id"] not in candidate
    assert status["changed_lines"] == 0
    assert status["stale"] == []


def test_inserted_claims_follow_claim_id_order(tmp_path):
    root = _repo(tmp_path)
    claims = [
        _claim("乙事实", ["profile/core-lite.md#当前事项"], predicate="p2"),
        _claim("甲事实", ["profile/core-lite.md#当前事项"], predicate="p1"),
    ]
    _write_claims(root, claims)

    _generate(root, tmp_path)
    candidate = (tmp_path / "out/core-lite.candidate.md").read_text(encoding="utf-8")
    ordered_objects = [
        row["object"] for row in sorted(claims, key=lambda row: row["claim_id"])
    ]
    positions = [candidate.index(object_) for object_ in ordered_objects]

    assert positions == sorted(positions)


def test_generation_never_writes_source_files(tmp_path):
    root = _repo(tmp_path)
    _write_claims(root, [_claim("仅服务用户一人", ["profile/core-lite.md#当前事项"])])
    before = _snapshot(root)

    _generate(root, tmp_path)

    assert _snapshot(root) == before
    assert (tmp_path / "out/必读.candidate.md").is_file()
    assert (tmp_path / "out/core-lite.candidate.md").is_file()
    assert (tmp_path / "out/INDEX.candidate.md").is_file()


def test_claims_hash_and_outputs_are_deterministic(tmp_path):
    root = _repo(tmp_path)
    claims_path = _write_claims(
        root, [_claim("仅服务用户一人", ["profile/core-lite.md#当前事项"])]
    )

    first = _generate(root, tmp_path, "out1")
    second = _generate(root, tmp_path, "out2")

    assert first == second
    assert (tmp_path / "out1/projection-status.json").read_bytes() == (
        tmp_path / "out2/projection-status.json"
    ).read_bytes()
    for name in ("必读.candidate.md", "core-lite.candidate.md", "INDEX.candidate.md", "diff.patch"):
        assert (tmp_path / "out1" / name).read_bytes() == (tmp_path / "out2" / name).read_bytes()
    assert first["claims_hash"] == hashlib.sha256(claims_path.read_bytes()).hexdigest()
    assert first["source_hashes"]["profile/core-lite.md"] == hashlib.sha256(
        (root / "ai/memory/profile/core-lite.md").read_bytes()
    ).hexdigest()


def test_missing_target_file_fails_loudly(tmp_path):
    root = _repo(tmp_path)
    (root / "ai/memory/profile/core-lite.md").unlink()

    with pytest.raises(project.ProjectionError, match="missing target file"):
        _generate(root, tmp_path)


def test_unknown_target_warns_and_skips_whole_claim(tmp_path):
    root = _repo(tmp_path)
    unknown_only = _claim(
        "只写未知文件", ["profile/other.md#长期基线"], predicate="p1"
    )
    mixed = _claim(
        "混合目标事实",
        ["profile/core-lite.md#偏好", "topics/OTHER.md#不存在"],
        predicate="p2",
    )
    _write_claims(root, [unknown_only, mixed])

    status = _generate(root, tmp_path)
    candidate = (tmp_path / "out/core-lite.candidate.md").read_text(encoding="utf-8")

    assert status["changed_lines"] == 0
    assert any(
        unknown_only["claim_id"] in warning and "unknown projection target" in warning
        for warning in status["warnings"]
    )
    assert any(mixed["claim_id"] in warning for warning in status["warnings"])
    assert "只写未知文件" not in candidate
    assert "混合目标事实" not in candidate


SEMANTIC_HEALTH = """# 健康基线

## 长期基线（07-28 起跟踪）

- 既有睡眠基线。

## 数据口径规则（防误读）

- 既有口径。
"""

SEMANTIC_EXAM = """# 事项/示例备考

## 目标与考情（稳定真值）

- 目标：示例目标院校。
"""


def test_semantic_targets_get_candidates_at_same_relative_paths(tmp_path):
    root = _repo(tmp_path)
    _write(root / "ai/memory/profile/semantic/健康基线.md", SEMANTIC_HEALTH)
    _write(root / "ai/memory/profile/semantic/事项/示例备考.md", SEMANTIC_EXAM)
    health = _claim(
        "新增睡眠事实",
        ["profile/semantic/健康基线.md#长期基线07-28-起跟踪"],
        predicate="p1",
    )
    exam = _claim(
        "新增考情事实",
        ["profile/semantic/事项/示例备考.md#目标与考情稳定真值"],
        predicate="p2",
    )
    _write_claims(root, [health, exam])

    status = _generate(root, tmp_path)

    health_path = tmp_path / "out/profile/semantic/健康基线.candidate.md"
    exam_path = tmp_path / "out/profile/semantic/事项/示例备考.candidate.md"
    assert health_path.is_file()
    assert exam_path.is_file()
    assert "- 新增睡眠事实" in health_path.read_text(encoding="utf-8")
    assert "- 新增考情事实" in exam_path.read_text(encoding="utf-8")
    assert status["candidate_paths"] == {
        "self/必读.md": "必读.candidate.md",
        "profile/core-lite.md": "core-lite.candidate.md",
        "topics/INDEX.md": "INDEX.candidate.md",
        "profile/semantic/事项/示例备考.md": "profile/semantic/事项/示例备考.candidate.md",
        "profile/semantic/健康基线.md": "profile/semantic/健康基线.candidate.md",
    }
    assert status["changed_lines"] == 2
    assert status["warnings"] == []
    assert status["stale"] == sorted(
        [
            {
                "claim_id": health["claim_id"],
                "target": "profile/semantic/健康基线.md#长期基线07-28-起跟踪",
                "object": "新增睡眠事实",
            },
            {
                "claim_id": exam["claim_id"],
                "target": "profile/semantic/事项/示例备考.md#目标与考情稳定真值",
                "object": "新增考情事实",
            },
        ],
        key=lambda item: (item["claim_id"], item["target"]),
    )
    diff = (tmp_path / "out/diff.patch").read_text(encoding="utf-8")
    assert "--- a/ai/memory/profile/semantic/健康基线.md" in diff
    assert "--- a/ai/memory/profile/semantic/事项/示例备考.md" in diff


def test_unified_diff_uses_repo_relative_memory_paths():
    patch = project._unified_diff("self/必读.md", "old\n", "new\n")

    assert patch.startswith(
        "--- a/ai/memory/self/必读.md\n+++ b/ai/memory/self/必读.md\n"
    )


def test_semantic_heading_mismatch_warns_without_writing_candidate(tmp_path):
    root = _repo(tmp_path)
    _write(root / "ai/memory/profile/semantic/健康基线.md", SEMANTIC_HEALTH)
    claim = _claim(
        "长期基线旧 slug", ["profile/semantic/健康基线.md#长期基线"], predicate="p1"
    )
    _write_claims(root, [claim])

    status = _generate(root, tmp_path)

    assert status["changed_lines"] == 0
    assert status["stale"] == []
    assert any(
        claim["claim_id"] in warning and "unknown projection target" in warning
        for warning in status["warnings"]
    )
    candidate = tmp_path / "out/profile/semantic/健康基线.candidate.md"
    assert candidate.read_text(encoding="utf-8") == SEMANTIC_HEALTH


def test_missing_semantic_file_warns_and_skips_claim(tmp_path):
    root = _repo(tmp_path)
    claim = _claim(
        "缺失语义文件事实", ["profile/semantic/不存在.md#长期基线"], predicate="p1"
    )
    _write_claims(root, [claim])

    status = _generate(root, tmp_path)

    assert status["changed_lines"] == 0
    assert any(
        claim["claim_id"] in warning and "missing projection target file" in warning
        for warning in status["warnings"]
    )
    assert "profile/semantic/不存在.md" not in status["candidate_paths"]


def test_status_and_diff_shape(tmp_path):
    root = _repo(tmp_path)
    claim = _claim("仅服务用户一人", ["profile/core-lite.md#当前事项"])
    _write_claims(root, [claim])

    status = _generate(root, tmp_path)

    assert set(status) == {
        "schema_version",
        "built_at",
        "claims_path",
        "claims_hash",
        "source_hashes",
        "stale",
        "changed_lines",
        "candidate_paths",
        "warnings",
    }
    assert status["schema_version"] == 1
    assert status["built_at"] == FIXED_AT
    assert status["claims_path"] == CLAIMS_REL
    assert status["candidate_paths"] == {
        "self/必读.md": "必读.candidate.md",
        "profile/core-lite.md": "core-lite.candidate.md",
        "topics/INDEX.md": "INDEX.candidate.md",
    }
    for name in status["candidate_paths"].values():
        assert (tmp_path / "out" / name).is_file()

    diff = (tmp_path / "out/diff.patch").read_text(encoding="utf-8")
    assert diff.startswith("--- a/ai/memory/profile/core-lite.md\n+++ b/ai/memory/profile/core-lite.md\n")
    assert "+- 仅服务用户一人\n" in diff
    assert "self/必读.md" not in diff
    assert "topics/INDEX.md" not in diff


def test_repeated_generation_merges_predicate_lines_without_claim_ids(tmp_path):
    root = _repo(tmp_path)
    core = CORE_LITE.replace(
        "- 审美简单整洁。",
        "- 说话方式（长期要求）：要可爱温柔一点、多配表情包。",
    ).replace(
        "- 示例项目系统。",
        "- 示例项目系统（成品给示例联系人，当前只服务他）。",
    )
    _write(root / "ai/memory/profile/core-lite.md", core)
    claims = [
        _claim(
            "可爱温柔＋配表情包",
            ["profile/core-lite.md#偏好"],
            predicate="communication_style",
        ),
        _claim(
            "仅服务用户一人",
            ["profile/core-lite.md#当前事项"],
            predicate="deployment_scope",
        ),
    ]
    _write_claims(root, claims)

    first = _generate(root, tmp_path, "first")
    first_text = (tmp_path / "first/core-lite.candidate.md").read_text(encoding="utf-8")
    second = project.generate(root, CLAIMS_REL, tmp_path / "second", FIXED_AT)
    second_text = (tmp_path / "second/core-lite.candidate.md").read_text(encoding="utf-8")

    assert first_text == core
    assert first_text == second_text
    assert "claim_" not in first_text
    assert first["changed_lines"] == 0
    assert second["changed_lines"] == 0


def test_existing_predicate_line_is_updated_in_place(tmp_path):
    root = _repo(tmp_path)
    core = CORE_LITE.replace(
        "- 审美简单整洁。",
        "- 说话方式（长期要求）：旧的表达。",
    )
    _write(root / "ai/memory/profile/core-lite.md", core)
    claim = _claim(
        "可爱温柔＋配表情包",
        ["profile/core-lite.md#偏好"],
        predicate="communication_style",
    )
    _write_claims(root, [claim])

    status = _generate(root, tmp_path)
    candidate = (tmp_path / "out/core-lite.candidate.md").read_text(encoding="utf-8")
    section = candidate.split("## 偏好", 1)[1].split("## 健康 / 作息", 1)[0]

    assert "说话方式（长期要求）：旧的表达。（可爱温柔＋配表情包）" in section
    assert section.count("说话方式") == 1
    assert "claim_" not in candidate
    assert status["changed_lines"] == 1
