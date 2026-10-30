/**
 * T27 会话域 —— 历史分页（游标 x-next-cursor，D20 L0 文件游标语义）。
 *
 * 真源是注入的 `SessionStore`（协议在 core；落盘实现在 adapter）。分页语义对齐
 * opencode 现行为：**按时间升序返回**（旧→新）一页；响应头 `x-next-cursor` 是翻更早
 * 一页的游标（base64url 不透明串），调用方拿它作 `before` 参数取该页之前的历史。
 * 无更早消息时不给游标（null）。
 *
 * 游标内容 = 该页**最早一条 message** 的 store entry id。下一跳取「严格早于该 entry」
 * 的若干条，天然幂等、并发追加不重不漏（append-only 保证 entry id 稳定）。
 */

import type { Message, SessionStore } from "@axeuh/loom-core";

/** 单页响应。 */
export interface HistoryPage {
  readonly messages: readonly Message[];
  /** 翻更早一页的游标；null = 已到最早。 */
  readonly nextCursor: string | null;
}

/** 分页查询参数。 */
export interface HistoryQuery {
  /** 本页条数上限（已夹取到 [1, MAX_HISTORY_LIMIT]）。 */
  readonly limit: number;
  /** 游标：只取严格早于该 entry 的消息。 */
  readonly before?: string;
}

/** 单页默认条数（对齐 opencode get_session_messages_page 的挂起页大小）。 */
export const DEFAULT_HISTORY_LIMIT = 100;
/** 单页硬上限（防一次拉爆）。 */
export const MAX_HISTORY_LIMIT = 200;

/** 把 entry id 编成不透明游标（base64url；不含非法字符，前端可原样回传）。 */
export function encodeCursor(entryId: string): string {
  return Buffer.from(entryId, "utf8").toString("base64url");
}

/** 解游标；非法编码返回 null（路由层转 400，不 500）。 */
export function decodeCursor(cursor: string): string | null {
  const trimmed = cursor.trim();
  if (trimmed.length === 0) return null;
  try {
    return Buffer.from(trimmed, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/** 夹取 limit 到 [1, MAX_HISTORY_LIMIT]；非有限/非正数回缺省。 */
export function normalizeLimit(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_HISTORY_LIMIT;
  const floored = Math.floor(raw);
  if (floored < 1) return DEFAULT_HISTORY_LIMIT;
  return Math.min(floored, MAX_HISTORY_LIMIT);
}

/**
 * 读一页历史。路径来自 `store.getPathToLeaf`（root→leaf 升序）；只取 message 类 entry，
 * 跳过 compaction_boundary / terminal（那些不是对话消息）。
 */
export async function readHistoryPage(
  store: SessionStore,
  sessionID: string,
  query: HistoryQuery,
): Promise<HistoryPage> {
  const path = await store.getPathToLeaf(sessionID);
  const items: Array<{ id: string; message: Message }> = [];
  for (const stored of path) {
    if (stored.entry.kind === "message") {
      items.push({ id: stored.id, message: stored.entry.message });
    }
  }

  // 边界：`before` 指向的 entry 作右开端（不含）。找不到游标 = 已无更早（返回空页）。
  let end = items.length;
  if (query.before !== undefined) {
    const idx = items.findIndex((it) => it.id === query.before);
    if (idx < 0) return { messages: [], nextCursor: null };
    end = idx;
  }

  const start = Math.max(0, end - query.limit);
  const page = items.slice(start, end);
  const nextCursor = start > 0 && page.length > 0 ? encodeCursor(page[0]!.id) : null;
  return { messages: page.map((it) => it.message), nextCursor };
}
