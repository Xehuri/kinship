/**
 * CompactionBoundary —— 压缩边界条目（T19，docs/01 D21「产物=boundary 事件+摘要块进 L0，
 * 溢出原文留档，快照带指针可回读（read 按需读回，不自动塞回）」）。
 *
 * 一条 boundary = 三件套：**摘要块**（替换被裁前缀进 L0）+ **被裁范围**（fromSeq..throughSeq，
 * seq=原始消息下标坐标）+ **重读指针**（指向溢出原文档案；装配/复盘按指针 read 回读，绝不自动塞回）。
 *
 * 幂等契约（「撕裂重放不二次裁」的地基）：
 *   - `key = sessionId@throughSeq` 由**输入状态**（裁到哪儿）决定，不含时钟/随机数 → 同一状态重算同 key；
 *   - `BoundaryLedger.write` 按 key 去重（written / duplicate）；
 *   - `projectThroughBoundaries` 重放历史时按 key 去重：重复投递的同一 boundary **只裁一次前缀**。
 *     L0 撕裂重放（T08 Journal 尾行容忍 + 补封）可能把同一边界行重放两次，二次应用会把 summary
 *     连同 boundary 之后的消息再裁掉——静默数据丢失。按 key 去重堵死这条路径。
 *
 * 依赖方向：core 不 import adapters；落盘经 `BoundarySinkLike`（duck-typed，形状 = adapters
 * SessionShards 的 appendTurn/readAfter 子集）注入。
 */

import { createHash } from "node:crypto";
import { createUserMessage } from "../types.js"; // 环纪律：深路径直引（见 convergence/gate.ts 注释）
import type { Message } from "@earendil-works/pi-ai";

/** boundary 摘要块的固定首行标记（解析/装配侧据此识别）。 */
export const BOUNDARY_SUMMARY_MARK = "[compaction boundary]";

/** 一条压缩边界（不可变值对象；落盘行与内存表示同构）。 */
export interface BoundaryRecord {
  /** 幂等键 `sessionId@throughSeq`（由输入状态决定 ⇒ 重放可去重）。 */
  readonly key: string;
  readonly sessionId: string;
  /** 摘要块正文（含标记/范围行/指针行；进 L0 的 summary 文本）。 */
  readonly summaryText: string;
  /** 被裁范围：起 seq（0-based 消息下标；= 上一条 boundary 的 throughSeq+1）。 */
  readonly trimmedFromSeq: number;
  /** 被裁范围：止 seq（含）。 */
  readonly trimmedThroughSeq: number;
  /** 被裁消息条数。 */
  readonly trimmedCount: number;
  /** 溢出原文档案指针（重读只按此指针回读，不自动塞回）。 */
  readonly rereadPointer: string;
  readonly preTokens: number;
  readonly postTokens: number;
  /** 缓存断点（D21「每次压缩落…缓存断点」；默认 = 摘要文本 sha256）。 */
  readonly cacheBreakpoint: string;
  /** epoch ms。 */
  readonly at: number;
}

/** boundary 幂等键（纯函数：同一压缩状态必然同 key）。 */
export function makeBoundaryKey(sessionId: string, trimmedThroughSeq: number): string {
  return `${sessionId}@${String(trimmedThroughSeq)}`;
}

/** 把摘要正文 + 被裁范围 + 重读指针组装成 boundary 摘要块文本（三件套恒在）。 */
export function buildBoundarySummaryText(
  body: string,
  rec: Pick<BoundaryRecord, "trimmedFromSeq" | "trimmedThroughSeq" | "trimmedCount" | "rereadPointer">,
): string {
  return [
    BOUNDARY_SUMMARY_MARK,
    `trimmed_seq: ${String(rec.trimmedFromSeq)}-${String(rec.trimmedThroughSeq)} (count=${String(rec.trimmedCount)})`,
    `overflow originals: ${rec.rereadPointer} (manual reread only)`,
    body,
  ].join("\n");
}

