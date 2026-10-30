"""message_anchor 的回归测试（全部在 tmp_path 造源文件，不碰真实 ai/）。"""

import json
import sys
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import message_anchor as anchors

TZ = timezone(timedelta(hours=8))
CREATED_AT = "2099-01-01T00:00:00+08:00"


def _ms(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=TZ).timestamp() * 1000)


def _write_chatlog(
    root: Path,
    rel: str,
    session_id: str,
    lines: list[str],
    start: str = "00:00:00",
    end: str = "23:59:00",
    date: str = "2099-01-01",
) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"# 会话对话 ({date} {start} ~ {date} {end})\n"
        f"会话: {session_id}\n"
        f"共 {len(lines)} 条消息\n\n"
        + "\n".join(lines)
        + "\n",
        encoding="utf-8",
    )
    return path


def _write_jsonl(root: Path, rel: str, records: list[dict]) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n",
        encoding="utf-8",
    )
    return path


def _target(
    source: str,
    quote: str,
    time_ms: int,
    session_id: str,
    role: str = "user",
    verify_terms: tuple[str, ...] = ("事实",),
) -> anchors.Target:
    return anchors.Target(
        anchor_id=anchors.anchor_id_for(session_id, time_ms, role, quote),
        source=source,
        quote=quote,
        time_ms=time_ms,
        session_id=session_id,
        verify_terms=verify_terms,
    )


def _paths(root: Path) -> tuple[Path, Path]:
    return (
        root / anchors.DEFAULT_TARGETS,
        root / anchors.DEFAULT_ANCHORS,
    )


def _fixture(tmp_path: Path) -> tuple[Path, tuple[anchors.Target, ...], tuple[Path, Path]]:
    root = tmp_path / "repo"
    text_source = "ai-template/data/cache/chatlog_tmp/20990101_main.log"
    jsonl_source = "ai-template/.loom/session/loom-main.jsonl"
    _write_chatlog(
        root,
        text_source,
        "ses_text",
        [
            "[09:00:00] 用户: 我住在宿舍，晚上回示例城市",
            "[09:00:30] AI: 明白",
        ],
    )
    jsonl_time = _ms("2099-01-02T13:01:55")
    _write_jsonl(
        root,
        jsonl_source,
        [
            {
                "t": "entry",
                "sid": "ses_jsonl",
                "e": {
                    "id": "entry-1",
                    "parentId": None,
                    "seq": 1,
                    "entry": {
                        "kind": "message",
                        "message": {
                            "role": "user",
                            "content": (
                                "<{项目名称}-system>\n{}\n</{项目名称}-system>\n\n"
                                "【QQ私聊】 示例用户 13:01\n"
                                "你以后说话可以可爱，温柔一点嘛，正好配上表情包"
                            ),
                            "timestamp": jsonl_time,
                        },
                    },
                },
            }
        ],
    )
    targets = (
        _target(
            text_source,
            "我住在宿舍，晚上回示例城市",
            _ms("2099-01-01T09:00:00"),
            "ses_text",
            verify_terms=("宿舍", "示例城市"),
        ),
        _target(
            jsonl_source,
            "你以后说话可以可爱，温柔一点嘛，正好配上表情包",
            jsonl_time,
            "ses_jsonl",
            verify_terms=("可爱", "温柔", "表情包"),
        ),
    )
    return root, targets, _paths(root)


def test_derive_and_verify_roundtrip(tmp_path):
    root, targets, (targets_path, anchors_path) = _fixture(tmp_path)
    anchors.dump_targets(targets_path, targets)

    rows = anchors.derive_anchors(
        root, targets_path, anchors_path, created_at=CREATED_AT
    )

    assert len(rows) == 2
    assert [row.anchor_id for row in rows] == [target.anchor_id for target in targets]
    assert all(row.status == "active" for row in rows)
    assert all(row.created_at == CREATED_AT for row in rows)
    assert rows[0].role == "user"
    assert rows[0].normalized_sha256 == anchors.normalized_sha256_for(rows[0].quote)
    assert rows[1].quote == targets[1].quote

    result = anchors.verify_anchors(root, anchors_path, targets_path)

    assert result.ok is True
    assert result.verified == 2
    assert result.duplicates == 0
    assert result.missing_sources == 0
    assert result.findings == ()


