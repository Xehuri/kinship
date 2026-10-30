/**
 * 聊天历史响应解析
 *
 * 从 useChat 拆出的纯函数, 负责:
 *   - 解析 /api/screen/session/{id}/messages 的响应形态 (裸数组 / 包装对象 / 异常结构)
 *     与翻页游标 (next_cursor);
 *   - 从归一化后的历史消息中提取最新一条 assistant 的 token 用量 (C7, 路径2)。
 */

import type { ChatMessage, TokenUsage } from '@/types'
import type { RawHistoryMessage } from '@/utils/messageNormalize'
import { normalizeTokenUsage } from '@/utils/tokenUsage'

/** 历史接口可能返回的响应体形态 */
export type HistoryResponseData =
  | { messages?: RawHistoryMessage[]; next_cursor?: string | null }
  | RawHistoryMessage[]
  | null
  | undefined

/** 解析后的历史响应 */
export interface ParsedHistoryResponse {
  /** 归一化前的历史消息; null 表示响应结构异常 (视为空会话) */
  messages: RawHistoryMessage[] | null
  /** 更早一页的翻页游标; null 表示没有更早消息 */
  cursor: string | null
}

/**
 * 解析历史接口响应 (FE-M9 容错)
 *
 * - 裸数组: 无游标信息, 视为没有更早消息;
 * - 包装对象: 取 messages + next_cursor;
 * - 其余结构: messages 返回 null, 由调用方视为空会话处理。
 */
export function parseHistoryResponse(data: HistoryResponseData): ParsedHistoryResponse {
  if (Array.isArray(data)) {
    return { messages: data, cursor: null }
  }
  const result = data?.messages
  if (Array.isArray(result)) {
    return { messages: result, cursor: data?.next_cursor ?? null }
  }
  return { messages: null, cursor: null }
}

/**
 * 从历史消息中提取最新一条有效 token 用量 (C7, 路径2)
 *
 * 使用共享归一化 (接受 total 或 input/output, 仅有分项时推导 total),
 * 与 SSE 实时路径保持一致; 从后向前找到第一条有有效用量的消息即返回。
 */
export function extractLatestHistoryTokens(messages: ChatMessage[]): TokenUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = normalizeTokenUsage(messages[i].info?.tokens)
    if (tokens) return tokens
  }
  return null
}
