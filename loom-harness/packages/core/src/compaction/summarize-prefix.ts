/**
 * summarize-prefix —— 把压缩前缀切块逐块总结、再合并成一份最终摘要（W52 分块 map-reduce 的复用版）。
 *
 * **all-or-nothing（W57）**：任意块失败或合并失败都直接抛错，不返回部分结果、不返回部分覆盖边界、
 * 不写任何状态。调用方（autoCompaction、未来的压缩 worker）只有在拿到完整文本后才允许提交 boundary /
 * 推进缓存；失败时保持原状（auto 路径由 transform 抛错，内核 fail-open 到原始视图）。
 *
 * **单块逐字节等价**：前缀不超过 `summaryChunkTokens` 时走 `chunkMessagesForSummary` 的单块路径，
 * 把该块（可能已对单条超大消息做摘要专用截断）原样交给 `summarize` —— 与 W52 前的旧实现一致。
 *
 * **空前缀**：`chunkMessagesForSummary([])` 返回 `[]`，本函数仍调用一次 `summarize([], ctx)`，
 * 由调用方的 summarize 决定如何响应空输入（与旧实现一致，不特判）。
 *
 * **P3 水位 notice**：前缀里的 `[context-watermark:...]` 消息在分块前被过滤掉，绝不写进摘要；
 * 调用方的 `coveredCount` 仍按 raw 坐标计算（notice 占原始索引，但不占摘要语义）。
 */