def test_duplicate_anchor_is_rejected(tmp_path):
    root, targets, (targets_path, anchors_path) = _fixture(tmp_path)
    anchors.dump_targets(targets_path, targets[:1])
    anchors.derive_anchors(root, targets_path, anchors_path, created_at=CREATED_AT)
    first_line = anchors_path.read_text(encoding="utf-8").splitlines()[0]
    with anchors_path.open("a", encoding="utf-8") as handle:
        handle.write(first_line + "\n")

    result = anchors.verify_anchors(root, anchors_path, targets_path)

    assert result.ok is False
    assert result.duplicates >= 1
    assert any(finding.category == "duplicate" for finding in result.findings)


def test_quote_mismatch_is_rejected(tmp_path):
    root, targets, (targets_path, anchors_path) = _fixture(tmp_path)
    anchors.dump_targets(targets_path, targets[:1])
    anchors.derive_anchors(root, targets_path, anchors_path, created_at=CREATED_AT)
    anchors.dump_targets(
        targets_path, [replace(targets[0], quote="这条引文不在源文件里")]
    )

    result = anchors.verify_anchors(root, anchors_path, targets_path)

    assert result.ok is False
    assert result.verified == 0
    assert any(finding.category == "quote" for finding in result.findings)


def test_missing_source_is_reported(tmp_path):
    root, targets, (targets_path, anchors_path) = _fixture(tmp_path)
    anchors.dump_targets(targets_path, targets[:1])
    anchors.derive_anchors(root, targets_path, anchors_path, created_at=CREATED_AT)
    anchors.dump_targets(
        targets_path,
        [replace(targets[0], source="ai-template/data/cache/chatlog_tmp/absent.log")],
    )

    result = anchors.verify_anchors(root, anchors_path, targets_path)

    assert result.ok is False
    assert result.missing_sources == 1
    assert any(finding.category == "source" for finding in result.findings)


def test_timestamp_mismatch_is_rejected(tmp_path):
    root, targets, (targets_path, anchors_path) = _fixture(tmp_path)
    anchors.dump_targets(targets_path, targets[:1])
    anchors.derive_anchors(root, targets_path, anchors_path, created_at=CREATED_AT)
    anchors.dump_targets(
        targets_path, [replace(targets[0], time_ms=targets[0].time_ms + 1000)]
    )

    result = anchors.verify_anchors(root, anchors_path, targets_path)

    assert result.ok is False
    assert result.verified == 0
    assert any(finding.category == "timestamp" for finding in result.findings)


def test_derived_id_must_match_target(tmp_path):
    root, targets, (targets_path, anchors_path) = _fixture(tmp_path)
    anchors.dump_targets(
        targets_path, [replace(targets[0], anchor_id="msg_000000000000")]
    )

    with pytest.raises(anchors.AnchorError):
        anchors.derive_anchors(
            root, targets_path, anchors_path, created_at=CREATED_AT
        )


def test_normalize_is_deterministic_and_strips_punctuation():
    assert anchors.normalize("  你好，世界！\n") == "你好世界"
    assert anchors.normalize("ＡＢＣ１２３") == "ABC123"
    assert anchors.normalize("a—b…c") == "abc"
    assert anchors.normalize("🐱") == "🐱"


def test_anchor_id_is_stable_and_depends_on_all_parts():
    first = anchors.anchor_id_for("ses_x", 1, "user", " 你好，世界！ ")
    same = anchors.anchor_id_for("ses_x", 1, "user", "你好世界")
    other_time = anchors.anchor_id_for("ses_x", 2, "user", "你好世界")
    other_role = anchors.anchor_id_for("ses_x", 1, "assistant", "你好世界")

    assert first == same
    assert len(first) == 16
    assert first.startswith("msg_")
    assert first != other_time
    assert first != other_role


def test_targets_yaml_roundtrip(tmp_path):
    _, targets, (targets_path, _) = _fixture(tmp_path)

    anchors.dump_targets(targets_path, targets)

    assert anchors.load_targets(targets_path) == targets
