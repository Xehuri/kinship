/**
 * message.part.updated / message.part.delta 事件处理
 *
 * 从 useStreamingMessage 拆出的两个 part 事件处理器, 通过 createPartHandlers
 * 工厂注入主文件的响应式状态访问器 (messages / 活跃会话 / 会话状态 / finalize),
 * 使处理器保持对中央 Store 的写入行为不变, 同时不直接依赖模块级单例状态。
 */

import type { SSEProperties, SSEMessagePart, ChatMessage, MessagePart } from '@/types'
import { stripAxeuhHomeSystem } from '@/utils/axeuhEnvelope'
import { debugLog } from './debug'
import { adoptMessageId, getStableMessageId, type PartWithId } from './messageId'
import { appendErrorText, ensureStreamingPlaceholder } from './placeholder'
import {
  extractErrorMessage,
  findPartIndex,
  isKnownPartType,
  type SessionStatus,
} from './sseParsing'

/** part 处理器依赖的最小状态访问面 (由主文件注入) */
export interface PartHandlerDeps {
  /** 读取注入的 messages 列表 */
  getMessages: () => ChatMessage[] | undefined
  /** 读取注入的活跃会话 ID ref 当前值 */
  getActiveSessionId: () => string
  /** 更新会话状态映射 */
  setSessionStatus: (sessionId: string, status: SessionStatus) => void
  /** 完成流式渲染 */
  finalizeStreaming: () => void
  /** 查询后端消息 id 对应的角色 (user/assistant), 用于区分用户消息的 part */
  getMessageRole?: (messageId: string) => string | undefined
}

/** part 事件处理器集合 */
export interface PartHandlers {
  handlePartUpdated: (props: SSEProperties, eventSessionId: string | undefined) => void
  handlePartDelta: (props: SSEProperties, eventSessionId: string | undefined) => void
}

/**
 * 创建 part 事件处理器
 */
