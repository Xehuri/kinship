/**
 * C1 压缩历史事件日志（append-only JSONL）。
 *
 * autoCompaction 是 view-only（不写 store 的 compaction_boundary），旧摘要一旦被下一次
 * 压缩覆盖就只存在于内存最后一帧。本模块把每个**观察到的**压缩摘要追加到会话 sidecar：
 *
 *   {stateRoot}/session/compaction/{sessionID}.events.jsonl
 *
 * 语义纪律：
 *   - append-only：只追加行，从不重写文件（崩溃残行由读侧跳过并计数）。
 *   - 按 summary 全文 sha256 去重：同一摘要重复观察只落一行（run 结束/GET 播种幂等）。
 *   - 崩溃安全：追加前若文件尾不是换行（上次写半行），先补一个换行，避免新行被粘进残行。
 *   - 缺文件 = 空日志（会话从未压缩过，非异常）。
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

/** 一条历史压缩事件（boundary = store 持久边界；auto = 内存 live/cache 观察面）。 */
export interface CompactionEvent {
  readonly id: string;
  readonly kind: "boundary" | "auto";
  /** 该摘要覆盖的消息条数（坐标语义见 compaction-history.ts）。 */
  readonly coveredCount: number;
  readonly summaryText: string;
  readonly anchorMessageId: string | null;
  readonly anchorTimestampMs: number | null;
  /** 事件发生时刻（boundary = summary.timestamp；auto = 观察时刻）。 */
  readonly recordedAt: number;
}

export interface CompactionEventLog {
  events: CompactionEvent[];
  /** 无法解析/形状违规的行数（坏行跳过，绝不部分消费）。 */
  readonly skipped: number;
}

const SESSION_ID_RE = /^[a-zA-Z0-9_]+$/;

/** 摘要全文的稳定去重键（sha256 hex；同一摘要跨 boundary/auto/live/cache 合并）。 */
export function compactionEventKey(summaryText: string): string {
  return createHash("sha256").update(summaryText, "utf8").digest("hex");
}

function eventLogFile(stateRoot: string, sessionID: string): string {
  return join(stateRoot, "session", "compaction", `${sessionID}.events.jsonl`);
}

/** 边界解析（parse-don't-validate）：形状不合 = null（由读侧计 skipped）。 */
function parseCompactionEvent(raw: unknown): CompactionEvent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = row["id"];
  const kind = row["kind"];
  const coveredCount = row["coveredCount"];
  const summaryText = row["summaryText"];
  const anchorMessageId = row["anchorMessageId"];
  const anchorTimestampMs = row["anchorTimestampMs"];
  const recordedAt = row["recordedAt"];
  if (typeof id !== "string" || id.length === 0) return null;
  if (kind !== "boundary" && kind !== "auto") return null;
  if (typeof coveredCount !== "number" || !Number.isFinite(coveredCount)) return null;
  if (typeof summaryText !== "string") return null;
  if (anchorMessageId !== null && typeof anchorMessageId !== "string") return null;
  if (anchorTimestampMs !== null && (typeof anchorTimestampMs !== "number" || !Number.isFinite(anchorTimestampMs))) {
    return null;
  }
  if (typeof recordedAt !== "number" || !Number.isFinite(recordedAt)) return null;
  return { id, kind, coveredCount, summaryText, anchorMessageId, anchorTimestampMs, recordedAt };
}

/** 读会话事件日志；缺文件 = 空，坏行跳过并计数。 */
export function readCompactionEvents(stateRoot: string, sessionID: string): CompactionEventLog {
  if (!SESSION_ID_RE.test(sessionID)) return { events: [], skipped: 0 };
  let raw: string;
  try {
    raw = readFileSync(eventLogFile(stateRoot, sessionID), "utf8");
  } catch {
    return { events: [], skipped: 0 };
  }
  const events: CompactionEvent[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const event = parseCompactionEvent(parsed);
    if (event === null) {
      skipped += 1;
      continue;
    }
    events.push(event);
  }
  return { events, skipped };
}

/**
 * 追加一条事件（按 summary sha256 去重）。
 * 返回 true = 本次确实落了一行；false = 摘要已存在（或非法 sid）。
 * 抛错只可能是真实 IO 故障（权限/磁盘）；调用点按 best-effort WARN 处理。
 */
export function appendCompactionEvent(
  stateRoot: string,
  sessionID: string,
  event: CompactionEvent,
): boolean {
  if (!SESSION_ID_RE.test(sessionID)) return false;
  const key = compactionEventKey(event.summaryText);
  const existing = readCompactionEvents(stateRoot, sessionID);
  if (existing.events.some((row) => compactionEventKey(row.summaryText) === key)) return false;

  const file = eventLogFile(stateRoot, sessionID);
  mkdirSync(dirname(file), { recursive: true });
  // 崩溃残行保护：上次写卡在半行时先补换行，保证新事件是独立可解析的一行。
  if (!endsWithNewline(file)) appendFileSync(file, "\n", "utf8");
  appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  return true;
}

/** 文件尾是否换行（缺文件/空文件 = true，无需补行）。 */
function endsWithNewline(file: string): boolean {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return true;
  }
  if (size === 0) return true;
  const fd = openSync(file, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}
