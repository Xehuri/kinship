/**
 * 子智能体 Composable -- 管理子智能体列表获取和子会话切换
 *
 * 三层数据源:
 *   1. API: GET /api/screen/session/{sessionId}/children
 *   2. 消息扫描: 从 tool=task 的 parts 中提取 session_id
 *   3. Mock: USE_MOCK_DATA 时使用预设的子智能体
 *
 * 使用方式:
 *   const sa = useSubAgentsSingleton()
 *   // 加载子智能体
 *   await sa.loadSubAgents(currentSessionId, messages)
 *   // 进入子会话
 *   await sa.enterSubAgent(childSessionId)
 *   // 返回父会话
 *   await sa.returnToParent()
 */

import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { useChatSingleton, getSessionBackend, setSessionBackend } from '@/composables/useChat'
import { useStreamingMessageSingleton } from '@/composables/useStreamingMessage'
import { apiGet } from '@/api/client'
import type { WebBackendId } from '@/api/backend'
import { USE_MOCK_DATA } from '@/composables/useMockData'
import type { ChatMessage } from '@/types'

// ==================== 类型 ====================

/** 子智能体信息 */
export interface SubAgentInfo {
  /** 唯一标识 */
  id: string
  /** 智能体名称 */
  name: string
  /** 智能体类型 (explore/build/oracle 等) */
  type: string
  /** 子会话 ID */
  childSessionId: string | null
  /** 状态 */
  status: string
  /** 在消息列表中的位置 (用于排序) */
  messageIndex: number
  /** 子会话归属后端 (W45: children 条目标注, 缺失=未知, 进入时承袭父会话) */
  backend?: WebBackendId
  /** 创建时间 (epoch ms; W49.4: 后端 createdAt / opencode time.created 取源, 缺失/0/无效=无时间, 排序回退位次) */
  createdAt?: number
}

/** 父级层级节点 */
export interface ParentLevel {
  /** 会话 ID */
  sessionId: string
  /** 会话标题 */
  title: string
}

/** useSubAgents 返回值 */
export interface UseSubAgentsReturn {
  /** 子智能体列表 */
  subAgents: Ref<SubAgentInfo[]>
  /** 是否处于子会话模式 (任意层级) */
  isChildMode: ComputedRef<boolean>
  /** 父级层级栈 (索引0=根父级, 索引last=直接父级) */
  parentChain: Ref<ParentLevel[]>
  /** 当前层级的直接父会话标题 (用于返回按钮文本) */
  parentSessionTitle: ComputedRef<string>
  /** 子智能体列表弹窗可见性 (ChatView 共享) */
  showList: Ref<boolean>
  /** 正在加载子智能体列表 */
  loading: Ref<boolean>
  /**
   * 加载子智能体列表 (每次调用都重新请求)
   * 真实模式: API + 消息扫描双重获取后合并
   * Mock 模式: 直接返回预设数据
   * @param sessionId 会话 ID
   * @param messages 当前会话的消息列表 (用于消息扫描)
   */
  loadSubAgents: (sessionId: string, messages: ChatMessage[]) => Promise<void>
  /**
   * 从消息列表中扫描 task 工具调用
   * @param messages 消息列表
   * @returns 扫描到的子智能体列表
   */
  scanFromMessages: (messages: ChatMessage[]) => SubAgentInfo[]
  /**
   * 进入子智能体会话
   * @param childSessionId 子会话 ID
   */
  enterSubAgent: (childSessionId: string) => Promise<void>
  /**
   * 返回父会话
   */
  returnToParent: () => Promise<void>
}

// ==================== 单例 ====================

let _singleton: UseSubAgentsReturn | null = null

export function useSubAgentsSingleton(): UseSubAgentsReturn {
  if (_singleton) return _singleton
  _singleton = useSubAgents()
  return _singleton
}

// ==================== Composable ====================

