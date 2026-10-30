/**
 * summary-projection —— full summarize 的「模型可见视图」纯投影。
 *
 * 背景：压缩失败案例里摘要吃的是**原始历史**（约 4.97M tokens，50×100k 分块），而模型实际看到的是
 * microcompact 之后的视图（约 0.56M tokens）。把旧的、可重取的工具输出先换成同一个占位符再送给
 * summarize，摘要输入才与模型所见一致；完整工具输出仍由内核 durable 保存，需要时可重新调用工具。
 *
 * 纯函数：不调 LLM、不读写 store、不 import `auto-compaction` / `microcompact`（避免环）。
 * 占位符与 `microcompact` 默认文案逐字节一致，字符口径也相同（text 块长度相加，image 记 1）。
 *
 * 保留策略：只清「最近 keepRecent 条 toolResult」之外的、`compactableTools` 白名单内的 toolResult；
 * 数组长度/顺序/角色不变，user/assistant 与非白名单 toolResult 原样保留。已投影过的条目不会二次套壳。
 */

import type { Message } from "@earendil-works/pi-ai";

type ToolResult = Extract<Message, { role: "toolResult" }>;

export interface SummaryProjectionOptions {
  /** 只清这些工具产生的 toolResult（调用方传入，domain-free）。 */
  readonly compactableTools: ReadonlySet<string>;
  /** 永远原样保留的最近 N 条 toolResult（按 toolResult 全局计数，不分工具）。负数视为 0。 */
  readonly keepRecent: number;
}

/** microcompact 默认占位符的唯一真源；`microcompact.ts` 复用它以保证逐字节一致。 */
export function summaryProjectionPlaceholder(toolName: string, chars: number): string {
  return `[microcompact: ${toolName} output cleared, ~${chars} chars]`;
}

/** toolResult 的 content 文本总字符数（与 microcompact 的 contentChars 同口径）。 */
function contentChars(content: ToolResult["content"]): number {
  let n = 0;
  for (const block of content) {
    if (block.type === "text") n += block.text.length;
    else if (block.type === "image") n += 1; // 图片不按 base64 长度计，象征性记 1
  }
  return n;
}

/** 该 toolResult 是否已经是本 helper 的占位符（幂等判据，避免二次套壳改变 chars）。 */
function isProjectedPlaceholder(msg: ToolResult): boolean {
  if (msg.content.length !== 1) return false;
  const block = msg.content[0]!;
  if (block.type !== "text") return false;
  const prefix = `[microcompact: ${msg.toolName} output cleared, ~`;
  if (!block.text.startsWith(prefix)) return false;
  return /^\d+ chars\]$/.test(block.text.slice(prefix.length));
}

/**
 * 返回一份新数组：把旧的、白名单工具的 toolResult 换成与 microcompact 相同的占位符。
 * 不入参数组/消息；最近 keepRecent 条 toolResult（全局计数）原样保留；短列表为 no-op。
 */
export function projectToolResultsForSummary(
  messages: readonly Message[],
  opts: SummaryProjectionOptions,
): Message[] {
  const keepRecent = Math.max(0, Math.floor(opts.keepRecent));
  const out = messages.slice();

  const toolResultIdxs: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.role === "toolResult") toolResultIdxs.push(i);
  }

  const clearableCount = toolResultIdxs.length - keepRecent;
  if (clearableCount <= 0) return out;

  for (let rank = 0; rank < clearableCount; rank++) {
    const idx = toolResultIdxs[rank]!;
    const msg = out[idx] as ToolResult;
    if (!opts.compactableTools.has(msg.toolName)) continue;
    if (isProjectedPlaceholder(msg)) continue;
    out[idx] = {
      ...msg,
      content: [
        {
          type: "text" as const,
          text: summaryProjectionPlaceholder(msg.toolName, contentChars(msg.content)),
        },
      ],
    };
  }

  return out;
}
