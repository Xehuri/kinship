/**
 * 流式占位符生命周期
 *
 * 从 useStreamingMessage 拆出的占位符建立/复用与错误文本追加逻辑。
 * 不再直接读取模块级 _messagesRef, 而是由调用方传入 messages 数组,
 * 使函数独立可测且不含隐式依赖。
 */

import type { ChatMessage } from '@/types'
import { createLocalMessageId, getStableMessageId, LOCAL_MESSAGE_ID_PREFIX } from './messageId'

/**
 * 判断消息是否已绑定后端消息 id (即非本地占位符 id)
 *
 * 本地占位符 id 以 LOCAL_MESSAGE_ID_PREFIX 开头; 绑定后端 id 后用于按消息边界切分。
 */
function isBoundToBackend(msg: ChatMessage): boolean {
  const id = getStableMessageId(msg)
  return !!id && !id.startsWith(LOCAL_MESSAGE_ID_PREFIX)
}

/**
 * 确保存在流式占位符消息
 *
 * 场景A: sendMessage 已创建占位符 → 直接复用
 * 场景B: 其他设备发消息 / 切换到流式进行中的会话 → 自动创建
 * 场景C: loadChatHistory 加载了不完整消息 (无文本或有 running 工具) → 标记为 streaming 并复用
 * 场景D: SSE 事件携带 messageID 且历史中已有同 id 消息 → 按 id 复用, 避免历史 + SSE 重复 (C4)
 *
 * 背景: SSE 的 message.part.updated/delta 事件需要 messages.value 中存在
 * isStreaming=true 的占位符才能写入。旧代码该占位符仅在 sendMessage 中创建,
 * 导致"必须发消息才渲染 SSE"——其他设备/子会话的事件因无占位符被静默丢弃。
 *
 * @param msgs 当前消息列表 (来自注入的 messages ref)
 * @param messageId 可选, SSE 事件携带的后端消息 id (用于按 id 复用历史消息)
 */
export function ensureStreamingPlaceholder(
  msgs: ChatMessage[] | undefined,
  messageId?: string,
): ChatMessage | null {
  if (!msgs) return null

  // 0. 按后端消息 id 精确复用 (C4): SSE 事件携带 messageID 时, 若历史中已有同 id
  //    消息 (loadChatHistory 加载的进行中消息), 直接复用它而非新建占位符,
  //    避免历史 + SSE 产生重复。仅检查最后一条 assistant (流式消息必然最新)。
  if (messageId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (getStableMessageId(m) !== messageId) continue
      // 命中用户消息: 正文由乐观气泡/历史渲染, 不写入 parts, 返回 null 由调用方跳过
      if ((m.role || m.info?.role) !== 'assistant') return null
      m.isStreaming = true
      if (!m.parts) m.parts = []
      return m
    }
  }

  // 1. 复用"尚未绑定后端 id"的流式占位符 (sendMessage 创建或之前自动创建)。
  //    关键: 只复用未绑定后端 id 的占位符。若占位符已绑定其他后端 messageID,
  //    说明 OpenCode 已进入新的一"步"(新的 assistant message), 必须新建占位符,
  //    否则同一请求内多步输出会被合并进同一条消息。
  const existing = msgs.find(m =>
    m.isStreaming === true &&
    (m.role || m.info?.role) === 'assistant' &&
    !isBoundToBackend(m),
  )
  if (existing) return existing

  // 2. 仅当事件未携带后端 messageID 时, 兜底复用最后一条不完整的 assistant
  //    (loadChatHistory 加载的中间状态)。携带 messageID 且未命中时不复用其他消息,
  //    以保证严格按消息边界切分。
  if (!messageId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if ((m.role || m.info?.role) !== 'assistant') continue
      const parts = m.parts || []
      const hasText = parts.some(p => p.type === 'text' && p.text && p.text.trim().length > 0)
      const hasRunningTool = parts.some(p =>
        (p.type === 'tool' || p.type === 'tool_call') && p.state?.status === 'running'
      )
      // 仅有工具调用但文本为空, 或还有 running 的工具 → 视为不完整, 复用
      if (!hasText || hasRunningTool) {
        m.isStreaming = true
        if (!m.parts) m.parts = []
        return m
      }
      // 最后一条 assistant 已有文本内容 → 视为完成, 不复用
      break
    }
  }

  // 3. 全新创建占位符
  const placeholder: ChatMessage = {
    id: createLocalMessageId(),
    role: 'assistant',
    parts: [],
    isStreaming: true,
    timestamp: new Date().toISOString(),
  }
  msgs.push(placeholder)
  return placeholder
}

/**
 * 将错误文本追加到当前流式消息 (无则创建) — T-C5
 *
 * 错误必须可见, 因此即使是"全新错误"也创建带错误文本的消息。
 *
 * @param msgs 当前消息列表 (来自注入的 messages ref)
 * @param message 可读错误文本
 */
export function appendErrorText(msgs: ChatMessage[] | undefined, message: string): void {
  const msg = ensureStreamingPlaceholder(msgs)
  if (!msg) return
  if (!msg.parts) msg.parts = []
  msg.parts.push({ type: 'text', text: '[错误] ' + message })
}
