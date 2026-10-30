#!/usr/bin/env python3
"""稳定消息锚点：把记忆里的事实钉到一条真实聊天消息上。

锚点 ID = msg_ + sha256(session_id|time_ms|role|normalize(quote)) 前 12 位十六进制。
derive 只读聊天记录文件（chatlog 文本档或 Loom session JSONL），生成 anchors.jsonl；
verify 重新读源文件，校验时间戳、会话、引文、唯一性与锚点是否缺失。仅用标准库。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Final, Sequence

_AI_DIR_NAME: Final = Path(__file__).resolve().parents[1].name
DEFAULT_TARGETS: Final = f"{_AI_DIR_NAME}/analysis/anchor_targets.yaml"
DEFAULT_ANCHORS: Final = f"{_AI_DIR_NAME}/memory/anchors/anchors.jsonl"
LOCAL_TZ: Final = timezone(timedelta(hours=8))
ANCHOR_ID_RE: Final = re.compile(r"^msg_[0-9a-f]{12}$")
SECTION_RE: Final = re.compile(
    r"^# 会话对话 \((?P<start>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"
    r" ~ (?P<end>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\)$"
)
SESSION_RE: Final = re.compile(r"^会话:\s*(?P<sid>\S+)")
MESSAGE_RE: Final = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\] (用户|AI): (.*)$")
ROLE_LABELS: Final = {"用户": "user", "AI": "assistant"}
TARGET_FIELDS: Final = (
    "anchor_id", "source", "quote", "time_ms", "session_id", "verify_terms",
)
ANCHOR_FIELDS: Final = (
    "anchor_id", "session_id", "time_ms", "role", "quote",
    "normalized_sha256", "source", "created_at", "status",
)


class AnchorError(ValueError):
    """锚点无法派生，或源文件格式不合法。"""


@dataclass(frozen=True, slots=True)
class SourceMessage:
    session_id: str
    time_ms: int
    role: str
    content: str
    line_no: int


@dataclass(frozen=True, slots=True)
class Target:
    anchor_id: str
    source: str
    quote: str
    time_ms: int
    session_id: str
    verify_terms: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Anchor:
    anchor_id: str
    session_id: str
    time_ms: int
    role: str
    quote: str
    normalized_sha256: str
    source: str
    created_at: str
    status: str


@dataclass(frozen=True, slots=True)
class Finding:
    category: str
    message: str
    anchor_id: str | None = None


@dataclass(frozen=True, slots=True)
class VerifyResult:
    targets: int
    verified: int
    duplicates: int
    missing_sources: int
    findings: tuple[Finding, ...]

    @property
    def ok(self) -> bool:
        return self.targets > 0 and self.verified == self.targets and not self.findings

    def summary(self) -> str:
        return (
            f"verified {self.verified}/{self.targets} anchors; "
            f"duplicates={self.duplicates}; "
            f"missing_sources={self.missing_sources}; "
            f"findings={len(self.findings)}"
        )


def normalize(text: str) -> str:
    """确定性归一化：NFKC 合并全半角，去掉空白、Unicode 标点与格式字符。

    保留大小写和符号（含 emoji），因此同一句子的全角/半角标点、空格、换行
    不会改变锚点。归一化结果只由输入文本决定，与运行环境无关。
    """
    folded = unicodedata.normalize("NFKC", text)
    return "".join(
        char
        for char in folded
        if not char.isspace()
        and unicodedata.category(char) != "Cf"
        and not unicodedata.category(char).startswith("P")
    )


def anchor_id_for(session_id: str, time_ms: int, role: str, quote: str) -> str:
    material = f"{session_id}|{int(time_ms)}|{role}|{normalize(quote)}"
    return "msg_" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:12]


def normalized_sha256_for(quote: str) -> str:
    return hashlib.sha256(normalize(quote).encode("utf-8")).hexdigest()


def _now_iso() -> str:
    return datetime.now(LOCAL_TZ).replace(microsecond=0).isoformat()


def _resolve_path(root: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else root / path


def _resolve_source(root: Path, relative: str) -> Path | None:
    if not relative or "\\" in relative:
        return None
    pure = PurePosixPath(relative)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    root_path = root.resolve()
    candidate = (root_path / pure).resolve()
    if candidate != root_path and root_path not in candidate.parents:
        return None
    return candidate


def _message_datetime(
    start: datetime, end: datetime, hour: int, minute: int, second: int
) -> datetime:
    candidate = start.replace(hour=hour, minute=minute, second=second, microsecond=0)
    if end.date() > start.date() and (hour, minute, second) < (
        start.hour, start.minute, start.second
    ):
        candidate += timedelta(days=(end.date() - start.date()).days)
    return candidate


def _read_text_source(path: Path) -> tuple[SourceMessage, ...]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise AnchorError(f"无法读取源文件 {path}: {exc}") from exc

    messages: dict[tuple[str, int, str, str], SourceMessage] = {}
    session_id: str | None = None
    start_dt: datetime | None = None
    end_dt: datetime | None = None
    pending: tuple[str, int, str, int] | None = None
    buffer: list[str] = []

    def flush() -> None:
        nonlocal pending, buffer
        if pending is None:
            buffer = []
            return
        sid, time_ms, role, line_no = pending
        content = "\n".join(buffer).rstrip("\n")
        key = (sid, time_ms, role, content)
        if key not in messages:
            messages[key] = SourceMessage(sid, time_ms, role, content, line_no)
        pending = None
        buffer = []

    for line_no, line in enumerate(lines, 1):
        section = SECTION_RE.match(line)
        if section:
            flush()
            start_dt = datetime.strptime(section.group("start"), "%Y-%m-%d %H:%M:%S")
            end_dt = datetime.strptime(section.group("end"), "%Y-%m-%d %H:%M:%S")
            continue
        session = SESSION_RE.match(line)
        if session:
            flush()
            session_id = session.group("sid")
            continue
        message = MESSAGE_RE.match(line)
        if message:
            flush()
            if session_id is None or start_dt is None or end_dt is None:
                raise AnchorError(f"{path}:{line_no}: 消息出现在会话头之前")
            hour, minute, second = (int(message.group(index)) for index in (1, 2, 3))
            stamp = _message_datetime(start_dt, end_dt, hour, minute, second)
            stamp = stamp.replace(tzinfo=LOCAL_TZ)
            pending = (
                session_id,
                int(stamp.timestamp() * 1000),
                ROLE_LABELS[message.group(4)],
                line_no,
            )
            buffer = [message.group(5)]
            continue
        if pending is not None:
            buffer.append(line)
    flush()
    return tuple(messages.values())


def _jsonl_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            part.get("text", "")
            for part in content
            if isinstance(part, dict)
            and part.get("type") == "text"
            and isinstance(part.get("text"), str)
        ]
        return "\n".join(parts)
    return ""


def _read_jsonl_source(path: Path) -> tuple[SourceMessage, ...]:
    messages: dict[tuple[str, int, str, str], SourceMessage] = {}
    try:
        with path.open(encoding="utf-8") as handle:
            for line_no, raw in enumerate(handle, 1):
                if not raw.strip():
                    continue
                try:
                    record = json.loads(raw)
                except json.JSONDecodeError as exc:
                    raise AnchorError(f"{path}:{line_no}: JSON 解析失败: {exc}") from exc
                if record.get("t") != "entry":
                    continue
                entry = record.get("e", {}).get("entry", {})
                if entry.get("kind") != "message":
                    continue
                message = entry.get("message", {})
                role = message.get("role")
                if role not in ("user", "assistant"):
                    continue
                session_id = record.get("sid")
                time_ms = message.get("timestamp")
                if not isinstance(session_id, str) or not session_id:
                    raise AnchorError(f"{path}:{line_no}: 消息缺少 sid")
                if not isinstance(time_ms, int) or isinstance(time_ms, bool):
                    raise AnchorError(f"{path}:{line_no}: 消息缺少毫秒时间戳")
                content = _jsonl_text(message.get("content"))
                key = (session_id, time_ms, role, content)
                if key not in messages:
                    messages[key] = SourceMessage(
                        session_id, time_ms, role, content, line_no
                    )
    except OSError as exc:
        raise AnchorError(f"无法读取源文件 {path}: {exc}") from exc
    return tuple(messages.values())


def read_source(path: Path) -> tuple[SourceMessage, ...]:
    if not path.is_file():
        raise AnchorError(f"源文件不存在: {path}")
    if path.suffix == ".jsonl":
        return _read_jsonl_source(path)
    return _read_text_source(path)


def _parse_scalar(raw: str, path: Path, line_no: int) -> Any:
    value = raw.strip()
    if not value:
        return ""
    if value.startswith(("\"", "[")):
        try:
            return json.loads(value)
        except json.JSONDecodeError as exc:
            raise AnchorError(f"{path}:{line_no}: YAML 标量解析失败: {exc}") from exc
    if value.startswith("'"):
        if not value.endswith("'") or len(value) < 2:
            raise AnchorError(f"{path}:{line_no}: 单引号未闭合")
        return value[1:-1].replace("''", "'")
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if value in ("true", "false"):
        return value == "true"
    if value in ("null", "~"):
        return None
    return value


def load_targets(path: Path) -> tuple[Target, ...]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise AnchorError(f"无法读取 targets 文件 {path}: {exc}") from exc

    rows: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    saw_targets = False
    for line_no, raw in enumerate(lines, 1):
        line = raw.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped == "targets:":
            saw_targets = True
            continue
        if not saw_targets:
            raise AnchorError(f"{path}:{line_no}: 缺少 targets: 顶层键")
        item = re.match(r"^\s*-\s+([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$", line)
        if item:
            if current is not None:
                rows.append(current)
            current = {
                item.group(1): _parse_scalar(item.group(2) or "", path, line_no)
            }
            continue
        field = re.match(r"^\s+([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$", line)
        if field and current is not None:
            key = field.group(1)
            if key in current:
                raise AnchorError(f"{path}:{line_no}: 字段重复: {key}")
            current[key] = _parse_scalar(field.group(2) or "", path, line_no)
            continue
        raise AnchorError(f"{path}:{line_no}: 无法解析 YAML 行")
    if current is not None:
        rows.append(current)
    if not saw_targets:
        raise AnchorError(f"{path}: 缺少 targets: 顶层键")

    targets: list[Target] = []
    for row in rows:
        if tuple(row) != TARGET_FIELDS:
            raise AnchorError(
                f"target 字段/顺序不符: 期望 {TARGET_FIELDS}，实际 {tuple(row)}"
            )
        anchor_id = row["anchor_id"]
        source = row["source"]
        quote = row["quote"]
        time_ms = row["time_ms"]
        session_id = row["session_id"]
        terms = row["verify_terms"]
        if not isinstance(anchor_id, str) or not ANCHOR_ID_RE.fullmatch(anchor_id):
            raise AnchorError("anchor_id 必须是 msg_ + 12 位小写十六进制")
        if not isinstance(source, str) or not source.strip():
            raise AnchorError(f"{anchor_id}: source 必须是非空字符串")
        if not isinstance(quote, str) or not quote.strip() or not normalize(quote):
            raise AnchorError(f"{anchor_id}: quote 必须包含可归一化内容")
        if not isinstance(time_ms, int) or isinstance(time_ms, bool) or time_ms < 0:
            raise AnchorError(f"{anchor_id}: time_ms 必须是非负整数")
        if not isinstance(session_id, str) or not session_id.strip():
            raise AnchorError(f"{anchor_id}: session_id 必须是非空字符串")
        if (
            not isinstance(terms, list)
            or not terms
            or not all(
                isinstance(term, str) and term.strip() and normalize(term)
                for term in terms
            )
        ):
            raise AnchorError(f"{anchor_id}: verify_terms 必须是非空字符串列表")
        targets.append(
            Target(
                anchor_id=anchor_id,
                source=source,
                quote=quote,
                time_ms=time_ms,
                session_id=session_id,
                verify_terms=tuple(terms),
            )
        )
    return tuple(targets)


def dump_targets(path: Path, targets: Sequence[Target]) -> None:
    lines = ["targets:"]
    for target in targets:
        lines.append(
            f"  - anchor_id: {json.dumps(target.anchor_id, ensure_ascii=False)}"
        )
        lines.append(f"    source: {json.dumps(target.source, ensure_ascii=False)}")
        lines.append(f"    quote: {json.dumps(target.quote, ensure_ascii=False)}")
        lines.append(f"    time_ms: {target.time_ms}")
        lines.append(
            f"    session_id: {json.dumps(target.session_id, ensure_ascii=False)}"
        )
        lines.append(
            f"    verify_terms: {json.dumps(list(target.verify_terms), ensure_ascii=False)}"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _anchor_from_row(data: dict[str, Any], line_no: int) -> Anchor:
    if tuple(data) != ANCHOR_FIELDS:
        raise AnchorError(
            f"anchors 第 {line_no} 行字段/顺序不符: 期望 {ANCHOR_FIELDS}，"
            f"实际 {tuple(data)}"
        )
    anchor_id = data["anchor_id"]
    session_id = data["session_id"]
    time_ms = data["time_ms"]
    role = data["role"]
    quote = data["quote"]
    digest = data["normalized_sha256"]
    source = data["source"]
    created_at = data["created_at"]
    status = data["status"]
    if not isinstance(anchor_id, str) or not ANCHOR_ID_RE.fullmatch(anchor_id):
        raise AnchorError(f"anchors 第 {line_no} 行 anchor_id 不合法")
    if not isinstance(session_id, str) or not session_id.strip():
        raise AnchorError(f"anchors 第 {line_no} 行 session_id 不合法")
    if not isinstance(time_ms, int) or isinstance(time_ms, bool) or time_ms < 0:
        raise AnchorError(f"anchors 第 {line_no} 行 time_ms 不合法")
    if role not in ("user", "assistant"):
        raise AnchorError(f"anchors 第 {line_no} 行 role 不合法")
    if not isinstance(quote, str) or not quote.strip():
        raise AnchorError(f"anchors 第 {line_no} 行 quote 不合法")
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(char not in "0123456789abcdef" for char in digest)
    ):
        raise AnchorError(f"anchors 第 {line_no} 行 normalized_sha256 不合法")
    if not isinstance(source, str) or not source.strip():
        raise AnchorError(f"anchors 第 {line_no} 行 source 不合法")
    if not isinstance(created_at, str) or not created_at.strip():
        raise AnchorError(f"anchors 第 {line_no} 行 created_at 不合法")
    if status != "active":
        raise AnchorError(f"anchors 第 {line_no} 行 status 必须是 active")
    return Anchor(
        anchor_id, session_id, time_ms, role, quote, digest, source, created_at, status
    )


def read_anchors(path: Path) -> tuple[Anchor, ...]:
    if not path.exists():
        return ()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise AnchorError(f"无法读取 anchors 文件 {path}: {exc}") from exc
    anchors: list[Anchor] = []
    for line_no, raw in enumerate(lines, 1):
        if not raw.strip():
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise AnchorError(f"{path}:{line_no}: JSON 解析失败: {exc}") from exc
        if not isinstance(data, dict):
            raise AnchorError(f"{path}:{line_no}: 行必须是 JSON 对象")
        anchors.append(_anchor_from_row(data, line_no))
    return tuple(anchors)


def _write_anchors(path: Path, anchors: Sequence[Anchor]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "".join(
        json.dumps(
            {field: getattr(anchor, field) for field in ANCHOR_FIELDS},
            ensure_ascii=False,
        )
        + "\n"
        for anchor in anchors
    )
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


def _load_sources(
    root: Path, targets: Sequence[Target]
) -> dict[str, tuple[SourceMessage, ...]]:
    cache: dict[str, tuple[SourceMessage, ...]] = {}
    for target in targets:
        if target.source in cache:
            continue
        source_path = _resolve_source(root, target.source)
        if source_path is None:
            raise AnchorError(f"{target.anchor_id}: source 路径不合法: {target.source}")
        cache[target.source] = read_source(source_path)
    return cache


def _match_message(
    messages: Sequence[SourceMessage], target: Target
) -> SourceMessage | None:
    needle = normalize(target.quote)
    matches = [
        message
        for message in messages
        if message.session_id == target.session_id
        and message.time_ms == target.time_ms
        and needle in normalize(message.content)
    ]
    roles = {message.role for message in matches}
    if len(roles) > 1:
        raise AnchorError(f"{target.anchor_id}: 同一时刻同时命中 user 与 assistant")
    return matches[0] if matches else None


def derive_anchors(
    root: Path,
    targets_path: Path,
    anchors_path: Path,
    created_at: str | None = None,
) -> tuple[Anchor, ...]:
    targets = load_targets(targets_path)
    if not targets:
        raise AnchorError("targets 为空")
    existing = {anchor.anchor_id: anchor for anchor in read_anchors(anchors_path)}
    sources = _load_sources(root, targets)
    fallback_created = created_at or _now_iso()
    anchors: list[Anchor] = []
    for target in targets:
        message = _match_message(sources[target.source], target)
        if message is None:
            raise AnchorError(
                f"{target.anchor_id}: 在 {target.source} 找不到 "
                f"{target.session_id}@{target.time_ms} 的引文"
            )
        expected = anchor_id_for(
            message.session_id, message.time_ms, message.role, target.quote
        )
        if expected != target.anchor_id:
            raise AnchorError(
                f"target {target.anchor_id} 的锚点算不出来（应为 {expected}）"
            )
        prior = existing.get(expected)
        anchors.append(
            Anchor(
                anchor_id=expected,
                session_id=message.session_id,
                time_ms=message.time_ms,
                role=message.role,
                quote=target.quote,
                normalized_sha256=normalized_sha256_for(target.quote),
                source=target.source,
                created_at=prior.created_at if prior is not None else fallback_created,
                status="active",
            )
        )
    # 合并写入：derive 只负责本批 targets，不得抹掉历史锚点（2026-10-24 修）。
    fresh_ids = {anchor.anchor_id for anchor in anchors}
    carried = [anchor for anchor in existing.values() if anchor.anchor_id not in fresh_ids]
    merged = sorted(carried + anchors, key=lambda a: (a.time_ms, a.anchor_id))
    _write_anchors(anchors_path, merged)
    return tuple(anchors)


def _duplicates(values: Sequence[Any]) -> set[Any]:
    seen: set[Any] = set()
    duplicate: set[Any] = set()
    for value in values:
        if value in seen:
            duplicate.add(value)
        seen.add(value)
    return duplicate


def verify_anchors(
    root: Path, anchors_path: Path, targets_path: Path
) -> VerifyResult:
    targets = load_targets(targets_path)
    anchors = read_anchors(anchors_path)
    findings: list[Finding] = []
    missing_sources = 0
    verified = 0

    target_ids = [target.anchor_id for target in targets]
    target_id_set = set(target_ids)
    anchor_ids = [anchor.anchor_id for anchor in anchors]
    duplicate_ids = _duplicates(target_ids) | _duplicates(anchor_ids)
    duplicate_slots = _duplicates(
        [(anchor.session_id, anchor.time_ms, anchor.role) for anchor in anchors]
    )
    duplicates = len(duplicate_ids) + len(duplicate_slots)
    for anchor_id in sorted(duplicate_ids):
        findings.append(Finding("duplicate", "锚点 ID 重复", anchor_id))
    for slot in sorted(duplicate_slots):
        findings.append(
            Finding("duplicate", f"同一消息出现多个锚点: {slot[0]}@{slot[1]}")
        )

    rows = {anchor.anchor_id: anchor for anchor in anchors}
    cache: dict[str, tuple[SourceMessage, ...]] = {}
    for target in targets:
        before = len(findings)
        source_path = _resolve_source(root, target.source)
        if source_path is None:
            findings.append(
                Finding("source", f"source 路径不合法: {target.source}", target.anchor_id)
            )
            missing_sources += 1
            continue
        if not source_path.is_file():
            findings.append(
                Finding("source", f"源文件不存在: {target.source}", target.anchor_id)
            )
            missing_sources += 1
            continue
        if target.source not in cache:
            try:
                cache[target.source] = read_source(source_path)
            except AnchorError as exc:
                findings.append(Finding("source", str(exc), target.anchor_id))
                missing_sources += 1
                continue
        messages = cache[target.source]
        try:
            message = _match_message(messages, target)
        except AnchorError as exc:
            findings.append(Finding("target", str(exc), target.anchor_id))
            continue
        if message is None:
            same_slot = [
                item
                for item in messages
                if item.session_id == target.session_id
                and item.time_ms == target.time_ms
            ]
            if same_slot:
                findings.append(
                    Finding(
                        "quote",
                        f"引文不匹配: {target.session_id}@{target.time_ms}",
                        target.anchor_id,
                    )
                )
            else:
                findings.append(
                    Finding(
                        "timestamp",
                        f"该会话没有此时间戳: {target.session_id}@{target.time_ms}",
                        target.anchor_id,
                    )
                )
            continue
        expected = anchor_id_for(
            message.session_id, message.time_ms, message.role, target.quote
        )
        if expected != target.anchor_id:
            findings.append(
                Finding(
                    "target",
                    f"target.anchor_id 与引文不符（应为 {expected}）",
                    target.anchor_id,
                )
            )
        row = rows.get(target.anchor_id)
        if row is None:
            findings.append(
                Finding("missing", "anchors.jsonl 缺少该锚点", target.anchor_id)
            )
            continue
        expectations = (
            ("session_id", row.session_id, message.session_id),
            ("time_ms", row.time_ms, message.time_ms),
            ("role", row.role, message.role),
            ("quote", row.quote, target.quote),
            ("normalized_sha256", row.normalized_sha256, normalized_sha256_for(target.quote)),
            ("source", row.source, target.source),
            ("status", row.status, "active"),
        )
        for field, actual, wanted in expectations:
            if actual != wanted:
                findings.append(
                    Finding(
                        "row",
                        f"{field} 不匹配: {actual!r} != {wanted!r}",
                        target.anchor_id,
                    )
                )
        normalized_quote = normalize(target.quote)
        for term in target.verify_terms:
            if normalize(term) not in normalized_quote:
                findings.append(
                    Finding(
                        "verify_terms",
                        f"引文缺少校验词: {term}",
                        target.anchor_id,
                    )
                )
        if len(findings) == before:
            verified += 1

    for anchor in anchors:
        if anchor.anchor_id not in target_id_set:
            findings.append(
                Finding("orphan", "anchors.jsonl 中有 targets 未引用的锚点", anchor.anchor_id)
            )

    return VerifyResult(
        targets=len(targets),
        verified=verified,
        duplicates=duplicates,
        missing_sources=missing_sources,
        findings=tuple(findings),
    )


def _print_finding(finding: Finding) -> None:
    prefix = f"[{finding.category}] "
    if finding.anchor_id:
        prefix += f"{finding.anchor_id}: "
    print(prefix + finding.message, file=sys.stderr)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="message_anchor.py", description="派生/校验稳定消息锚点"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    derive_parser = subparsers.add_parser("derive", help="从聊天记录派生 anchors.jsonl")
    derive_parser.add_argument("--root", default=".")
    derive_parser.add_argument("--targets", default=DEFAULT_TARGETS)
    derive_parser.add_argument("--anchors", default=DEFAULT_ANCHORS)
    derive_parser.add_argument("--created-at", default=None)

    verify_parser = subparsers.add_parser("verify", help="校验锚点与源消息")
    verify_parser.add_argument("--root", default=".")
    verify_parser.add_argument("--anchors", default=DEFAULT_ANCHORS)
    verify_parser.add_argument("--targets", default=DEFAULT_TARGETS)

    args = parser.parse_args(argv)
    root = Path(args.root)
    targets_path = _resolve_path(root, args.targets)
    anchors_path = _resolve_path(root, args.anchors)
    try:
        if args.command == "derive":
            anchors = derive_anchors(
                root, targets_path, anchors_path, created_at=args.created_at
            )
            print(f"derived {len(anchors)} anchors -> {anchors_path}")
            return 0
        result = verify_anchors(root, anchors_path, targets_path)
        if not result.ok:
            for finding in result.findings:
                _print_finding(finding)
        print(result.summary(), file=sys.stdout if result.ok else sys.stderr)
        return 0 if result.ok else 1
    except AnchorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
