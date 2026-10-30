/**
 * 外部用户消息对账 (message.updated role=user)
 *
 * OpenCode 会为外部客户端发来的消息推送 message.updated(user), 但本页面可能
 * 没有对应的本地乐观气泡。对账规则:
 *   1. 移除时序导致的误建 assistant 占位符;
 *   2. 仅当尾部用户气泡是待发送的本地乐观消息 (或 queue 临时消息) 时绑定 id;
 *   3. 否则创建带 id 的空正文用户气泡, 由后续用户 part 填充。
 *
 * 绑定必须限制在"尾部" (其后全是流式 assistant), 否则本地在途发送会被
 * 外部消息抢占 id, 造成上一条回复被并进新轮次。
 *
 * 同一 msgId 的重复 message.updated 必须幂等 (SSE 历史重放 / 后端重复推送)。
 */

import type { ChatMessage } from '@/types'
import { getStableMessageId } from './messageId'

/** 本地乐观气泡 (无 info.time.created) 与 message.updated 的匹配窗口 (毫秒) */
const LOCAL_SEND_MATCH_WINDOW_MS = 15000

function messageRole(msg: ChatMessage): string {
  return msg.role || msg.info?.role || ''
}

function messageTimestampMs(msg: ChatMessage): number | undefined {
  for (const raw of [msg.timestamp, msg.created_at]) {
    if (typeof raw === 'string' && raw) {
      const parsed = Date.parse(raw)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return undefined
}

function isPendingTailUser(
  msgs: ChatMessage[],
  index: number,
  createdAt: number | undefined,
): boolean {
  for (let i = index + 1; i < msgs.length; i++) {
    if (messageRole(msgs[i]) !== 'assistant' || msgs[i].isStreaming !== true) return false
  }

  const created = msgs[index].info?.time?.created
  if (typeof created === 'number' && Number.isFinite(created)) {
    return createdAt === undefined || created === createdAt
  }

  const ts = messageTimestampMs(msgs[index])
  if (ts === undefined) return false
  return Math.abs(ts - (createdAt ?? Date.now())) <= LOCAL_SEND_MATCH_WINDOW_MS
}

/**
 * 把外部 message.updated(user) 对账到消息列表 (原地修改)。
 */
export function reconcileUserMessage(
  msgs: ChatMessage[],
  msgId: string,
  createdAt?: number,
): void {
  const badIdx = msgs.findIndex(
    (m) => getStableMessageId(m) === msgId && messageRole(m) === 'assistant',
  )
  if (badIdx >= 0) {
    msgs.splice(badIdx, 1)
  }

  const existingUser = msgs.find(
    (m) => getStableMessageId(m) === msgId && messageRole(m) === 'user',
  )
  if (existingUser) return

  let lastUserIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (messageRole(msgs[i]) === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx >= 0) {
    const candidate = msgs[lastUserIdx]
    if (!getStableMessageId(candidate) && isPendingTailUser(msgs, lastUserIdx, createdAt)) {
      candidate.id = msgId
      if (!candidate.info) candidate.info = { role: 'user' }
      candidate.info.id = msgId
      if (createdAt !== undefined && candidate.info.time?.created === undefined) {
        candidate.info.time = { ...candidate.info.time, created: createdAt }
      }
      return
    }
  }

  const info: NonNullable<ChatMessage['info']> = { role: 'user' }
  const external: ChatMessage = { id: msgId, role: 'user', info, content: '' }
  if (createdAt !== undefined) {
    info.time = { created: createdAt }
    external.timestamp = new Date(createdAt).toISOString()
  }
  msgs.push(external)
}
