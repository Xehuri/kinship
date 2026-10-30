/**
 * 流式消息标识工具 (C4)
 *
 * 从 useStreamingMessage 拆出的消息 ID 相关纯函数与模块级序号:
 *   - 本地占位符 id 生成 (local-*)
 *   - 稳定消息 id 解析 (顶层 id / info.id)
 *   - SSE 事件携带的后端消息 id 绑定到流式占位符
 *
 * 这些函数本身不持有响应式状态, 供 useStreamingMessage 主文件与
 * placeholder / partHandlers 复用。
 */

import type { ChatMessage, MessagePart } from '@/types'

/** 带 partId 的消息 Part (用于 SSE partId 查找，不修改原类型) */
export interface PartWithId extends MessagePart {
  _partId?: string
}

/** 本地占位符消息 id 前缀 (与后端消息 id 区分) */
export const LOCAL_MESSAGE_ID_PREFIX = 'local-'

/** 本地占位符 id 序号 (模块级, 保证同一列表内唯一) */
let _localMessageSeq = 0

/**
 * 生成本地占位符消息 id (C4)
 *
 * SSE 占位符创建时还没有后端 message id, 先分配一个稳定的本地 id;
 * SSE 事件携带 messageID 后再升级为后端 id (见 adoptMessageId),
 * 使历史消息与实时消息可按同一 id 合并去重。
 */
export function createLocalMessageId(): string {
  _localMessageSeq++
  return LOCAL_MESSAGE_ID_PREFIX + _localMessageSeq
}

/**
 * 解析消息的稳定标识 (C4)
 *
 * 优先取顶层 id, 回退 info.id; 都没有时返回空字符串。
 * 供历史合并去重与 Vue 列表 key 使用, 避免退化为数组索引。
 */
export function getStableMessageId(msg: ChatMessage): string {
  if (typeof msg.id === 'string' && msg.id) return msg.id
  const infoId = msg.info?.id
  if (typeof infoId === 'string' && infoId) return infoId
  return ''
}

/**
 * 将 SSE 事件携带的后端消息 id 绑定到流式占位符 (C4)
 *
 * 占位符创建时只有本地 id (local-*), 历史接口返回的消息使用后端 id。
 * 若不在 SSE 阶段绑定后端 id, 历史 + SSE 会因 id 不同而重复。
 * 仅当占位符尚未绑定后端 id 时才写入, 避免误认领其他消息。
 */
export function adoptMessageId(msg: ChatMessage, messageId: string | undefined): void {
  if (!messageId) return
  const current = getStableMessageId(msg)
  if (current === messageId) return
  // 已绑定其他后端 id: 事件可能属于另一条消息, 不覆盖
  if (current && !current.startsWith(LOCAL_MESSAGE_ID_PREFIX)) return

  msg.id = messageId
  if (!msg.info) {
    msg.info = { role: 'assistant' }
  }
  msg.info.id = messageId
}
