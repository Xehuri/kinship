/**
 * session.queue 事件处理 (Loom 外部发送)
 *
 * Loom 不为用户消息发 message.updated/part 事件, 只在每次 send() 时推
 * session.queue { pending:[{text,at,state}] }。pending 按 queued -> running
 * -> drained 反复推送同一批条目, 因此去重必须以 (text, at) 为键, 不能只看文本。
 *
 * 生成的用户消息刻意不带稳定 id: 历史接口落库后由 mergeChatMessages 按
 * "保留流式消息" 的规则丢弃临时消息, 用历史版本替换, 避免永久重复。
 */

import type { ChatMessage, SSEProperties, SSESessionQueueItem } from '@/types'
import { stripAxeuhHomeSystem } from '@/utils/axeuhEnvelope'
import { debugLog } from './debug'
import { getStableMessageId } from './messageId'

/** 本地乐观气泡 (无 info.time.created) 与 queue at 的匹配窗口 (毫秒) */
export const QUEUE_LOCAL_DEDUPE_WINDOW_MS = 15000

/** queue 处理器依赖的最小状态访问面 */
export interface QueueHandlerDeps {
  /** 读取注入的 messages 列表 */
  getMessages: () => ChatMessage[] | undefined
}

/** queue 事件处理器集合 */
export interface QueueHandlers {
  handleSessionQueue: (props: SSEProperties, isActiveSession: boolean) => void
}

function messageRole(msg: ChatMessage): string {
  return msg.role || msg.info?.role || ''
}

function userMessageText(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content
  if (typeof msg.text === 'string') return msg.text
  const parts = msg.parts ?? []
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
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

/**
 * 把命中的本地乐观气泡盖成已对账状态: 记录 queue 的 at 作为创建时间,
 * 后续同 at 快照即可用 info.time.created 精确去重 (不再依赖 15s 窗口)。
 * 刻意不写稳定 id: 历史接口落库后仍由 mergeChatMessages 用历史版本替换。
 */
function stampMatchedLocalBubble(msg: ChatMessage, at: number): void {
  const info: NonNullable<ChatMessage['info']> = msg.info ?? { role: 'user' }
  info.role = 'user'
  info.time = { ...info.time, created: at }
  msg.info = info
  msg.timestamp = new Date(at).toISOString()
}

/**
 * 判断 queue 条目是否已存在, 命中本地乐观气泡时顺带盖时间戳。
 *
 * Loom 的 queue 文本带 <Axeuh-home-system> 信封, 本地气泡只存原文,
 * 所以两侧都先剥离信封再比较。
 */
function markQueuedUserPresent(msgs: ChatMessage[], item: SSESessionQueueItem): boolean {
  const itemText = stripAxeuhHomeSystem(item.text)
  for (const msg of msgs) {
    if (messageRole(msg) !== 'user') continue
    if (stripAxeuhHomeSystem(userMessageText(msg)) !== itemText) continue

    const created = msg.info?.time?.created
    if (typeof created === 'number' && Number.isFinite(created)) {
      if (created === item.at) return true
      continue
    }

    if (getStableMessageId(msg)) continue

    const ts = messageTimestampMs(msg)
    if (ts !== undefined && Math.abs(ts - item.at) <= QUEUE_LOCAL_DEDUPE_WINDOW_MS) {
      stampMatchedLocalBubble(msg, item.at)
      return true
    }
  }
  return false
}

function normalizeQueueItem(value: unknown): SSESessionQueueItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const { text, at, state } = item
  if (typeof text !== 'string' || !text) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (state !== 'queued' && state !== 'running' && state !== 'drained') return null
  return { text, at, state }
}

function createQueueUserMessage(item: SSESessionQueueItem): ChatMessage {
  return {
    role: 'user',
    content: stripAxeuhHomeSystem(item.text),
    timestamp: new Date(item.at).toISOString(),
    info: { role: 'user', time: { created: item.at } },
  }
}

/**
 * 创建 session.queue 事件处理器。
 *
 * 只处理活跃会话; pending 为空或条目非法时不做任何变更, 且从不删除
 * 已创建的用户消息 (drained/空快照只用于去重, 不撤销历史)。
 */
export function createQueueHandlers(deps: QueueHandlerDeps): QueueHandlers {
  function handleSessionQueue(props: SSEProperties, isActiveSession: boolean): void {
    if (!isActiveSession) return

    const msgs = deps.getMessages()
    if (!msgs) return

    const pending = props.pending
    if (!Array.isArray(pending)) return

    for (const raw of pending) {
      const item = normalizeQueueItem(raw)
      if (!item) continue
      if (markQueuedUserPresent(msgs, item)) continue

      msgs.push(createQueueUserMessage(item))
      debugLog('[SSE-DBG] session.queue 创建外部用户消息:', stripAxeuhHomeSystem(item.text), 'at:', item.at)
    }
  }

  return { handleSessionQueue }
}
