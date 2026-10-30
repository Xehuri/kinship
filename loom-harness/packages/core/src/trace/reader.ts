/**
 * T21 trace 读侧 helper —— 追加撕裂容忍。
 *
 * JSONL 追加写可能在行中途崩溃留下撕裂尾行（或空行）；消费方（T29 查询、
 * T39 聚合）一律经由本模块读取，坏行静默跳过、不抛错。
 * 契约：只信任能 `JSON.parse` 且通过 `kind` 判别的最小结构校验的行。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRunSpan, SPAN_STAGES } from "./types.js";
import type { RunSpan, RunStatus, SpanStage, TraceRecord } from "./types.js";

const RUN_STATUSES: readonly RunStatus[] = ["ok", "error", "cancelled"];
const RECORD_KINDS = new Set(["span", "nudge", "run_end"]);

// D34 连字符永久禁用；读侧只需拒含连字符 id，完整格式白名单由写侧 makeId 保证。
function validId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !v.includes("-");
}

/** 粗校验：kind 判别 + 关键字段形状；坏行返回 null（调用方跳过）。 */
function reviveRecord(raw: unknown): TraceRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const kind = rec["kind"];
  if (typeof kind !== "string" || !RECORD_KINDS.has(kind)) return null;
  if (!validId(rec["runId"])) return null;
  if (kind === "span") {
    const stage = rec["stage"];
    if (typeof stage !== "string" || !(SPAN_STAGES as readonly SpanStage[]).includes(stage as SpanStage)) {
      return null;
    }
    if (!validId(rec["spanId"])) return null;
    if (typeof rec["start"] !== "number" || typeof rec["end"] !== "number") return null;
  }
  if (kind === "run_end" && !(RUN_STATUSES as readonly string[]).includes(String(rec["status"]))) {
    return null;
  }
  return raw as TraceRecord;
}

/**
 * 解析一段 JSONL 文本为记录序列；坏行（非 JSON / 判别失败 / 撕裂）逐行跳过。
 * 返回值与合法行一一对应，顺序保持。
 */
export function parseTraceJsonl(text: string): TraceRecord[] {
  const out: TraceRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue; // 撕裂/坏行：容忍跳过
    }
    const rec = reviveRecord(raw);
    if (rec !== null) out.push(rec);
  }
  return out;
}

/** 读取 `{stateRoot}/trace/{dateKey}.jsonl`；文件不存在返回空数组。 */
export function readTraceFile(stateRoot: string, dateKey: string): TraceRecord[] {
  const path = join(stateRoot, "trace", `${dateKey}.jsonl`);
  if (!existsSync(path)) return [];
  return parseTraceJsonl(readFileSync(path, "utf8"));
}

/** 按 runId 归组（T29 查询端点的原始素材；聚合语义留给 scripts）。 */
export function groupByRun(records: readonly TraceRecord[]): Map<string, TraceRecord[]> {
  const byRun = new Map<string, TraceRecord[]>();
  for (const rec of records) {
    const list = byRun.get(rec.runId);
    if (list === undefined) {
      byRun.set(rec.runId, [rec]);
    } else {
      list.push(rec);
    }
  }
  return byRun;
}

/** span 行的类型化筛选（isRunSpan 窄化的数组版，查询侧常备）。 */
export function spansOnly(records: readonly TraceRecord[]): RunSpan[] {
  return records.filter(isRunSpan);
}