export function useSubAgents(): UseSubAgentsReturn {
  const chat = useChatSingleton()
  const subAgents = ref<SubAgentInfo[]>([])
  const parentChain = ref<ParentLevel[]>([])
  const showList = ref(false)
  const loading = ref(false)

  const isChildMode = computed(() => parentChain.value.length > 0)

  /** 当前层级的直接父会话标题 (栈顶) */
  const parentSessionTitle = computed(() => {
    if (parentChain.value.length === 0) return '主会话'
    return parentChain.value[parentChain.value.length - 1].title
  })

  // ==================== Mock 数据 ====================

  function getMockSubAgents(): SubAgentInfo[] {
    return [
      {
        id: 'mock_agent_1',
        name: '审查当前前端代码结构',
        type: 'explore',
        childSessionId: 'mock_child_ses_1',
        status: 'completed',
        messageIndex: 2,
      },
      {
        id: 'mock_agent_2',
        name: '查找认证实现方案',
        type: 'librarian',
        childSessionId: 'mock_child_ses_2',
        status: 'completed',
        messageIndex: 3,
      },
      {
        id: 'mock_agent_3',
        name: '重构用户认证中间件',
        type: 'build',
        childSessionId: 'mock_child_ses_3',
        status: 'completed',
        messageIndex: 5,
      },
    ]
  }

  // ==================== API 获取 ====================

  async function fetchFromApi(sessionId: string): Promise<SubAgentInfo[]> {
    try {
      // W45: 父会话已知归属时带 ?backend= 路由到对应引擎查询子会话
      const parentBackend = getSessionBackend(sessionId)
      const url =
        '/api/screen/session/' + encodeURIComponent(sessionId) + '/children' +
        (parentBackend ? '?backend=' + encodeURIComponent(parentBackend) : '')
      const payload = await apiGet<{ children?: Array<Record<string, unknown>> }>(url)
      if (payload && Array.isArray(payload.children)) {
        return payload.children.map((c, idx) => {
          // 条目标注精确匹配协议冻结取值, 未知/缺失 = 未标注
          const cBackend = c.backend === 'loom' || c.backend === 'opencode' ? c.backend : undefined
          // W49.4: 时间取源——后端 createdAt (epoch ms) 优先, opencode 形态次级取 time.created;
          // 缺失/0/非法值 = 无时间, 排序回退位次 (W49.3 并行改动期防御)
          const timeField = c.time && typeof c.time === 'object'
            ? (c.time as Record<string, unknown>).created
            : undefined
          const t = Number(c.createdAt ?? timeField)
          const createdAt = Number.isFinite(t) && t > 0 ? t : undefined
          return {
            id: String(c.id || 'api_child_' + idx),
            name: String(c.title || c.name || '子智能体'),
            type: String(c.type || c.agent || 'unknown'),
            childSessionId: String(c.id || ''),
            status: String(c.status || 'completed'),
            messageIndex: 1000 + idx, // API 回来的排在后面 (无时间条目的位次基准)
            ...(cBackend ? { backend: cBackend } : {}),
            ...(createdAt !== undefined ? { createdAt } : {}),
          }
        })
      }
    } catch (e) {
      console.warn('[useSubAgents] API 获取子智能体失败:', e)
    }
    return []
  }

  // ==================== 消息扫描 ====================

  function scanFromMessages(messages: ChatMessage[]): SubAgentInfo[] {
    const result: SubAgentInfo[] = []

    messages.forEach((msg, msgIdx) => {
      const parts = msg.parts || []
      parts.forEach((part) => {
        if (part.type !== 'tool' || part.tool !== 'task') return

        const state = part.state
        if (!state) return

        const callId = part.callID || part.id || 'agent_' + msgIdx
        const input = (state.input || {}) as Record<string, unknown>
        // W49.4: 标题优先 task 入参 title (模型传了就用), 缺省回退 description/agent 现状
        const name = (input.title as string) || (input.description as string) || (input.agent as string) || '子智能体'
        const type = (input.subagent_type as string) || (input.agent as string) || 'unknown'

        // 从 output 中提取 session_id
        let childSessionId: string | null = null
        const output = state.output
        if (output && typeof output === 'string') {
          const match = output.match(/<task_metadata>[\s\S]*?session_id:\s*([a-zA-Z0-9_]+)[\s\S]*?<\/task_metadata>/)
          if (match) childSessionId = match[1]
        }

        result.push({
          id: callId,
          name,
          type,
          childSessionId,
          status: state.status || 'unknown',
          messageIndex: msgIdx,
        })
      })
    })

    return result
  }

  // ==================== 去重合并 ====================

  /** 合并两个列表，按 childSessionId 去重 */
  function mergeLists(api: SubAgentInfo[], scanned: SubAgentInfo[]): SubAgentInfo[] {
    const seen = new Set<string>()
    const result: SubAgentInfo[] = []

    // API 优先（更可靠），消息扫描补充
    for (const agent of [...api, ...scanned]) {
      const key = agent.childSessionId || agent.id
      if (!seen.has(key)) {
        seen.add(key)
        result.push(agent)
      }
    }

    // W49.4: createdAt 时间倒序为主键 (最新在最上, 不再受后端插入序绑架);
    // 无时间条目 (-1 垫底组) 回退 messageIndex 倒序 = opencode 时代原行为, 零回归
    result.sort((a, b) => (b.createdAt ?? -1) - (a.createdAt ?? -1) || b.messageIndex - a.messageIndex)
    return result
  }

  // ==================== 主加载函数 ====================

  async function loadSubAgents(sessionId: string, messages: ChatMessage[]): Promise<void> {
    loading.value = true

    try {
      if (USE_MOCK_DATA) {
        subAgents.value = getMockSubAgents()
        return
      }

      if (!sessionId) {
        subAgents.value = []
        return
      }

      // 并行获取 API 和扫描消息
      const [apiAgents, scannedAgents] = await Promise.all([
        fetchFromApi(sessionId),
        Promise.resolve(scanFromMessages(messages)),
      ])

      subAgents.value = mergeLists(apiAgents, scannedAgents)
    } finally {
      loading.value = false
    }
  }

  // ==================== 会话切换 ====================

  async function enterSubAgent(childSessionId: string): Promise<void> {
    // 将当前会话压入父级栈 (保存会话ID和标题)
    const parentSessionId = chat.currentSessionId.value
    parentChain.value = [...parentChain.value, {
      sessionId: parentSessionId,
      title: chat.currentSessionTitle.value,
    }]

    // W45: 登记子会话归属——优先用 children 列表条目标注的 backend,
    // 未标注时承袭父会话通道 (子会话由父会话引擎派生, 通道必然一致)。
    const childEntry = subAgents.value.find((a) => a.childSessionId === childSessionId)
    setSessionBackend(childSessionId, childEntry?.backend ?? getSessionBackend(parentSessionId))

    // 完成父会话流式状态并切换到子会话
    // T-C5: 必须调用 finalizeStreaming(), 以 resolve 父会话 sendMessage 的 pending
    // promise; 否则切走到子会话后, 父请求会一直悬挂到 120s 超时才返回。
    const sm = useStreamingMessageSingleton()
    sm.finalizeStreaming()
    sm.setActiveSessionId(childSessionId)
    // C7: 进入子会话时重置 token 显示, 避免父会话用量泄漏到子会话
    // (若子会话历史含 tokens, loadChatHistory 会立即用其覆盖)
    sm.updateTokens(null)

    // 更新当前会话 ID（仅本地）
    chat.currentSessionId.value = childSessionId

    // 清理并加载子会话历史
    chat.clearMessages()
    await chat.loadChatHistory(childSessionId)
  }

  async function returnToParent(): Promise<void> {
    if (parentChain.value.length === 0) return

    // 弹出栈顶 (当前层级的直接父级)
    const chain = [...parentChain.value]
    const parent = chain.pop()!
    parentChain.value = chain
    subAgents.value = []

    await chat.switchSession(parent.sessionId)
  }

  return {
    subAgents,
    isChildMode,
    parentChain,
    parentSessionTitle,
    showList,
    loading,
    loadSubAgents,
    scanFromMessages,
    enterSubAgent,
    returnToParent,
  }
}
