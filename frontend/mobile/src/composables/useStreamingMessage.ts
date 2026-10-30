/**
 * 流式消息 Composable — SSE 流式渲染状态管理（集中式 Store 模式）
 *
 * 设计模式：messages.value 作为中央 Store，SSE 事件直接在 messages.value 中
 * 找到 isStreaming=true 的消息并修改其 parts，不需要占位符注册/注销。
 * Vue 的响应式系统自动处理 UI 渲染。
 *
 * 使用方式:
 *   const sm = useStreamingMessage()
 *   sm.configure({ messages, activeSessionId }) // 注入 messages ref
 *   sm.handleSSEEvent(data)  // SSE onmessage 中调用
 *   await sm.createPendingPromise()  // 等待流结束
 *
 * 结构: SSE 解析 / 占位符 / part 处理器 / 会话事件 / pending / 调试日志
 * 已拆分到 ./streaming/ 下, 本文件保留单例状态与对外 API。
 */

import { ref, computed, readonly, type Ref, type ComputedRef } from 'vue'
import type { SSEProperties, SSEPayload, ChatMessage, TokenUsage } from '@/types'
import { debugLog, nextSSELogCount } from './streaming/debug'
import { createPartHandlers } from './streaming/partHandlers'
import { createQueueHandlers } from './streaming/queueHandlers'
import { createSessionEventHandlers } from './streaming/sessionHandlers'
import { reconcileUserMessage } from './streaming/userReconcile'
import {
  createPendingReply,
  hasPendingReply as hasPendingReplyState,
  resolvePendingReply,
} from './streaming/pendingReply'
import { extractMessageTokens, parseSessionStatus, resolveSessionId, type SessionStatus } from './streaming/sseParsing'

// ==================== 公共 API 再导出 ====================
// 保持原有 public API surface 不变: 这些 helper 仍从本模块导出。
export { setSSEDebug } from './streaming/debug'
export {
  LOCAL_MESSAGE_ID_PREFIX,
  createLocalMessageId,
  getStableMessageId,
} from './streaming/messageId'

// ==================== 类型定义 ====================

/** useStreamingMessage 返回值 */
export interface UseStreamingMessageReturn {
  /** 是否正在流式渲染 */
  isStreaming: ComputedRef<boolean>
  /** 当前会话 Token 用量统计 (SSE 实时更新) */
  currentTokens: Readonly<Ref<TokenUsage | null>>
  /** 会话状态映射 (sessionId -> busy/idle/error) */
  sessionStatus: Readonly<Ref<Record<string, SessionStatus>>>
  /** 处理 SSE 事件 (在 SSE onmessage 中调用) */
  handleSSEEvent: (data: unknown) => void
  /** 完成流式渲染 (解析 pending promise, 标记消息完成) */
  finalizeStreaming: () => void
  /** 创建待回复 Promise (发送消息后等待 SSE) */
  createPendingPromise: () => Promise<void>
  /** 是否有待回复的 Promise */
  hasPendingReply: ComputedRef<boolean>
  /** 注入 messages ref 和 activeSessionId ref (由 useChat 初始化时调用) */
  configure: (options: { messages: Ref<ChatMessage[]>; activeSessionId: Ref<string> }) => void
  /** 更新当前会话 Token 用量 (供 useChat 从消息历史提取 tokens 时调用) */
  updateTokens: (tokens: TokenUsage | null) => void
  /** 重置流式状态 (登出时调用: 清 pending promise / sessionStatus / tokens) */
  resetStreamingState: () => void
  /** 设置活跃会话 ID (用于 SSE 事件过滤) */
  setActiveSessionId: (sessionId: string | null) => void
}

// ==================== 内部状态 ====================

/** 当前活跃会话 ID (仅由 configure / setActiveSessionId 写入, FE-M2) */
let _activeSessionId: string | null = null

/** 外部注入的 messages ref (指向 useChat 的 messages) */
let _messagesRef: Ref<ChatMessage[]> | null = null

