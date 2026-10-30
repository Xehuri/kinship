/**
 * 聊天历史消息合并 (C4)
 *
 * 从 useChat 拆出的纯函数, 负责历史消息与本地消息的按稳定 id 去重合并:
 *   - mergeChatMessages:   历史为主体, 保留本地仍在流式的占位符 (首次加载 / 重同步)
 *   - prependChatMessages: 更早一页在前, 拼接现有消息 (向上分页)
 */

import type { ChatMessage } from '@/types'
import { getStableMessageId } from '@/composables/useStreamingMessage'

/**
 * 合并历史消息与本地消息 (C4)
 *
 * 以归一化后的历史消息为主体 (保持 API 顺序), 按稳定 id 去重:
 *   - 历史内部重复 id 只保留首次出现;
 *   - 本地仍处于流式进行中的占位符若未出现在历史中, 保留在末尾,
 *     避免正在流式渲染的回复被历史覆盖丢失。
 *
 * @param history 归一化后的历史消息
 * @param existing 现有本地消息
 * @returns 合并后的消息数组
 */
export function mergeChatMessages(history: ChatMessage[], existing: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>()
  const merged: ChatMessage[] = []

  // 历史消息为主体, 保持 API 顺序并按 id 去重
  for (const msg of history) {
    const id = getStableMessageId(msg)
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    merged.push(msg)
  }

  // 保留历史中不存在的活跃流式占位符 (历史尚未落库的进行中消息)
  for (const msg of existing) {
    if (msg.isStreaming !== true) continue
    const id = getStableMessageId(msg)
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    merged.push(msg)
  }

  return merged
}

/**
 * 前插更早的历史消息 (分页)
 *
 * 以更早一页 (older) 为主体放在前面, 再拼接现有消息 (existing),
 * 按稳定 id 去重, 保证时间顺序 (更早在前) 且不产生重复。
 *
 * @param older 归一化后的更早历史消息
 * @param existing 现有本地消息
 * @returns 合并后的消息数组
 */
export function prependChatMessages(older: ChatMessage[], existing: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>()
  const merged: ChatMessage[] = []

  // 更早的消息在前, 保持 API 顺序并按 id 去重
  for (const msg of older) {
    const id = getStableMessageId(msg)
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    merged.push(msg)
  }

  // 拼接现有消息, 跳过与更早页重复的部分
  for (const msg of existing) {
    const id = getStableMessageId(msg)
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    merged.push(msg)
  }

  return merged
}