export function createPartHandlers(deps: PartHandlerDeps): PartHandlers {
  /** 追加错误文本到当前流式消息 (无则创建) */
  function appendError(message: string): void {
    appendErrorText(deps.getMessages(), message)
  }

  /** 按后端消息 id 查找用户气泡 (只认 role=user, 避免误填 AI 占位符) */
  function findUserMessage(msgs: ChatMessage[], messageId: string): ChatMessage | undefined {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (getStableMessageId(msg) !== messageId) continue
      if ((msg.role || msg.info?.role) !== 'user') continue
      return msg
    }
    return undefined
  }

  /**
   * 用户 part 只填充外部用户气泡: 已有正文 (本地乐观气泡/已填充) 时跳过,
   * 绝不为用户 part 创建 assistant 占位符。
   *
   * 外部用户 part 可能携带 <Axeuh-home-system> 信封, 写入前剥离,
   * 使气泡显示与 session.queue / 历史口径一致。
   */
  function fillExternalUserText(
    msgs: ChatMessage[],
    messageId: string,
    text: string | undefined,
  ): void {
    if (!text) return
    const target = findUserMessage(msgs, messageId)
    if (!target) return
    if ((target.content ?? '') !== '' || (target.text ?? '') !== '') return
    target.content = stripAxeuhHomeSystem(text)
  }

  /**
   * 处理 message.part.updated 事件 — 在 messages.value 中找到流式消息并写入 parts
   */
  function handlePartUpdated(props: SSEProperties, eventSessionId: string | undefined): void {
    const msgs = deps.getMessages()
    if (!msgs) {
      debugLog('[SSE-DEBUG] handlePartUpdated: _messagesRef 未配置')
      return
    }

    // 会话匹配守卫 (W45 收紧): 活跃会话在场时, 事件 sessionID 必须与之相等;
    // 缺 sessionID 的帧 (双 hub 混合流下通道归属不明) 一律丢弃, 绝不放行到
    // 当前会话建占位符——这正是 07-15 串泡事故线 (loom 帧无标落入 opencode 会话)
    // 的根修。仅当活跃会话尚未初始化 (空串) 时不做过滤, 保持早期事件兼容。
    const activeSessionId = deps.getActiveSessionId()
    if (activeSessionId && eventSessionId !== activeSessionId) {
      debugLog('[SSE-DEBUG] handlePartUpdated: sessionId 不匹配/缺失! event:', eventSessionId || '-', 'active:', activeSessionId)
      return
    }

    const part = props.part as SSEMessagePart | undefined
    if (!part) return

    const partId = part.id
    if (!partId) return

    const partType = (part.type || '') as string

    // 忽略 step 事件
    if (partType === 'step-start' || partType === 'step-finish') return

    // T-C5: 错误 part: 显示错误并结束流式 (必须在创建占位符之前区分处理)
    if (partType === 'error') {
      const errMessage =
        extractErrorMessage(part.error) ||
        extractErrorMessage(part.message) ||
        part.text ||
        '发生错误'
      debugLog('[SSE-DEBUG] error part:', errMessage)
      appendError(errMessage)
      if (eventSessionId) {
        deps.setSessionStatus(eventSessionId, 'error')
      }
      deps.finalizeStreaming()
      return
    }

    // T-C5: 先校验 part 类型, 再决定是否创建占位符, 避免未知事件产生幽灵空占位符
    if (!isKnownPartType(partType)) return

    // 用户消息的 part 只填充外部用户气泡, 不写入 assistant 占位符,
    // 也不重复追加到已有正文的本地乐观气泡
    const partMsgId = props.messageID || part.messageID
    if (partMsgId && deps.getMessageRole?.(partMsgId) === 'user') {
      fillExternalUserText(msgs, partMsgId, part.type === 'text' ? part.text : undefined)
      debugLog('[SSE-DBG] 用户消息 part.updated 仅填充用户气泡:', partMsgId)
      return
    }

    // 走到这里说明事件归属已确认: sessionID 与活跃会话相等, 或活跃会话尚未初始化。
    // 找不到流式消息时自动创建, 仅覆盖两种情形: 当前会话在其他设备上的续流,
    // 与初始化前到达的早期事件; 异属/无标帧已在上方守卫处丢弃。
    // C4: 携带 messageID 以便按 id 复用历史消息, 避免历史 + SSE 重复
    const streamingMsg = ensureStreamingPlaceholder(msgs, partMsgId)
    if (!streamingMsg) return

    // 绑定后端消息 id 到占位符, 供后续历史合并去重
    adoptMessageId(streamingMsg, props.messageID || part.messageID)

    // 确保 parts 数组存在
    if (!streamingMsg.parts) {
      streamingMsg.parts = []
    }

    const idx = findPartIndex(streamingMsg.parts, partId)
    let msgPart: PartWithId

    // reasoning / thought
    if (partType === 'reasoning' || partType === 'thought') {
      msgPart = {
        type: partType as MessagePart['type'],
        text: part.text || '',
      }
    } else if (partType === 'text') {
      // text
      msgPart = {
        type: 'text',
        text: part.text || '',
      }
    } else if (partType === 'tool' || partType === 'tool_call') {
      // tool / tool_call
      const existing = idx >= 0 ? (streamingMsg.parts[idx] as PartWithId) : null
      const toolName = (part.tool || (existing?.tool || 'tool')) as string
      const toolState = part.state || {}
      const toolStatus = (toolState.status || (existing?.state?.status || 'running')) as string
      const newInput = toolState.input as Record<string, unknown> | undefined
      const toolInput = (newInput && Object.keys(newInput).length > 0
        ? newInput
        : (existing?.state?.input as Record<string, unknown> || {}))
      const toolOutput = (toolState.output || (existing?.state?.output as string || '')) as string

      msgPart = {
        type: 'tool',
        text: (existing?.text as string) || '',
        tool: toolName,
        state: { status: toolStatus, input: toolInput, output: toolOutput },
      }
    } else if (partType === 'tool_result') {
      // tool_result: 合并到已有 tool part
      const existing = idx >= 0 ? streamingMsg.parts[idx] : null
      if (existing && (existing.type === 'tool' || existing.type === 'tool_result')) {
        existing.text = part.text || ''
        debugLog('[SSE-DBG] part 写入成功! partId:', partId, 'parts数量:', streamingMsg.parts.length)
      }
      msgPart = {
        type: 'tool_result',
        text: part.text || '',
      }
    } else {
      return // 未知类型，忽略
    }

    // 写入 partId 用于后续 delta 查找
    msgPart._partId = partId

    // 写入或替换
    if (idx >= 0) {
      streamingMsg.parts.splice(idx, 1, msgPart)
    } else {
      streamingMsg.parts.push(msgPart)
    }
  }

  /**
   * 处理 message.part.delta 事件 — 在 messages.value 中找到流式消息并追加文本
   */
  function handlePartDelta(props: SSEProperties, eventSessionId: string | undefined): void {
    const msgs = deps.getMessages()
    if (!msgs) return

    // 会话匹配守卫 (W45 收紧, 与 handlePartUpdated 同一规则):
    // 活跃会话在场时缺 sessionID 的 delta 同样丢弃。
    const activeSessionId = deps.getActiveSessionId()
    if (activeSessionId && eventSessionId !== activeSessionId) return

    const partId = props.partID
    const field = props.field
    const delta = props.delta || ''

    // T-C5: 先校验 delta 有效性, 再创建占位符, 避免无效事件产生幽灵占位符
    if (!partId || field !== 'text' || !delta) return

    // 用户消息的 part 只填充外部用户气泡 (已有正文时跳过)
    const messageId = props.messageID
    if (messageId && deps.getMessageRole?.(messageId) === 'user') {
      fillExternalUserText(msgs, messageId, delta)
      debugLog('[SSE-DBG] 用户消息 part.delta 仅填充用户气泡:', messageId)
      return
    }

    // 归属已确认 (同 handlePartUpdated): 自动创建仅覆盖当前会话在其他设备上的
    // 续流与初始化前的早期事件, 异属/无标帧已在上方守卫处丢弃。
    // C4: 携带 messageID 以便按 id 复用历史消息, 避免历史 + SSE 重复
    const streamingMsg = ensureStreamingPlaceholder(msgs, messageId)
    if (!streamingMsg) return

    // 绑定后端消息 id 到占位符, 供后续历史合并去重
    adoptMessageId(streamingMsg, messageId)

    // 确保 parts 数组存在
    if (!streamingMsg.parts) {
      streamingMsg.parts = []
    }

    let idx = findPartIndex(streamingMsg.parts, partId)

    // delta 可能先于 part.updated 到达，自动创建 part
    if (idx < 0) {
      const newPart: PartWithId = { type: 'text', text: '' }
      newPart._partId = partId
      streamingMsg.parts.push(newPart)
      idx = streamingMsg.parts.length - 1
    }

    const msgPart = streamingMsg.parts[idx]
    msgPart.text = (msgPart.text || '') + delta

    // 如果是 tool 类型，同时累积 toolOutput
    if (msgPart.type === 'tool' && msgPart.state) {
      msgPart.state.output = ((msgPart.state.output as string) || '') + delta
    }
  }

  return { handlePartUpdated, handlePartDelta }
}