/** 外部注入的 activeSessionId ref (指向 useChat 的 currentSessionId) */
let _activeSessionIdRef: Ref<string> | null = null

/** 标记 configure 已调用 (用于 isStreaming computed 依赖追踪) */
const _streamingConfigured = ref(false)

// ==================== Composable ====================

/**
 * 流式消息 Composable — SSE 流式渲染状态管理（集中式 Store 模式）
 */
export function useStreamingMessage(): UseStreamingMessageReturn {
  // ==================== 状态 ====================

  /** 会话状态映射 (sessionId -> busy/idle/error) */
  const sessionStatus = ref<Record<string, SessionStatus>>({})

  /** 当前会话 Token 用量 (SSE 实时更新) */
  const _currentTokens = ref<TokenUsage | null>(null)

  /** SSE 消息 id -> 角色 映射 (由 message.updated 填充, 用于区分用户消息的 part) */
  const _messageRoles = new Map<string, string>()

  /** 是否有活跃的流式输出 (在 messages.value 中查找 isStreaming=true) */
  const isStreaming = computed<boolean>(() => {
    // 依赖 configure 调用标记，确保配置后重新计算
    void _streamingConfigured.value
    return _messagesRef?.value?.some(m => m.isStreaming === true) ?? false
  })

  /** 是否有待回复的 Promise */
  const hasPendingReply = computed<boolean>(() => {
    return hasPendingReplyState()
  })

  /** 更新单个会话状态 (不可变替换, 触发响应式) */
  function setSessionStatus(sessionId: string, status: SessionStatus): void {
    sessionStatus.value = { ...sessionStatus.value, [sessionId]: status }
  }

  // ==================== 事件处理器 (拆分到 streaming/) ====================

  const partHandlers = createPartHandlers({
    getMessages: () => _messagesRef?.value,
    getActiveSessionId: () => _activeSessionIdRef?.value ?? '',
    setSessionStatus,
    finalizeStreaming: () => finalizeStreaming(),
    getMessageRole: (messageId: string) => _messageRoles.get(messageId),
  })

  const sessionEventHandlers = createSessionEventHandlers({
    getMessages: () => _messagesRef?.value,
    setSessionStatus,
    finalizeStreaming: () => finalizeStreaming(),
    isStreaming: () => isStreaming.value,
  })

  const queueHandlers = createQueueHandlers({
    getMessages: () => _messagesRef?.value,
  })

  // ==================== 注入 (集中式 Store 配置) ====================

  /**
   * 注入 messages ref 和 activeSessionId ref
   * 必须在 SSE 事件处理之前调用 (由 useChat 初始化时调用)
   */
  function configure(options: {
    messages: Ref<ChatMessage[]>
    activeSessionId: Ref<string>
  }): void {
    _messagesRef = options.messages
    _activeSessionIdRef = options.activeSessionId
    // FE-M2: configure 是可信来源之一, 同步内部活跃会话 ID
    _activeSessionId = options.activeSessionId.value || null
    _streamingConfigured.value = true
  }

  // ==================== SSE 事件处理 ====================

  /**
   * 处理 SSE 事件 (入口)
   *
   * 事件格式兼容:
   *   - 原生: { type: 'xxx', payload: { type: 'xxx', properties: {...} } }
   *   - Proxy: { payload: { type: 'xxx', properties: {...} } }
   */
  function handleSSEEvent(data: unknown): void {
    if (!data || typeof data !== 'object') return

    const d = data as Record<string, unknown>

    // 提取事件类型
    const payload = d.payload as SSEPayload | undefined
    const eventType: string =
      (payload?.type as string) ||
      (d.type as string) ||
      ''

    if (!eventType) return

    // 忽略连接状态事件
    if (
      eventType === 'proxy.connected' ||
      eventType === 'server.connected'
    ) {
      if (eventType === 'proxy.connected') {
        debugLog('[SSE-DEBUG] SSE 连接已建立')
      }
      return
    }

    // 必须含有 payload 才继续
    if (!payload) return
    const props = payload.properties

    if (!props) return

    // 提取事件所属会话 ID (兼容 sessionID / session_id)
    const eventSessionId = resolveSessionId(props) || undefined
    const isActiveSession = !_activeSessionId || (eventSessionId || '_default') === _activeSessionId

    // DEBUG: 前20个事件打印类型 (默认关闭, 由 localStorage/ setSSEDebug 控制)
    const dbgCnt = nextSSELogCount()
    if (dbgCnt <= 20 || eventType === 'message.part.updated' || eventType === 'message.updated' || eventType === 'session.idle' || eventType === 'session.status') {
      debugLog('[SSE-DBG] #' + dbgCnt, eventType, 'sid:', eventSessionId || '-', 'isAct:', isActiveSession, 'aId:', _activeSessionId || '-')
    }

    // FE-M2: 不再根据到达事件自动篡改活跃会话 ID, 只信任
    // configure / setActiveSessionId 设置的会话, 防止子会话/其他设备事件劫持。

    // ============ message.part.updated ============
    if (eventType === 'message.part.updated') {
      debugLog('[SSE-DEBUG] part.updated 到达! eventSessionId:', eventSessionId)
      partHandlers.handlePartUpdated(props, eventSessionId)
      return
    }

    // ============ message.part.delta ============
    if (eventType === 'message.part.delta') {
      partHandlers.handlePartDelta(props, eventSessionId)
      return
    }

    // ============ session.queue ============
    // Loom 外部发送的唯一用户消息来源, 必须先于 message.updated 建立轮次边界,
    // 否则下一条 assistant 回复会并入上一条回复 (append 到未关闭的 turn)。
    if (eventType === 'session.queue') {
      queueHandlers.handleSessionQueue(props, isActiveSession)
      return
    }

    // ============ message.updated ============
    if (eventType === 'message.updated') {
      if (isActiveSession) {
        handleMessageUpdated(props)
      }
      return
    }

    // ============ session.status ============
    if (eventType === 'session.status') {
      const sid = resolveSessionId(props)
      // T-C5: status 实际为对象 { type }, 旧版为字符串, 统一解析
      const status = parseSessionStatus(props.status)
      if (sid) {
        setSessionStatus(sid, status)
      }
      // OpenCode 1.18.30 起不再发送 session.idle, 空闲只通过
      // session.status{status:{type:'idle'}} 通知。活跃会话此时必须补齐
      // finalize, 否则占位符 isStreaming 永久为 true, 输入框悬挂在流式态。
      if (status === 'idle' && isActiveSession && isStreaming.value) {
        finalizeStreaming()
      }
      return
    }

    // ============ session.error ============
    // T-C5: 会话错误必须可见并结束流式, 否则 isStreaming 会悬挂到 120s 超时
    if (eventType === 'session.error') {
      sessionEventHandlers.handleSessionError(props, eventSessionId, isActiveSession)
      return
    }

    // ============ session.idle ============
    if (eventType === 'session.idle') {
      sessionEventHandlers.handleSessionIdle(props, isActiveSession)
      return
    }

    // ============ session.updated ============
    if (eventType === 'session.updated') {
      const sid = resolveSessionId(props)
      const status = (props.status || '') as string
      if (sid && status) {
        setSessionStatus(sid, status as SessionStatus)
      }
      return
    }

    // ============ session.diff ============
    if (eventType === 'session.diff') {
      return
    }

    // ============ session.compacted ============
    if (eventType === 'session.compacted') {
      sessionEventHandlers.handleSessionCompacted(props, isActiveSession)
      return
    }
  }

  /**
   * 处理 message.updated 事件
   *
   * 注意：不在此处触发 finalizeStreaming！初始加载时后端会重放所有历史消息的
   * message.updated 事件，过早调用 finalizeStreaming 会将新创建的流式占位符
   * (isStreaming=true) 标记为完成。流式完成统一由 session.idle 事件触发。
   *
   * Token 更新：从 info.tokens 提取 AI 模型用量统计并实时更新。
   */
  function handleMessageUpdated(props: SSEProperties): void {
    // 记录消息 id -> 角色, 供 part 处理器区分用户/助手消息
    // (此前完全忽略 info.role, 导致用户消息的 part 被写入 assistant 占位符)
    const info = props.info as
      | { id?: string; role?: string; time?: { created?: number } }
      | undefined
    const msgId = typeof info?.id === 'string' ? info.id : ''
    const role = typeof info?.role === 'string' ? info.role : ''
    const createdAt =
      typeof info?.time?.created === 'number' && Number.isFinite(info.time.created)
        ? info.time.created
        : undefined
    if (msgId && role) {
      _messageRoles.set(msgId, role)
      if (role === 'user') {
        const msgs = _messagesRef?.value
        if (msgs) reconcileUserMessage(msgs, msgId, createdAt)
      }
    }

    // 流式完成由 session.idle 事件统一处理
    // 解析 token 用量信息 (路径1: SSE 实时推送)
    const tokens = extractMessageTokens(props)
    if (tokens) {
      _currentTokens.value = tokens
    }
  }

  // ==================== 流式状态管理 ====================

  /**
   * 创建待回复 Promise (FE-H5)
   *
   * 发送消息后调用。多个请求并发时:
   *   - 新请求会先把上一个未完成的 pending resolve 掉 (视为被取代), 避免悬挂;
   *   - 每个请求持有独立序号, 120s 超时回调只在序号未被取代时才 resolve,
   *     不会误触发新请求的 promise。
   * 流式正常完成由 finalizeStreaming() resolve。
   */
  function createPendingPromise(): Promise<void> {
    return createPendingReply()
  }

  /**
   * 完成流式渲染
   *
   * 标记流式消息完成, 解析 pending promise。
   * 流式完成统一由 session.idle 事件 (或切会话/登出清理) 触发。
   */
  function finalizeStreaming(): void {
    // 清除所有流式标记 (对齐 isStreaming 的 some 语义, 避免异常/并发留下多条占位符)
    const msgs = _messagesRef?.value
    if (msgs) {
      for (const msg of msgs) {
        if (msg.isStreaming === true) {
          msg.isStreaming = false
        }
      }
    }

    // 解决 pending promise (含超时定时器清理)
    resolvePendingReply()
  }

  /**
   * 重置全部流式状态 (登出 / 会话切换清理时调用)
   *
   * - resolve 并清空 pending promise (避免调用方永久挂起)
   * - 清空会话状态映射与 Token 用量
   * - 标记所有 isStreaming 消息为完成
   */
  function resetStreamingState(): void {
    finalizeStreaming()
    sessionStatus.value = {}
    _currentTokens.value = null
    _messageRoles.clear()
  }

  /** 设置活跃会话 ID (用于 SSE 事件过滤，同步更新外部 ref) */
  function setActiveSessionId(sessionId: string | null): void {
    // 会话切换时清空消息角色映射, 避免旧会话 id 污染新会话判定
    if (_activeSessionId !== sessionId) {
      _messageRoles.clear()
    }
    _activeSessionId = sessionId
    if (_activeSessionIdRef) {
      _activeSessionIdRef.value = sessionId || ''
    }
  }

  /** 更新当前会话 Token 用量 (供 useChat 从消息历史提取 tokens 时调用) */
  function updateTokens(tokens: TokenUsage | null): void {
    _currentTokens.value = tokens
  }

  return {
    isStreaming,
    currentTokens: readonly(_currentTokens),
    sessionStatus: readonly(sessionStatus),
    handleSSEEvent,
    finalizeStreaming,
    createPendingPromise,
    hasPendingReply,
    configure,
    resetStreamingState,
    setActiveSessionId,
    updateTokens,
  }
}

// ==================== 单例 ====================

let _singleton: UseStreamingMessageReturn | null = null

/**
 * 全局单例 useStreamingMessage (跨组件共享同一个流式状态)
 */
export function useStreamingMessageSingleton(): UseStreamingMessageReturn {
  if (!_singleton) {
    _singleton = useStreamingMessage()
  }
  return _singleton
}
