/**
 * session.error / session.idle / session.compacted 事件处理
 *
 * 从 useStreamingMessage 拆出的会话级事件处理器, 通过 createSessionEventHandlers
 * 工厂注入主文件的状态访问器, 保持错误可见、流式结束、压缩分隔线插入等行为不变。
 */

import type { SSEProperties, ChatMessage, MessagePartType } from '@/types'
import { debugLog } from './debug'
import { appendErrorText } from './placeholder'
import { extractErrorMessage, resolveSessionId, type SessionStatus } from './sseParsing'

/** 会话事件处理器依赖的最小状态访问面 (由主文件注入) */
export interface SessionHandlerDeps {
  /** 读取注入的 messages 列表 */
  getMessages: () => ChatMessage[] | undefined
  /** 更新会话状态映射 */
  setSessionStatus: (sessionId: string, status: SessionStatus) => void
  /** 完成流式渲染 */
  finalizeStreaming: () => void
  /** 当前是否存在流式输出 */
  isStreaming: () => boolean
}

/** 会话事件处理器集合 */
export interface SessionEventHandlers {
  handleSessionError: (
    props: SSEProperties,
    eventSessionId: string | undefined,
    isActiveSession: boolean,
  ) => void
  handleSessionIdle: (props: SSEProperties, isActiveSession: boolean) => void
  handleSessionCompacted: (props: SSEProperties, isActiveSession: boolean) => void
}

/**
 * 创建会话事件处理器
 */
export function createSessionEventHandlers(deps: SessionHandlerDeps): SessionEventHandlers {
  /**
   * session.error: 会话错误必须可见并结束流式, 否则 isStreaming 会悬挂到 120s 超时 (T-C5)
   */
  function handleSessionError(
    props: SSEProperties,
    eventSessionId: string | undefined,
    isActiveSession: boolean,
  ): void {
    if (!isActiveSession) return
    const errMessage =
      extractErrorMessage(props.error) ||
      extractErrorMessage(props.message) ||
      '会话发生错误'
    debugLog('[SSE-DEBUG] session.error:', errMessage)
    appendErrorText(deps.getMessages(), errMessage)
    if (eventSessionId) {
      deps.setSessionStatus(eventSessionId, 'error')
    }
    deps.finalizeStreaming()
  }

  /**
   * session.idle: 更新会话状态并在活跃会话仍有流式输出时结束流式
   */
  function handleSessionIdle(props: SSEProperties, isActiveSession: boolean): void {
    const sid = resolveSessionId(props)
    if (sid) {
      deps.setSessionStatus(sid, 'idle')
      if (isActiveSession && deps.isStreaming()) {
        deps.finalizeStreaming()
      }
    }
  }

  /**
   * session.compacted: 在最后一条 assistant 消息后插入压缩分隔线
   */
  function handleSessionCompacted(props: SSEProperties, isActiveSession: boolean): void {
    if (!isActiveSession) return
    const msgs = deps.getMessages()
    if (!msgs) return
    // 找到最后一条 assistant 消息，在其后插入压缩分隔线
    let lastAsstIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      const role = msgs[i].role || msgs[i].info?.role
      if (role === 'assistant') {
        lastAsstIdx = i
        break
      }
    }
    const divider: ChatMessage = {
      role: 'assistant' as const,
      parts: [{ type: 'compaction' as MessagePartType, text: '上下文已压缩' }],
    }
    if (lastAsstIdx >= 0) {
      msgs.splice(lastAsstIdx + 1, 0, divider)
    } else {
      msgs.push(divider)
    }
    console.warn('[SSE] session.compacted: 已在消息列表中插入压缩分隔线, sessionId:', resolveSessionId(props))
  }

  return { handleSessionError, handleSessionIdle, handleSessionCompacted }
}