/** 从摘要块文本解析出被裁范围与指针（装配侧读 boundary 的正规通道）；非 boundary 文本 → null。 */
export function parseBoundarySummaryText(
  text: string,
): { readonly fromSeq: number; readonly throughSeq: number; readonly count: number; readonly pointer: string } | null {
  if (!text.startsWith(BOUNDARY_SUMMARY_MARK)) return null;
  const range = /^trimmed_seq: (\d+)-(\d+) \(count=(\d+)\)$/m.exec(text);
  const pointer = /^overflow originals: (\S+) \(manual reread only\)$/m.exec(text);
  if (range === null || pointer === null) return null;
  return {
    fromSeq: Number(range[1]),
    throughSeq: Number(range[2]),
    count: Number(range[3]),
    pointer: pointer[1]!,
  };
}

/** 行形状非法（缺判别字段/类型错）——torn 判定与 parse 失败共用此错。 */
class BoundaryRowShapeError extends Error {}

/** L0 行判别（形状校验，照 vendor isLogRecord：判别字段与载荷一起验）。 */
export function isBoundaryRow(row: { readonly [key: string]: unknown }): boolean {
  try {
    parseBoundaryRow(row);
    return true;
  } catch {
    return false;
  }
}

/** boundary 记录 → L0 行（键序固定，序列化字节稳定）。 */
export function serializeBoundaryRow(rec: BoundaryRecord): { readonly [key: string]: unknown } {
  return {
    t: "compaction_boundary",
    key: rec.key,
    session: rec.sessionId,
    summary: rec.summaryText,
    from: rec.trimmedFromSeq,
    through: rec.trimmedThroughSeq,
    count: rec.trimmedCount,
    pointer: rec.rereadPointer,
    pre: rec.preTokens,
    post: rec.postTokens,
    cache: rec.cacheBreakpoint,
    at: rec.at,
  };
}

/** boundary 行 → 记录（形状非法抛 BoundaryRowShapeError）。 */
export function parseBoundaryRow(row: { readonly [key: string]: unknown }): BoundaryRecord {
  const bad = (why: string): never => {
    throw new BoundaryRowShapeError(`bad boundary row: ${why} ${JSON.stringify(row)}`);
  };
  if (row["t"] !== "compaction_boundary") bad("t");
  for (const k of ["key", "session", "summary", "pointer"] as const) {
    if (typeof row[k] !== "string") bad(k);
  }
  for (const k of ["from", "through", "count"] as const) {
    if (typeof row[k] !== "number") bad(k);
  }
  return {
    key: row["key"] as string,
    sessionId: row["session"] as string,
    summaryText: row["summary"] as string,
    trimmedFromSeq: row["from"] as number,
    trimmedThroughSeq: row["through"] as number,
    trimmedCount: row["count"] as number,
    rereadPointer: row["pointer"] as string,
    preTokens: typeof row["pre"] === "number" ? row["pre"] : 0,
    postTokens: typeof row["post"] === "number" ? row["post"] : 0,
    cacheBreakpoint: typeof row["cache"] === "string" ? row["cache"] : "",
    at: typeof row["at"] === "number" ? row["at"] : 0,
  };
}

/** 消息行（投影输入的一种 L0 行；`messageRow` 构造，形状弱验）。 */
export function messageRow(m: Message): { readonly [key: string]: unknown } {
  return { t: "message", message: m as unknown as Record<string, unknown> };
}

/** 落盘 sink 的最小消费形状（adapters SessionShards 结构化匹配即可传入）。 */
export interface BoundarySinkLike {
  appendTurn(turn: { readonly [key: string]: unknown }): void;
  readAfter(startTurn: number): {
    readonly rows: readonly { readonly [key: string]: unknown }[];
    readonly openedShards: number;
  };
}

export type BoundaryWriteOutcome = "written" | "duplicate";

/**
 * boundary 账本：往 L0 sink 追加 boundary 行、**按 key 幂等**（重复写 = duplicate 不再追加）。
 * 读侧对**尾行撕裂**容忍（最后一行形状非法 = 崩溃截断 → 丢弃）；中段非法 boundary 行 = 真损坏，响亮抛错。
 */
export class BoundaryLedger {
  private readonly _sink: BoundarySinkLike;

  constructor(sink: BoundarySinkLike) {
    this._sink = sink;
  }