import type {
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { HookContext } from "../hook.js";
import { createUserMessage } from "../types.js";
import { estimateTokensByChars } from "../plugins/token-estimate.js";
import { isContextWatermarkMessage } from "./context-watermark.js";
import type { SummarizeDelta } from "./worker-types.js";

/** 单条消息超分块上限时的截断标记（摘要输入专用，不写回 store）。 */
const SUMMARY_TRUNCATION_MARK = "\n…（单条消息超摘要分块上限，已截断）";

/**
 * 把单条消息裁到 ≤ maxTokens（仅供 summarize 输入使用；返回浅拷贝，绝不改原消息）。
 * 超大 toolResult / 大文档是多 MB 前缀的常见来源，必须能单独塞进一个块，否则分块仍会超限。
 */
function capMessageForSummary(m: Message, maxTokens: number): Message {
  if (estimateTokensByChars([m]) <= maxTokens) return m;
  if (m.role === "user" && typeof m.content === "string") {
    // 按最保守的 ASCII 比例(4 chars/token)截断；CJK 内容实际更短，宁可少留。
    const budget = Math.max(1, Math.floor(maxTokens * 4));
    return { ...m, content: m.content.slice(0, budget) + SUMMARY_TRUNCATION_MARK };
  }
  if (typeof m.content === "string") return m;
  const kept: Array<TextContent | ImageContent | ThinkingContent | ToolCall> = [];
  let remaining = maxTokens;
  for (const b of m.content) {
    const est = estimateTokensByChars([{ ...m, content: [b] } as Message]);
    if (est <= remaining) {
      kept.push(b);
      remaining -= est;
      continue;
    }
    if ("text" in b && typeof b.text === "string") {
      const budget = Math.max(1, Math.floor(remaining * 4));
      kept.push({ ...b, text: b.text.slice(0, budget) + SUMMARY_TRUNCATION_MARK });
    }
    break;
  }
  return { ...m, content: kept } as Message;
}

/**
 * 把要总结的前缀按 token 上限切块（消息粒度；单条超限的先截断）。
 * 空输入返回 `[]`（调用方按单块路径传 `[]` 给 summarize）。
 */
export function chunkMessagesForSummary(msgs: Message[], chunkTokens: number): Message[][] {
  const chunks: Message[][] = [];
  let cur: Message[] = [];
  let curTokens = 0;
  for (const m of msgs) {
    const capped = capMessageForSummary(m, chunkTokens);
    const t = estimateTokensByChars([capped]);
    if (cur.length > 0 && curTokens + t > chunkTokens) {
      chunks.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(capped);
    curTokens += t;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** 合并步的输入：同一次压缩的各段摘要，按时间顺序。 */
export function buildSummaryMergePrompt(partials: ReadonlyArray<string>): string {
  return (
    `以下是同一条会话的 ${partials.length} 段分段摘要（按时间顺序）。` +
    `请合并为一份最终中文摘要：去重、按主题组织、保留全部关键事实/数字/路径/待办/承诺，` +
    `不编造；只写路径与变量名，绝不写密钥值。\n\n` +
    partials.map((p, i) => `=== 分段 ${i + 1} ===\n${p}`).join("\n\n")
  );
}

/** 摘要调用模式：`auto` 预算内单次、超预算递归拆分；`single` 严格单次；`chunked` 保持旧的分块 map-reduce。 */
export type SummaryMode = "auto" | "single" | "chunked";

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `summarizeCompactionPrefix: ${field} must be a positive integer (got ${String(value)})`,
    );
  }
}

/**
 * 选取最接近 token 中点的消息边界（切在 index 之前）；存在 user 边界时优先 user 边界，
 * 避免把 assistant toolCall 与其 toolResult 拆到两段。无法拆分（< 2 条）返回 null。
 */
function selectSplitBoundary(messages: readonly Message[]): number | null {
  if (messages.length < 2) return null;
  const prefixTokens: number[] = [];
  let total = 0;
  for (const message of messages) {
    total += estimateTokensByChars([message]);
    prefixTokens.push(total);
  }
  const half = total / 2;
  let closest: { index: number; distance: number } | null = null;
  let closestUser: { index: number; distance: number } | null = null;
  for (let index = 1; index < messages.length; index += 1) {
    const distance = Math.abs(prefixTokens[index - 1]! - half);
    if (closest === null || distance < closest.distance) {
      closest = { index, distance };
    }
    const isUser = messages[index]!.role === "user";
    if (isUser && (closestUser === null || distance < closestUser.distance)) {
      closestUser = { index, distance };
    }
  }
  return (closestUser ?? closest)?.index ?? null;
}

/** {@link summarizeCompactionPrefix} 的输入。 */
export interface SummarizeCompactionPrefixInput {
  /** 要折进摘要的前缀（raw / durable 坐标，不含上一次 summary）。 */
  prefix: Message[];
  /** 与 autoCompaction / compactSummarize 同契约的 summarize seam。 */
  summarize: (
    messages: Message[],
    ctx: HookContext,
    onDelta?: (delta: SummarizeDelta) => void,
  ) => string | Promise<string>;
  /** 流式增量观察者；每个 delta 已由本层补上 chunk 下标。 */
  onDelta?: (delta: SummarizeDelta) => void;
  /** 单次 summarize 调用的输入 token 上限（块大小）；须 > 0。 */
  summaryChunkTokens: number;
  ctx: HookContext;
  /**
   * 调用模式。缺省时按预算推导：提供 `singleCallBudgetTokens` 视为 `auto`，否则回退旧 `chunked`。
   * `single` / `auto` 强制要求正整数预算；`chunked` 忽略预算，保持旧行为。
   */
  summaryMode?: SummaryMode;
  /** 单次调用 token 预算；`single` / `auto` 必填且须为正整数。 */
  singleCallBudgetTokens?: number;
  /** `auto` 最大递归拆分深度（缺省 2）；到达该深度的超预算叶子回退到 `chunked`。 */
  summaryMaxSplitDepth?: number;
  /** token / 分块决策前对（已滤掉水位消息的）前缀做同长度投影；不得改变条数或顺序。 */
  summaryProjection?: (messages: Message[]) => Message[];
  readonly buildMergePrompt?: (partials: readonly string[]) => string;
}

/**
 * 总结前缀并返回最终摘要。`chunked` 与旧实现逐字节一致；`single` 严格调用一次；
 * `auto` 在预算内单次调用、超预算递归左右拆分再合并。**全有或全无**：任何叶子或合并失败都抛错，
 * 不返回部分结果（partials 仅存在于本函数栈帧内）。
 */
export async function summarizeCompactionPrefix(
  input: SummarizeCompactionPrefixInput,
): Promise<string> {
  const summarizablePrefix = input.prefix.filter(
    (message) => !isContextWatermarkMessage(message),
  );
  const projected =
    input.summaryProjection === undefined
      ? summarizablePrefix
      : input.summaryProjection(summarizablePrefix);
  if (projected.length !== summarizablePrefix.length) {
    throw new Error(
      "summarizeCompactionPrefix: summaryProjection must preserve message count",
    );
  }

  // 单条顺序计数器：所有调用（含 auto 各叶子的分块与各级合并）共享同一套 chunk 编号。
  let chunkCursor = 0;
  const callSummarize = async (messages: Message[]): Promise<string> => {
    const chunk = chunkCursor;
    chunkCursor += 1;
    const onDelta =
      input.onDelta === undefined
        ? undefined
        : (delta: SummarizeDelta) => input.onDelta?.({ ...delta, chunk });
    return await input.summarize(messages, input.ctx, onDelta);
  };

  const summarizeChunked = async (messages: Message[]): Promise<string> => {
    const chunks = chunkMessagesForSummary(messages, input.summaryChunkTokens);
    // 单块（含空输入）与旧实现逐字节一致：原样传该块（chunks[0] ?? []），不额外合并。
    if (chunks.length <= 1) {
      return await callSummarize(chunks[0] ?? []);
    }
    const partials: string[] = [];
    for (const chunk of chunks) {
      partials.push(await callSummarize(chunk));
    }
    // 合并失败不降级为拼接：all-or-nothing，异常交给调用方。
    return await callSummarize([
      createUserMessage((input.buildMergePrompt ?? buildSummaryMergePrompt)(partials)),
    ]);
  };

  const budget = input.singleCallBudgetTokens;
  const mode: SummaryMode =
    input.summaryMode ?? (budget === undefined ? "chunked" : "auto");
  if (mode === "chunked") {
    return await summarizeChunked(projected);
  }
  if (budget === undefined) {
    throw new Error(
      `summarizeCompactionPrefix: summaryMode "${mode}" requires singleCallBudgetTokens`,
    );
  }
  assertPositiveInteger(budget, "singleCallBudgetTokens");

  const summarizeSingle = async (messages: Message[]): Promise<string> =>
    await callSummarize(
      messages.map((message) => capMessageForSummary(message, budget)),
    );

  if (mode === "single") {
    return await summarizeSingle(projected);
  }

  const maxSplitDepth = input.summaryMaxSplitDepth ?? 2;
  if (!Number.isSafeInteger(maxSplitDepth) || maxSplitDepth < 0) {
    throw new Error(
      `summarizeCompactionPrefix: summaryMaxSplitDepth must be an integer >= 0 (got ${String(maxSplitDepth)})`,
    );
  }

  const summarizeAuto = async (
    messages: Message[],
    depth: number,
  ): Promise<string> => {
    if (estimateTokensByChars(messages) <= budget) {
      return await summarizeSingle(messages);
    }
    if (depth >= maxSplitDepth) {
      return await summarizeChunked(messages);
    }
    const split = selectSplitBoundary(messages);
    if (split === null) {
      return await summarizeChunked(messages);
    }
    const left = await summarizeAuto(messages.slice(0, split), depth + 1);
    const right = await summarizeAuto(messages.slice(split), depth + 1);
    return await callSummarize([
      createUserMessage((input.buildMergePrompt ?? buildSummaryMergePrompt)([left, right])),
    ]);
  };

  return await summarizeAuto(projected, 0);
}
