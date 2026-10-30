#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只读记忆索引查询评估器（M2）。

读取 M1 产物（entities.jsonl / links.jsonl / manifest.json）与冻结查询集，
对每个查询按确定性证据排序候选源路径，返回 top-K，并把 PASS/FAIL、排名与
证据写入 --out 下的 query-report.json / query-report.md。

排序口径（全部可复现，无向量/embedding/FTS5）：
1. 文档内 BM25 证据：查询短语权重高于别名/token；同段命中多个别名有覆盖加成。
2. 字段证据：实体标题（含批次小节标题）、路径、frontmatter tags 命中额外加分。
3. 来源权威先验：长期记忆 > 当日复盘 > 当日摘要/理解 > 原始事实 > 执行日志。
   记忆检索的目标是稳定知识，原始批次流水只在没有更好来源时作为证据。
4. 日期只在分数同分时用于裁决，不进入分数。

硬约束：
- 只读源文件；所有写入只发生在 --out 目录内。
- 不修改查询 YAML、ai/memory、ai/data/daily。
- 输出不含运行时间戳，同一索引 + 同一查询集重复运行字节一致。
"""

# allow: SIZE_OK — 单一职责的只读查询评估器（加载 -> 打分 -> 排序 -> 报告 -> CLI），
# 拆文件会让共享的排序口径与证据字段分散，反而不利于审计。

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import posixpath
import re
import sys
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from datetime import date as date_cls
from pathlib import Path, PurePosixPath
from typing import Any, Sequence

AI_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = AI_ROOT.parent
DEFAULT_QUERIES = Path(__file__).resolve().parent / 'memory_index_queries.yaml'
DEFAULT_OUT = AI_ROOT / 'data' / 'cache' / 'memory-index-query'
REPORT_JSON = 'query-report.json'
REPORT_MD = 'query-report.md'
REPORT_SCHEMA_VERSION = 1
TOOL_NAME = 'memory_index_query'
DEFAULT_TOP_K = 5
MATCH_KINDS = ('literal', 'token', 'alias', 'mixed')
SOURCE_PREFIXES = ('ai/memory/', 'ai/data/daily/')

# BM25 参数与字段/角色权重。所有常数都是查询无关的通用口径。
BM25_K1 = 1.2
BM25_B = 0.75
PHRASE_WEIGHT = 2.0
ALIAS_WEIGHT = 1.0
COVERAGE_WEIGHT = 0.5
PATH_COVERAGE_WEIGHT = 0.3
HEADING_WEIGHT = 4.0
FIELD_PATH_WEIGHT = 1.0
FIELD_TITLE_WEIGHT = 0.8
FIELD_TAG_WEIGHT = 0.4
AGGREGATE_WEIGHTS = (1.0, 0.25, 0.1)

ROLE_PRIORS = {
    'memory': 2.8,
    'review': 1.5,
    'summary': 1.3,
    'raw_daily': 1.0,
    'daily_other': 1.1,
    'operational_log': 0.3,
    'other': 1.0,
}

SECTION_RE = re.compile(r'^##\s+(\d{1,2}:\d{2})\s*[~～]\s*(\d{1,2}:\d{2})(.*)$')


class MemoryQueryError(Exception):
    """可预期的索引/查询集/输出错误。"""


@dataclass(frozen=True)
class QuerySpec:
    query_id: str
    query: str
    match_kind: str
    aliases: tuple[str, ...]
    expected_paths: tuple[str, ...]
    min_hits: int = 1
    notes: str = ''

    def as_dict(self) -> dict[str, Any]:
        return {
            'id': self.query_id,
            'query': self.query,
            'match_kind': self.match_kind,
            'aliases': list(self.aliases),
            'expected_paths': list(self.expected_paths),
            'min_hits': self.min_hits,
            'notes': self.notes,
        }


@dataclass(frozen=True)
class IndexData:
    index_dir: Path
    source_hash: str
    generated_at: str
    manifest_file_count: int
    manifest_counts: dict[str, Any]
    entities: tuple[dict[str, Any], ...]
    links: tuple[dict[str, Any], ...]
    broken_links: int


@dataclass(frozen=True)
class Doc:
    entity: dict[str, Any]
    text: str
    line: int | None


@dataclass(frozen=True)
class RankedPath:
    rank: int
    path: str
    score: float
    evidence: dict[str, Any]

    def as_dict(self, expected: bool) -> dict[str, Any]:
        return {
            'rank': self.rank,
            'path': self.path,
            'score': round(self.score, 6),
            'expected': expected,
            'evidence': self.evidence,
        }


@dataclass(frozen=True)
class QueryResult:
    spec: QuerySpec
    ranked: tuple[RankedPath, ...]
    expected: tuple[dict[str, Any], ...]
    matched_expected_paths: tuple[str, ...]
    best_expected_rank: int | None
    status: str

    def as_dict(self) -> dict[str, Any]:
        expected_set = set(self.spec.expected_paths)
        return {
            'id': self.spec.query_id,
            'query': self.spec.query,
            'match_kind': self.spec.match_kind,
            'aliases': list(self.spec.aliases),
            'expected_paths': list(self.spec.expected_paths),
            'min_hits': self.spec.min_hits,
            'notes': self.spec.notes,
            'status': self.status,
            'matched_expected_paths': list(self.matched_expected_paths),
            'best_expected_rank': self.best_expected_rank,
            'expected': list(self.expected),
            'top': [item.as_dict(item.path in expected_set) for item in self.ranked],
        }


@dataclass(frozen=True)
class Evaluation:
    index: IndexData
    queries_path: Path
    queries_sha256: str
    top_k: int
    results: tuple[QueryResult, ...]
    warnings: tuple[str, ...]
    required_passes: int

    @property
    def passed(self) -> int:
        return sum(1 for item in self.results if item.status == 'PASS')

    @property
    def total(self) -> int:
        return len(self.results)

    @property
    def threshold_met(self) -> bool:
        return self.passed >= self.required_passes


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding='utf-8')
    except OSError as exc:
        raise MemoryQueryError(f'读取失败：{path}: {exc}') from exc


def _read_json(path: Path) -> Any:
    text = _read_text(path)
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise MemoryQueryError(f'JSON 解析失败：{path}:{exc.lineno}: {exc.msg}') from exc


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    text = _read_text(path)
    records: list[dict[str, Any]] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError as exc:
            raise MemoryQueryError(
                f'JSONL 解析失败：{path}:{line_no}: {exc.msg}') from exc
        if not isinstance(item, dict):
            raise MemoryQueryError(f'JSONL 记录必须是对象：{path}:{line_no}')
        records.append(item)
    return records


def load_index(index_dir: str | Path) -> IndexData:
    """加载 M1 产物并校验最小 schema；缺文件/坏行直接报错。"""
    root = Path(index_dir).resolve()
    if not root.is_dir():
        raise MemoryQueryError(f'索引目录不存在：{root}')
    manifest_path = root / 'manifest.json'
    entities_path = root / 'entities.jsonl'
    links_path = root / 'links.jsonl'
    for path in (manifest_path, entities_path, links_path):
        if not path.is_file():
            raise MemoryQueryError(f'索引文件缺失：{path}')
    manifest = _read_json(manifest_path)
    if not isinstance(manifest, dict):
        raise MemoryQueryError(f'manifest.json 必须是对象：{manifest_path}')
    source_hash = manifest.get('source_hash')
    files = manifest.get('files')
    counts = manifest.get('counts')
    if not isinstance(source_hash, str) or not source_hash:
        raise MemoryQueryError(f'manifest.json 缺少 source_hash：{manifest_path}')
    if not isinstance(files, list):
        raise MemoryQueryError(f'manifest.json 缺少 files 数组：{manifest_path}')
    if counts is not None and not isinstance(counts, dict):
        raise MemoryQueryError(f'manifest.json 的 counts 必须是对象：{manifest_path}')
    entities = _read_jsonl(entities_path)
    links = _read_jsonl(links_path)
    for index, entity in enumerate(entities):
        _validate_entity(entity, entities_path, index)
    broken = sum(1 for item in links if item.get('resolution') == 'broken')
    return IndexData(
        index_dir=root,
        source_hash=source_hash,
        generated_at=str(manifest.get('generated_at') or ''),
        manifest_file_count=len(files),
        manifest_counts=dict(counts or {}),
        entities=tuple(entities),
        links=tuple(links),
        broken_links=broken,
    )


def _validate_entity(entity: dict[str, Any], path: Path, index: int) -> None:
    where = f'{path}:{index + 1}'
    for key in ('path', 'kind', 'anchor'):
        value = entity.get(key)
        if not isinstance(value, str) or not value.strip():
            raise MemoryQueryError(f'实体缺少字段 {key}：{where}')
    if entity['kind'] not in ('memory_file', 'daily_file', 'batch_section',
                              'person', 'health_shard'):
        raise MemoryQueryError(f'未知实体 kind={entity["kind"]!r}：{where}')
    if entity['kind'] in ('batch_section', 'person'):
        anchors = entity.get('anchors')
        if not isinstance(anchors, list) or not anchors:
            raise MemoryQueryError(f'实体缺少 anchors：{where}')
        line = anchors[0].get('line') if isinstance(anchors[0], dict) else None
        if not isinstance(line, int) or line < 1:
            raise MemoryQueryError(f'实体 anchors[0].line 非法：{where}')


def load_queries(path: str | Path) -> tuple[QuerySpec, ...]:
    """读取冻结查询 YAML，校验 match_kind/别名/期望路径。"""
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - venv 已装 PyYAML
        raise MemoryQueryError('需要 PyYAML 才能读取查询集') from exc
    query_path = Path(path).resolve()
    if not query_path.is_file():
        raise MemoryQueryError(f'查询集不存在：{query_path}')
    try:
        payload = yaml.safe_load(_read_text(query_path))
    except yaml.YAMLError as exc:
        raise MemoryQueryError(f'查询 YAML 解析失败：{query_path}: {exc}') from exc
    if not isinstance(payload, list) or not payload:
        raise MemoryQueryError(f'查询集必须是非空列表：{query_path}')
    specs: list[QuerySpec] = []
    seen: set[str] = set()
    for index, item in enumerate(payload):
        where = f'{query_path}:{index + 1}'
        if not isinstance(item, dict):
            raise MemoryQueryError(f'查询项必须是对象：{where}')
        query_id = item.get('id')
        query = item.get('query')
        match_kind = item.get('match_kind')
        expected = item.get('expected_paths')
        aliases = item.get('aliases') or []
        min_hits = item.get('min_hits', 1)
        if min_hits is None:
            min_hits = 1
        if not isinstance(query_id, str) or not query_id.strip():
            raise MemoryQueryError(f'查询缺少 id：{where}')
        if query_id in seen:
            raise MemoryQueryError(f'查询 id 重复：{query_id}')
        seen.add(query_id)
        if not isinstance(query, str) or not query.strip():
            raise MemoryQueryError(f'查询 {query_id} 缺少 query')
        if match_kind not in MATCH_KINDS:
            raise MemoryQueryError(f'查询 {query_id} 的 match_kind 非法：{match_kind!r}')
        if not isinstance(expected, list) or not expected or not all(
                isinstance(value, str) and value.strip() for value in expected):
            raise MemoryQueryError(f'查询 {query_id} 的 expected_paths 非法')
        if not isinstance(aliases, list) or not all(
                isinstance(value, str) and value.strip() for value in aliases):
            raise MemoryQueryError(f'查询 {query_id} 的 aliases 非法')
        if not isinstance(min_hits, int) or min_hits < 1 or min_hits > len(expected):
            raise MemoryQueryError(f'查询 {query_id} 的 min_hits 非法：{min_hits!r}')
        if match_kind in ('token', 'alias') and not aliases:
            raise MemoryQueryError(f'查询 {query_id} 的 {match_kind} 模式需要 aliases')
        specs.append(QuerySpec(
            query_id=query_id,
            query=query,
            match_kind=match_kind,
            aliases=tuple(aliases),
            expected_paths=tuple(expected),
            min_hits=min_hits,
            notes=str(item.get('notes') or ''),
        ))
    return tuple(specs)


def normalize(text: str) -> str:
    """NFKC + casefold + 去空白；仅用于匹配，不改变报告中的原文。"""
    text = unicodedata.normalize('NFKC', text)
    return ''.join(ch for ch in text.casefold() if not ch.isspace())


def _safe_source_path(repo_root: Path, rel: str) -> Path | None:
    if not isinstance(rel, str) or not rel:
        return None
    candidate_rel = rel.replace('\\', '/')
    if not candidate_rel.startswith(SOURCE_PREFIXES):
        return None
    pure = PurePosixPath(candidate_rel)
    if pure.is_absolute() or '..' in pure.parts:
        return None
    root = repo_root.resolve()
    candidate = (root / pure).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def _read_source(repo_root: Path, rel: str,
                 cache: dict[str, str | None], warnings: list[str]) -> str | None:
    if rel in cache:
        return cache[rel]
    candidate = _safe_source_path(repo_root, rel)
    if candidate is None:
        warnings.append(f'skipped unsafe source path: {rel}')
        cache[rel] = None
        return None
    try:
        text = candidate.read_text(encoding='utf-8', errors='replace')
    except OSError as exc:
        warnings.append(f'missing source: {rel}: {exc}')
        cache[rel] = None
        return None
    cache[rel] = text
    return text


def _section_text(lines: Sequence[str], start_line: int) -> str:
    start = start_line - 1
    if start < 0 or start >= len(lines):
        return ''
    body: list[str] = [lines[start]]
    for line in lines[start + 1:]:
        if SECTION_RE.match(line):
            break
        body.append(line)
    return '\n'.join(body)


def build_docs(repo_root: str | Path, entities: Sequence[dict[str, Any]],
               warnings: list[str]) -> tuple[Doc, ...]:
    """把实体展开为可打分文档；批次小节按 section 边界取正文。"""
    root = Path(repo_root).resolve()
    cache: dict[str, str | None] = {}
    sections_by_path: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entity in entities:
        if entity['kind'] == 'batch_section':
            sections_by_path[entity['path']].append(entity)
    docs: list[Doc] = []
    for entity in entities:
        kind = entity['kind']
        path = entity['path']
        if kind == 'health_shard':
            continue
        raw = _read_source(root, path, cache, warnings)
        if raw is None:
            continue
        if kind == 'batch_section':
            line = entity['anchors'][0]['line']
            text = _section_text(raw.splitlines(), line)
            if text.strip():
                docs.append(Doc(entity=entity, text=normalize(text), line=line))
            continue
        if kind == 'person':
            line = entity['anchors'][0]['line']
            lines = raw.splitlines()
            text = lines[line - 1] if 0 < line <= len(lines) else ''
            if text.strip():
                docs.append(Doc(entity=entity, text=normalize(text), line=line))
            continue
        sections = sections_by_path.get(path)
        if sections:
            first_line = min(item['anchors'][0]['line'] for item in sections)
            preamble = '\n'.join(raw.splitlines()[:first_line - 1])
            if preamble.strip():
                docs.append(Doc(entity=entity, text=normalize(preamble), line=1))
            continue
        if raw.strip():
            docs.append(Doc(entity=entity, text=normalize(raw), line=None))
    if not docs:
        raise MemoryQueryError('索引中没有可读的 markdown 源文档')
    return tuple(docs)


def _query_terms(spec: QuerySpec) -> tuple[list[tuple[str, float]], dict[str, str]]:
    merged: dict[str, float] = {}
    term_kind: dict[str, str] = {}
    if spec.match_kind in ('literal', 'mixed'):
        phrase = normalize(spec.query)
        if not phrase:
            raise MemoryQueryError(f'查询 {spec.query_id} 归一化后为空')
        merged[phrase] = PHRASE_WEIGHT
        term_kind[phrase] = 'phrase'
    if spec.match_kind in ('token', 'alias', 'mixed'):
        for alias in spec.aliases:
            term = normalize(alias)
            if not term:
                continue
            merged[term] = max(merged.get(term, 0.0), ALIAS_WEIGHT)
            term_kind.setdefault(term, 'alias')
    if not merged:
        raise MemoryQueryError(f'查询 {spec.query_id} 没有可匹配的词项')
    return sorted(merged.items()), term_kind


def _idf(df: int, total: int) -> float:
    return math.log(1 + (total - df + 0.5) / (df + 0.5))


def _date_ordinal(value: Any) -> int:
    if not isinstance(value, str) or not value:
        return 0
    try:
        return date_cls.fromisoformat(value[:10]).toordinal()
    except ValueError:
        return 0


def _role_for(path: str) -> str:
    name = posixpath.basename(path)
    if '/执行日志/' in f'/{path}' or '/scratch/' in f'/{path}' or name == 'chat-mode.md':
        return 'operational_log'
    if path.startswith('ai/memory/'):
        return 'memory'
    if name.startswith('复盘-'):
        return 'review'
    if name.startswith(('理解-', '当日摘要-', '健康清单-')):
        return 'summary'
    if name.startswith('事实-'):
        return 'raw_daily'
    if path.startswith('ai/data/daily/'):
        return 'daily_other'
    return 'other'


def _entity_tags(entity: dict[str, Any]) -> list[str]:
    tags = entity.get('tags')
    if isinstance(tags, list):
        return [str(tag) for tag in tags if str(tag).strip()]
    if isinstance(tags, str) and tags.strip():
        return [tags.strip()]
    return []


def _field_hits(path: str, entities: Sequence[dict[str, Any]],
                terms: Sequence[tuple[str, float]],
                idfs: dict[str, float]) -> tuple[float, list[str], list[str]]:
    path_text = normalize(path)
    titles = [normalize(str(item.get('title') or '')) for item in entities]
    tags = [normalize(tag) for item in entities for tag in _entity_tags(item)]
    total = 0.0
    labels: set[str] = set()
    field_terms: set[str] = set()
    for term, _weight in terms:
        if term in path_text:
            total += FIELD_PATH_WEIGHT * idfs[term]
            labels.add('path')
            field_terms.add(term)
        if any(term in title for title in titles):
            total += FIELD_TITLE_WEIGHT * idfs[term]
            labels.add('title')
            field_terms.add(term)
        if any(term in tag for tag in tags):
            total += FIELD_TAG_WEIGHT * idfs[term]
            labels.add('tags')
            field_terms.add(term)
    return total, sorted(labels), sorted(field_terms)


def _evidence(hit_docs: Sequence[tuple[float, Doc, dict[str, int]]],
              entities: Sequence[dict[str, Any]],
              terms: Sequence[tuple[str, float]], term_kind: dict[str, str],
              field_labels: Sequence[str], field_terms: Sequence[str],
              field_score: float, evidence_score: float,
              prior: float) -> dict[str, Any]:
    matched = sorted({term for _score, _doc, hit in hit_docs for term in hit})
    phrase_terms = [term for term in matched if term_kind.get(term) == 'phrase']
    alias_terms = [term for term in matched if term_kind.get(term) != 'phrase']
    phrase_hits = 0
    alias_hits = 0
    for _score, _doc, hit in hit_docs:
        for term, count in hit.items():
            if term_kind.get(term) == 'phrase':
                phrase_hits += count
            else:
                alias_hits += count
    if hit_docs:
        best_doc = max(hit_docs, key=lambda item: (item[0], item[1].entity['anchor']))[1]
        best_entity = best_doc.entity
        best_line = best_doc.line
    else:
        best_entity = entities[0] if entities else {}
        best_line = None
    dates = [entity.get('date') for entity in entities if entity.get('date')]
    return {
        'matched_terms': matched,
        'phrase_terms': sorted(phrase_terms),
        'alias_terms': sorted(alias_terms),
        'phrase_hits': phrase_hits,
        'alias_hits': alias_hits,
        'coverage': round(len(matched) / len(terms), 6),
        'field_hits': list(field_labels),
        'field_terms': list(field_terms),
        'hit_entities': len(hit_docs),
        'best_anchor': best_entity.get('anchor'),
        'best_line': best_line,
        'best_title': str(best_entity.get('title') or ''),
        'best_date': max(dates) if dates else None,
        'score_evidence': round(evidence_score, 6),
        'score_field': round(field_score, 6),
        'role_prior': prior,
    }


def _rank_query(spec: QuerySpec, docs: Sequence[Doc],
                path_entities: dict[str, list[dict[str, Any]]]) -> tuple[RankedPath, ...]:
    terms, term_kind = _query_terms(spec)
    total_docs = len(docs)
    avgdl = sum(len(doc.text) for doc in docs) / total_docs
    hits_by_doc: list[dict[str, int]] = []
    dfs: dict[str, int] = {term: 0 for term, _weight in terms}
    for doc in docs:
        counts: dict[str, int] = {}
        for term, _weight in terms:
            count = doc.text.count(term)
            if count:
                counts[term] = count
                dfs[term] += 1
        hits_by_doc.append(counts)
    idfs = {term: _idf(dfs[term], total_docs) for term, _weight in terms}

    per_path: dict[str, list[tuple[float, Doc, dict[str, int]]]] = defaultdict(list)
    for doc, counts in zip(docs, hits_by_doc):
        if not counts:
            continue
        length = len(doc.text)
        score = 0.0
        for term, weight in terms:
            count = counts.get(term, 0)
            score += weight * idfs[term] * count * (BM25_K1 + 1) / (
                count + BM25_K1 * (1 - BM25_B + BM25_B * length / avgdl))
        coverage = len(counts) / len(terms)
        score *= 1 + COVERAGE_WEIGHT * coverage
        title = normalize(str(doc.entity.get('title') or ''))
        for term, weight in terms:
            if term in title:
                score += HEADING_WEIGHT * weight * idfs[term]
        per_path[doc.entity['path']].append((score, doc, counts))

    ranked: list[tuple[float, str, dict[str, Any]]] = []
    all_paths = set(per_path) | set(path_entities)
    for path in all_paths:
        hit_docs = per_path.get(path, [])
        entities = path_entities.get(path, [])
        prior = ROLE_PRIORS[_role_for(path)]
        evidence_score = 0.0
        if hit_docs:
            ordered = sorted(hit_docs, key=lambda item: item[0], reverse=True)
            for weight, item in zip(AGGREGATE_WEIGHTS, ordered):
                evidence_score += weight * item[0]
            coverage = len({term for _score, _doc, hit in hit_docs for term in hit})
            evidence_score *= 1 + PATH_COVERAGE_WEIGHT * coverage / len(terms)
        field_score, field_labels, field_terms = _field_hits(path, entities, terms, idfs)
        if evidence_score <= 0 and field_score <= 0:
            continue
        score = (evidence_score + field_score) * prior
        evidence = _evidence(
            hit_docs, entities, terms, term_kind, field_labels, field_terms,
            field_score, evidence_score, prior,
        )
        ranked.append((score, path, evidence))

    def sort_key(item: tuple[float, str, dict[str, Any]]) -> tuple[float, int, str]:
        score, path, evidence = item
        return (-round(score, 9), -_date_ordinal(evidence.get('best_date')), path)

    ranked.sort(key=sort_key)
    return tuple(
        RankedPath(rank=index, path=path, score=score, evidence=evidence)
        for index, (score, path, evidence) in enumerate(ranked, start=1)
    )


def _expected_entries(spec: QuerySpec, top_k: int,
                      by_path: dict[str, RankedPath]) -> tuple[dict[str, Any], ...]:
    entries: list[dict[str, Any]] = []
    for path in sorted(spec.expected_paths):
        item = by_path.get(path)
        rank = item.rank if item is not None else None
        entries.append({
            'path': path,
            'rank': rank,
            'in_top_k': rank is not None and rank <= top_k,
            'score': round(item.score, 6) if item is not None else None,
            'evidence': item.evidence if item is not None else None,
        })
    return tuple(entries)


def evaluate(index: IndexData, queries: Sequence[QuerySpec],
             repo_root: str | Path, top_k: int = DEFAULT_TOP_K,
             required_passes: int | None = None,
             queries_path: str | Path | None = None,
             queries_sha256: str = '') -> Evaluation:
    if not 1 <= top_k <= 100:
        raise MemoryQueryError(f'top_k 必须在 1..100：{top_k}')
    warnings: list[str] = []
    docs = build_docs(repo_root, index.entities, warnings)
    path_entities: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entity in index.entities:
        if entity['kind'] == 'health_shard':
            continue
        if not entity['path'].startswith(SOURCE_PREFIXES):
            continue
        path_entities[entity['path']].append(entity)
    results: list[QueryResult] = []
    for spec in queries:
        full = _rank_query(spec, docs, path_entities)
        ranked = full[:top_k]
        by_path = {item.path: item for item in full}
        expected = _expected_entries(spec, top_k, by_path)
        matched = tuple(item['path'] for item in expected if item['in_top_k'])
        best_rank = min((item['rank'] for item in expected
                         if item['rank'] is not None), default=None)
        status = 'PASS' if len(matched) >= spec.min_hits else 'FAIL'
        results.append(QueryResult(
            spec=spec,
            ranked=ranked,
            expected=expected,
            matched_expected_paths=matched,
            best_expected_rank=best_rank,
            status=status,
        ))
    total = len(results)
    if required_passes is None:
        required_passes = max(1, math.ceil(total * 0.9)) if total else 0
    required_passes = min(max(required_passes, 0), total)
    return Evaluation(
        index=index,
        queries_path=Path(queries_path).resolve() if queries_path else Path(''),
        queries_sha256=queries_sha256,
        top_k=top_k,
        results=tuple(results),
        warnings=tuple(sorted(set(warnings))),
        required_passes=required_passes,
    )


def evaluate_files(index_dir: str | Path, queries_path: str | Path,
                   repo_root: str | Path = REPO_ROOT,
                   top_k: int = DEFAULT_TOP_K,
                   required_passes: int | None = None) -> Evaluation:
    index = load_index(index_dir)
    specs = load_queries(queries_path)
    query_file = Path(queries_path).resolve()
    digest = _sha256_bytes(query_file.read_bytes())
    return evaluate(index, specs, repo_root, top_k, required_passes,
                    queries_path=query_file, queries_sha256=digest)


def build_report(evaluation: Evaluation) -> dict[str, Any]:
    passed = evaluation.passed
    total = evaluation.total
    return {
        'schema_version': REPORT_SCHEMA_VERSION,
        'tool': TOOL_NAME,
        'index': {
            'dir': str(evaluation.index.index_dir),
            'source_hash': evaluation.index.source_hash,
            'generated_at': evaluation.index.generated_at,
            'manifest_files': evaluation.index.manifest_file_count,
            'manifest_counts': evaluation.index.manifest_counts,
            'entities': len(evaluation.index.entities),
            'links': len(evaluation.index.links),
            'broken_links': evaluation.index.broken_links,
        },
        'queries_file': {
            'path': str(evaluation.queries_path),
            'sha256': evaluation.queries_sha256,
        },
        'top_k': evaluation.top_k,
        'summary': {
            'total': total,
            'passed': passed,
            'failed': total - passed,
            'required_passes': evaluation.required_passes,
            'threshold_met': evaluation.threshold_met,
            'pass_rate': round(passed / total, 6) if total else 0.0,
        },
        'queries': [item.as_dict() for item in evaluation.results],
        'warnings': list(evaluation.warnings),
    }


def _md_cell(value: Any) -> str:
    return str(value).replace('|', '\\|').replace('\n', ' ')


def _md_evidence(evidence: dict[str, Any]) -> str:
    parts: list[str] = []
    if evidence['phrase_hits']:
        parts.append('phrase=' + '、'.join(evidence['phrase_terms']) +
                     f'×{evidence["phrase_hits"]}')
    if evidence['alias_hits']:
        parts.append('alias=' + '、'.join(evidence['alias_terms']) +
                     f'×{evidence["alias_hits"]}')
    if evidence['field_hits']:
        parts.append('fields=' + ','.join(evidence['field_hits']))
    parts.append(f'entities={evidence["hit_entities"]}')
    parts.append(f'coverage={evidence["coverage"]:.2f}')
    if evidence.get('best_line'):
        parts.append(f'best={evidence["best_anchor"]}@{evidence["best_line"]}')
    return '; '.join(parts)


def render_markdown(evaluation: Evaluation) -> str:
    report = build_report(evaluation)
    summary = report['summary']
    lines: list[str] = [
        '# Memory index query report',
        '',
        f'- Tool: `{TOOL_NAME}`',
        f'- Index: `{report["index"]["dir"]}`',
        f'- Source hash: `{report["index"]["source_hash"]}`',
        f'- Manifest generated at: `{report["index"]["generated_at"]}`',
        f'- Queries: `{report["queries_file"]["path"]}` '
        f'(sha256 `{report["queries_file"]["sha256"]}`)',
        f'- Top-K: {report["top_k"]}',
        f'- Result: **{summary["passed"]}/{summary["total"]} PASS** '
        f'(required {summary["required_passes"]}, '
        f'threshold_met={str(summary["threshold_met"]).lower()})',
        '',
        '## Summary',
        '',
        '| # | Query | Match | Status | Best expected rank | Top-1 |',
        '|---|-------|-------|--------|--------------------|-------|',
    ]
    for item in report['queries']:
        top1 = item['top'][0]['path'] if item['top'] else '-'
        best = item['best_expected_rank']
        lines.append(
            f'| {item["id"]} | {_md_cell(item["query"])} | {item["match_kind"]} | '
            f'{item["status"]} | {best if best is not None else "-"} | '
            f'`{_md_cell(top1)}` |')
    lines.append('')
    lines.append('## Query details')
    lines.append('')
    for item in report['queries']:
        lines.append(f'### {item["id"]} — {item["query"]} ({item["match_kind"]}) — {item["status"]}')
        lines.append('')
        lines.append('- Expected: ' + ', '.join(f'`{path}`' for path in item['expected_paths']))
        matched = item['matched_expected_paths']
        lines.append('- Matched expected: ' +
                     (', '.join(f'`{path}`' for path in matched) if matched else 'none'))
        lines.append(f'- Best expected rank: '
                     f'{item["best_expected_rank"] if item["best_expected_rank"] is not None else "-"}')
        lines.append('')
        lines.append('| Rank | Path | Score | Evidence |')
        lines.append('|------|------|-------|----------|')
        for top in item['top']:
            marker = ' *(expected)*' if top['expected'] else ''
            lines.append(
                f'| {top["rank"]} | `{_md_cell(top["path"])}`{marker} | '
                f'{top["score"]:.6f} | {_md_cell(_md_evidence(top["evidence"]))} |')
        lines.append('')
    if report['warnings']:
        lines.append('## Warnings')
        lines.append('')
        for warning in report['warnings']:
            lines.append(f'- {warning}')
        lines.append('')
    return '\n'.join(lines).rstrip() + '\n'


def _atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('wb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def write_report(evaluation: Evaluation, out_dir: str | Path) -> tuple[Path, Path]:
    out = Path(out_dir).resolve()
    if out.exists() and not out.is_dir():
        raise MemoryQueryError(f'--out 不是目录：{out}')
    out.mkdir(parents=True, exist_ok=True)
    report = build_report(evaluation)
    json_bytes = (json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')
    markdown = render_markdown(evaluation).encode('utf-8')
    json_path = (out / REPORT_JSON).resolve()
    md_path = (out / REPORT_MD).resolve()
    for target in (json_path, md_path):
        if target.parent != out:
            raise MemoryQueryError(f'拒绝写出 --out 之外：{target}')
    _atomic_write(json_path, json_bytes)
    _atomic_write(md_path, markdown)
    return json_path, md_path


def _summary_payload(evaluation: Evaluation) -> dict[str, Any]:
    report = build_report(evaluation)
    return {
        'summary': report['summary'],
        'queries': [
            {
                'id': item['id'],
                'status': item['status'],
                'best_expected_rank': item['best_expected_rank'],
                'top5': [top['path'] for top in item['top']],
            }
            for item in report['queries']
        ],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='只读记忆索引查询评估（M2）：读取 M1 索引，输出 top-5 与 PASS/FAIL')
    parser.add_argument('--index', required=True, help='M1 索引目录（含 manifest/entities/links）')
    parser.add_argument('--queries', default=str(DEFAULT_QUERIES), help='冻结查询 YAML')
    parser.add_argument('--out', default=str(DEFAULT_OUT),
                        help=f'报告输出目录（默认 {DEFAULT_OUT}）')
    parser.add_argument('--repo-root', default=str(REPO_ROOT), help='仓库根目录')
    parser.add_argument('--top-k', type=int, default=DEFAULT_TOP_K, help='返回前 K 条路径')
    parser.add_argument('--min-pass', type=int, default=None,
                        help='通过阈值；默认 ceil(0.9 * 查询数)')
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        evaluation = evaluate_files(
            args.index, args.queries, args.repo_root, args.top_k, args.min_pass)
        json_path, md_path = write_report(evaluation, args.out)
    except MemoryQueryError as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2
    payload = _summary_payload(evaluation)
    payload['written'] = [str(json_path), str(md_path)]
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if evaluation.threshold_met else 1


if __name__ == '__main__':
    raise SystemExit(main())