  /** 幂等写：key 已存在 → "duplicate"（零追加）；否则追加一行 → "written"。 */
  write(rec: BoundaryRecord): BoundaryWriteOutcome {
    const existing = this.readAll();
    if (existing.some((b) => b.key === rec.key)) return "duplicate";
    this._sink.appendTurn(serializeBoundaryRow(rec));
    return "written";
  }

  /** 重放全部 boundary 行（撕裂尾行容忍；中段损坏抛错）。 */
  readAll(): BoundaryRecord[] {
    const rows = this._sink.readAfter(0).rows;
    return this._parseRows(rows);
  }

  /** 最后一条已应用 boundary（无 → null）。 */
  last(): BoundaryRecord | null {
    const all = this.readAll();
    return all.length === 0 ? null : all[all.length - 1]!;
  }

  private _parseRows(
    rows: readonly { readonly [key: string]: unknown }[],
  ): BoundaryRecord[] {
    const out: BoundaryRecord[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const isBoundaryCandidate =
        typeof row["t"] === "string" && (row["t"] as string) === "compaction_boundary";
      if (!isBoundaryCandidate) continue;
      try {
        out.push(parseBoundaryRow(row));
      } catch (err) {
        // 只有最后一行可为崩溃撕裂尾行；中段非法 = 损坏。
        if (i === rows.length - 1) break;
        throw err;
      }
    }
    return out;
  }
}

/** 历史投影结果（重放 L0 行 → boundary 裁切后的消息序列）。 */
export interface ProjectedHistory {
  readonly messages: readonly Message[];
  /** 实际生效的 boundary（按应用序）。 */
  readonly applied: readonly BoundaryRecord[];
  /** 被去重跳过的重复 boundary 行数（撕裂重放的直接观测量）。 */
  readonly duplicateCount: number;
  readonly lastBoundary: BoundaryRecord | null;
}

/**
 * 把 L0 行序列重放投影成「boundary 裁切后」的消息序列——**按 key 幂等**：
 * 首次遇到某 boundary 行 = 丢弃已累积前缀、以 summary 接续（与内核 resume 的 compaction_boundary
 * 语义一致）；同 key 再出现（撕裂重放/重复投递）= 跳过，**绝不二次裁**。
 * 非 boundary / 非法形状的杂项行（如普通 turn）忽略。
 */
export function projectThroughBoundaries(
  rows: readonly { readonly [key: string]: unknown }[],
): ProjectedHistory {
  const messages: Message[] = [];
  const applied: BoundaryRecord[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const row of rows) {
    if (row["t"] === "compaction_boundary") {
      const rec = parseBoundaryRow(row); // 非法即抛：投影入口不容坏 boundary
      if (seen.has(rec.key)) {
        duplicateCount += 1; // 撕裂重放去重点：不重置 messages（否则二次裁）
        continue;
      }
      seen.add(rec.key);
      messages.length = 0;
      messages.push(createUserMessage(rec.summaryText));
      applied.push(rec);
      continue;
    }
    if (row["t"] === "message") {
      const m = row["message"];
      if (
        typeof m === "object" &&
        m !== null &&
        typeof (m as { role?: unknown }).role === "string"
      ) {
        messages.push(m as Message);
      }
    }
    // 其余形状的行不属于投影词汇表：忽略（turn 级聚合行等由装配侧另行处理）。
  }
  return { messages, applied, duplicateCount, lastBoundary: applied.length === 0 ? null : applied[applied.length - 1]! };
}

/** 溢出原文档案 sink（指针 → 原文文本；`read` 按需回读的存储面）。 */
export interface ArchiveSinkLike {
  /** 归档一批原文，返回指针 id。 */
  put(pointer: string, text: string): void;
  /** 按指针回读；无 → null。 */
  get(pointer: string): string | null;
}

/** 内存档案（测试/默认实现）。 */
export class MemoryArchive implements ArchiveSinkLike {
  private readonly _store = new Map<string, string>();

  put(pointer: string, text: string): void {
    this._store.set(pointer, text);
  }

  get(pointer: string): string | null {
    return this._store.get(pointer) ?? null;
  }
}

/** boundary 默认缓存断点：摘要块文本的 sha256（同文本同断点，可作 provider cache 锚点比对）。 */
export function boundaryCacheBreakpoint(summaryText: string): string {
  return `sha256:${createHash("sha256").update(summaryText).digest("hex")}`;
}
