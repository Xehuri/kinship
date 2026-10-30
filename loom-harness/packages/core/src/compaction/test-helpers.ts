/**
 * T19 测试基建：消息构造器 + 内存 L0 sink（duck-typed 同时满足 BoundarySinkLike 与
 * assembly ShardSourceLike，装配断言直接复用）。仅测试目录使用。
 */

import { createUserMessage } from "../index.js";
import type { Message } from "../index.js";
import type { BoundarySinkLike } from "./boundary.js";
import type { TokenCounter } from "../plugins/auto-compaction.js";

export type { Message };

/**
 * 确定性可加计数器：ASCII 按 chars/4（向上取整）、每条 +4 格式开销。
 * 与 vendor estimateRequestTokens 的 ASCII 段同规则，测试里体量可手算。
 */
export const chars4Counter: TokenCounter = {
  estimate({ messages }) {
    let n = 0;
    for (const m of messages) n += Math.ceil(textOf(m).length / 4) + 4;
    return n;
  },
};

export type Row = { readonly [key: string]: unknown };

/** 提取消息文本（string content 或 text 块拼接）。 */
export function textOf(m: Message): string {
  return typeof m.content === "string"
    ? m.content
    : m.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("");
}

export function user(text: string): Message {
  return createUserMessage(text);
}

/** 造一条 toolResult 消息（形状同 plugins microcompact 测试惯例）。 */
export function tr(toolName: string, text: string, callId = toolName + "-c"): Message {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  } as Message;
}

/**
 * 内存 L0：一行一条 turn 记录。
 * `readAfter/turnCount` 对齐 SessionShards 形状（装配测试复用同一实例）。
 */
export class MemorySink implements BoundarySinkLike {
  readonly rows: Row[] = [];

  appendTurn(turn: Row): void {
    this.rows.push(turn);
  }

  readAfter(startTurn: number): { readonly rows: readonly Row[]; readonly openedShards: number } {
    const from = Math.max(0, startTurn);
    return { rows: this.rows.slice(from), openedShards: this.rows.length > from ? 1 : 0 };
  }

  turnCount(): number {
    return this.rows.length;
  }
}
