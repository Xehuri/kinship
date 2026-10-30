"""memory_claims 的回归测试（临时仓库，不碰真实 ai/memory）。"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import memory_claims as claims

UPDATED_AT = "2099-01-01T00:00:00+08:00"


def _claim(subject="用户", predicate="likes", object_="测试", **overrides):
    row = {
        "claim_id": claims.derive_claim_id(subject, predicate, object_),
        "version": 1,
        "subject": subject,
        "predicate": predicate,
        "object": object_,
        "status": "active",
        "confidence": "certain",
        "valid_from": "2099-01-01",
        "source": {
            "path": "ai/memory/source.md",
            "line": 1,
            "quote": "示例城市",
        },
        "supersedes": None,
        "projection_targets": ["profile/core-lite.md#他是谁"],
        "updated_at": UPDATED_AT,
    }
    row.update(overrides)
    return row


def _repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    source = root / "ai/memory/source.md"
    source.parent.mkdir(parents=True)
    source.write_text("第一行\n示例城市\n第三行\n", encoding="utf-8")
    return root


def _write(root: Path, rows: list[dict]) -> Path:
    path = root / "ai/memory/claims/claims.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered = sorted(rows, key=lambda row: row["claim_id"])
    path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in ordered) + "\n",
        encoding="utf-8",
    )
    return path


def test_valid_claim_has_no_findings(tmp_path):
    root = _repo(tmp_path)
    path = _write(root, [_claim()])

    result = claims.check_claims(root, path)
    summary = result.summary()

    assert result.findings == ()
    assert summary["ok"] is True
    assert summary["claims"] == 1
    assert summary["active"] == 1
    assert summary["unsourced"] == 0
    assert summary["schema_errors"] == 0
    assert summary["cycles"] == 0


def test_invalid_schema_rejects_unknown_field(tmp_path):
    root = _repo(tmp_path)
    row = _claim()
    row["unexpected"] = True
    path = _write(root, [row])

    result = claims.check_claims(root, path)

    assert result.summary()["ok"] is False
    assert any("extra: unexpected" in finding.message for finding in result.findings)


def test_missing_required_field_is_schema_error(tmp_path):
    root = _repo(tmp_path)
    row = _claim()
    del row["confidence"]
    path = _write(root, [row])

    result = claims.check_claims(root, path)

    assert result.summary()["schema_errors"] >= 1
    assert any("missing: confidence" in finding.message for finding in result.findings)
    assert any("confidence must be one of" in finding.message for finding in result.findings)


def test_missing_source_object_is_unsourced(tmp_path):
    root = _repo(tmp_path)
    row = _claim()
    row["source"] = None
    path = _write(root, [row])

    result = claims.check_claims(root, path)

    assert result.summary()["unsourced"] == 1
    assert any(finding.category == "source" for finding in result.findings)


def test_missing_source_file_is_unsourced(tmp_path):
    root = _repo(tmp_path)
    row = _claim()
    row["source"] = {
        "path": "ai/memory/absent.md",
        "line": 1,
        "quote": "示例城市",
    }
    path = _write(root, [row])

    result = claims.check_claims(root, path)

    assert result.summary()["unsourced"] == 1
    assert any("does not exist" in finding.message for finding in result.findings)


def test_source_line_out_of_range_is_unsourced(tmp_path):
    root = _repo(tmp_path)
    row = _claim()
    row["source"] = {
        "path": "ai/memory/source.md",
        "line": 99,
        "quote": "示例城市",
    }
    path = _write(root, [row])

    result = claims.check_claims(root, path)

    assert result.summary()["unsourced"] == 1
    assert any("outside" in finding.message for finding in result.findings)


def test_quote_mismatch_is_unsourced(tmp_path):
    root = _repo(tmp_path)
    row = _claim()
    row["source"] = {
        "path": "ai/memory/source.md",
        "line": 1,
        "quote": "源文件中没有这句话",
    }
    path = _write(root, [row])

    result = claims.check_claims(root, path)

    assert result.summary()["unsourced"] == 1
    assert any("not found" in finding.message for finding in result.findings)


def test_duplicate_claim_id_is_reported(tmp_path):
    root = _repo(tmp_path)
    path = _write(root, [_claim(), _claim()])

    result = claims.check_claims(root, path)

    assert result.summary()["duplicate_ids"] == 1
    assert any(finding.category == "duplicate" for finding in result.findings)


def test_supersede_cycle_is_reported(tmp_path):
    root = _repo(tmp_path)
    first = _claim(object_="甲")
    second = _claim(object_="乙")
    first["supersedes"] = second["claim_id"]
    second["supersedes"] = first["claim_id"]
    path = _write(root, [first, second])

    result = claims.check_claims(root, path)

    assert result.summary()["cycles"] == 1
    assert any(finding.category == "supersede_cycle" for finding in result.findings)


def test_status_enum_is_enforced(tmp_path):
    root = _repo(tmp_path)
    path = _write(root, [_claim(status="archived")])

    result = claims.check_claims(root, path)

    assert any("status must be one of" in finding.message for finding in result.findings)


def test_confidence_enum_is_enforced(tmp_path):
    root = _repo(tmp_path)
    path = _write(root, [_claim(confidence="maybe")])

    result = claims.check_claims(root, path)

    assert any(
        "confidence must be one of" in finding.message for finding in result.findings
    )


def test_list_active_returns_only_active_claims(tmp_path):
    root = _repo(tmp_path)
    active = _claim(object_="甲")
    retired = _claim(object_="乙", status="retired")
    path = _write(root, [active, retired])

    rows = claims.list_active(path)

    assert [row["claim_id"] for row in rows] == [active["claim_id"]]


def test_cli_check_returns_one_on_invalid_claim(tmp_path, capsys):
    root = _repo(tmp_path)
    path = _write(root, [_claim(status="archived")])

    code = claims.main(
        ["check", "--root", str(root), "--claims", "ai/memory/claims/claims.jsonl"]
    )
    payload = json.loads(capsys.readouterr().out)

    assert code == 1
    assert payload["ok"] is False
    assert payload["claims"] == 1


def test_seed_claims_clean_20_active_zero_findings(tmp_path):
    root = _repo(tmp_path)
    rows = [_claim(object_=f"示例事实{index}") for index in range(1, 21)]
    path = _write(root, rows)

    result = claims.check_claims(root, path)
    summary = result.summary()

    assert summary["ok"] is True
    assert summary["claims"] == 20
    assert summary["active"] == 20
    assert summary["unsourced"] == 0
    assert summary["schema_errors"] == 0
    assert summary["duplicate_ids"] == 0
    assert summary["cycles"] == 0
    assert summary["errors"] == 0
    assert {claim.data["status"] for claim in result.claims} == {"active"}
    assert {claim.data["updated_at"] for claim in result.claims} == {UPDATED_AT}
