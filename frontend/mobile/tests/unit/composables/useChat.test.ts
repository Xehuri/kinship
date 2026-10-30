/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ==================== Mock API 模块 ====================

// loadSessions 现在通过 @/api/client 的 apiGet 直接请求会话列表接口
const mockClient = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiUpload: vi.fn(),
  apiGetVerbose: vi.fn(),
}))

// 会话相关的其余接口仍来自 @/api/session
const mockSessionApi = vi.hoisted(() => ({
  getSessionMessages: vi.fn(),
  sendMessage: vi.fn(),
  createSession: vi.fn(),
  switchSession: vi.fn(),
  renameSession: vi.fn(),
}))

const mockStreamingMethods = vi.hoisted(() => ({
  setActiveSessionId: vi.fn(),
  updateTokens: vi.fn(),
  createPendingPromise: vi.fn(),
  configure: vi.fn(),
  clearStreaming: vi.fn(),
  finalizeStreaming: vi.fn(),
  buildStreamMessage: vi.fn(() => ({
    role: 'assistant',
    parts: [{ type: 'text', text: 'Hello' }],
  })),
}))

const mockUseStreamingMessageSingleton = vi.hoisted(() => vi.fn())

// W45: mock api/backend 查询 (loadSessions 初始化链经 GET fetchWebBackend 种默认通道;
// 默认返回 undefined=未种上, 保证既有用例不受乐观标注影响)
const mockBackendApi = vi.hoisted(() => ({
  fetchWebBackend: vi.fn(),
}))

// useChat 现在从 useStreamingMessage 引入本地 id 生成与稳定 id 解析 (C4),
// 单元测试需要提供真实实现 (而非 vi.fn), 以便合并去重逻辑可被验证
const mockMessageId = vi.hoisted(() => {
  let seq = 0
  return {
    createLocalMessageId: (): string => `local-${++seq}`,
    getStableMessageId: (msg: { id?: string; info?: { id?: string } }): string =>
      msg?.id || msg?.info?.id || '',
  }
})

vi.mock('@/api/client', () => mockClient)
vi.mock('@/api/backend', () => ({
  fetchWebBackend: mockBackendApi.fetchWebBackend,
}))
// C8: 复用真实的 normalizeSession 作为会话归一化唯一来源, 其余会话接口保持 mock
vi.mock('@/api/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/session')>()
  return {
    ...mockSessionApi,
    normalizeSession: actual.normalizeSession,
  }
})
vi.mock('@/composables/useStreamingMessage', () => ({
  useStreamingMessageSingleton: mockUseStreamingMessageSingleton,
  createLocalMessageId: mockMessageId.createLocalMessageId,
  getStableMessageId: mockMessageId.getStableMessageId,
}))

mockUseStreamingMessageSingleton.mockReturnValue(mockStreamingMethods)

// ==================== 测试 ====================

import { useChat } from '@/composables/useChat'
import type { UseChatReturn } from '@/composables/useChat'

describe('useChat', () => {
  let chat: UseChatReturn

  beforeEach(() => {
    vi.clearAllMocks()
    // createPendingPromise 默认立即 resolve (模拟 SSE 流式完成)
    mockStreamingMethods.createPendingPromise.mockResolvedValue(undefined)
    chat = useChat()
  })

  // ==================== loadSessions ====================

  describe('loadSessions', () => {
    it('加载会话列表并设置当前会话 (current_session)', async () => {
      mockClient.apiGet.mockResolvedValue({
        local_sessions: [
          { id: 's1', title: 'S1', date: '今日', preview: '' },
          { session_id: 's2', title: 'S2', date: '昨日', preview: '' },
        ],
        current_session: 's2',
      })

      await chat.loadSessions()

      expect(mockClient.apiGet).toHaveBeenCalledWith('/api/screen/session/list')
      expect(chat.sessions.value).toHaveLength(2)
      expect(chat.sessions.value[0].id).toBe('s1')
      expect(chat.sessions.value[1].id).toBe('s2')
      expect(chat.sessions.value[1].session_id).toBe('s2')
      expect(chat.currentSessionId.value).toBe('s2')
      expect(mockStreamingMethods.setActiveSessionId).toHaveBeenCalledWith('s2')
    })

    it('没有 current_session 时使用第一个会话', async () => {
      mockClient.apiGet.mockResolvedValue({
        local_sessions: [
          { id: 's1', title: 'S1', date: '今日', preview: '' },
          { id: 's2', title: 'S2', date: '昨日', preview: '' },
        ],
      })

      await chat.loadSessions()

      expect(chat.currentSessionId.value).toBe('s1')
    })

    it('空会话列表不设置 currentSessionId', async () => {
      mockClient.apiGet.mockResolvedValue({ local_sessions: [] })

      await chat.loadSessions()

      expect(chat.sessions.value).toEqual([])
      expect(chat.currentSessionId.value).toBe('')
    })

    it('API 返回 null 不崩溃', async () => {
      mockClient.apiGet.mockResolvedValue(null)

      await chat.loadSessions()

      expect(chat.sessions.value).toEqual([])
    })
  })

  // ==================== switchSession ====================

  describe('switchSession', () => {
    beforeEach(async () => {
      mockClient.apiGet.mockResolvedValue({
        local_sessions: [
          { id: 's1', title: 'S1', date: '今日', preview: '' },
          { id: 's2', title: 'S2', date: '昨日', preview: '' },
        ],
      })
      mockClient.apiGetVerbose.mockResolvedValue({
        status: 200,
        ok: true,
        data: { messages: [] },
      })
      mockSessionApi.switchSession.mockResolvedValue(true)
      await chat.loadSessions()
    })

    it('切换会话并加载历史消息', async () => {
      await chat.switchSession('s2')

      expect(mockStreamingMethods.setActiveSessionId).toHaveBeenCalledWith('s2')
      // W46: useChat 统一把映射查询结果作为第二参转发; 本用例的 s1/s2 来自
      // local_sessions 无标条目 => 未登记, 第二参为 undefined (wire 键省略由
      // api/session.test.ts W46 两态用例锁定)。断言只增不减, 非弱化。
      expect(mockSessionApi.switchSession).toHaveBeenCalledWith('s2', undefined)
      expect(mockClient.apiGetVerbose).toHaveBeenCalledWith('/api/screen/session/s2/messages')
      expect(chat.currentSessionId.value).toBe('s2')
      expect(chat.sessions.value.find((s) => s.id === 's2')?.active).toBe(true)
    })

    it('切换会话时重置 token 显示, 避免跨会话泄漏 (C7)', async () => {
      await chat.switchSession('s2')

      expect(mockStreamingMethods.updateTokens).toHaveBeenCalledWith(null)
    })

    it('切换会话时标记目标为 active', async () => {
      await chat.switchSession('s1')

      expect(chat.sessions.value.find((s) => s.id === 's1')?.active).toBe(true)
      expect(chat.sessions.value.find((s) => s.id === 's2')?.active).toBe(false)
    })

    it('切换会话 API 失败时不覆盖当前状态与消息 (C4)', async () => {
      // 先成功切到 s1 并加载其历史
      mockClient.apiGetVerbose.mockResolvedValue({
        status: 200,
        ok: true,
        data: { messages: [{ role: 'user' as const, content: 's1 的消息' }] },
      })
      mockSessionApi.switchSession.mockResolvedValue(true)
      await chat.switchSession('s1')
      expect(chat.currentSessionId.value).toBe('s1')
      expect(chat.messages.value).toHaveLength(1)

      // 切到 s2 失败: currentSessionId/消息/active 均不应被覆盖
      mockSessionApi.switchSession.mockResolvedValue(false)
      await chat.switchSession('s2')

      expect(chat.currentSessionId.value).toBe('s1')
      expect(chat.messages.value).toHaveLength(1)
      expect(chat.messages.value[0].content).toBe('s1 的消息')
      expect(chat.sessions.value.find((s) => s.id === 's1')?.active).toBe(true)
    })
  })

  // ==================== sendMessage ====================

  describe('sendMessage', () => {
    beforeEach(async () => {
      mockClient.apiGet.mockResolvedValue({
        local_sessions: [{ id: 's1', title: 'S1', date: '今日', preview: '' }],
        current_session: 's1',
      })
      mockSessionApi.sendMessage.mockResolvedValue({ status: 'ok' })
      await chat.loadSessions()
    })

    it('发送消息并等待流式回复完成', async () => {
      const result = await chat.sendMessage('Hello')

      expect(result).toBe(true)
      expect(mockSessionApi.sendMessage).toHaveBeenCalledWith({
        session_id: 's1',
        content: 'Hello',
      })
      expect(mockStreamingMethods.createPendingPromise).toHaveBeenCalled()
      // 消息列表: [用户消息, AI 占位消息]
      expect(chat.messages.value).toHaveLength(2)
      expect(chat.messages.value[0].role).toBe('user')
      expect(chat.messages.value[0].content).toBe('Hello')
      expect(chat.messages.value[1].role).toBe('assistant')
    })

    it('空文本不发送', async () => {
      const result = await chat.sendMessage('')
      expect(result).toBe(false)
      expect(mockSessionApi.sendMessage).not.toHaveBeenCalled()
    })

    it('无当前会话且创建失败时不发送', async () => {
      // 重置 currentSessionId, 并让创建会话返回 null
      chat = useChat()
      mockSessionApi.createSession.mockResolvedValue(null)
      const result = await chat.sendMessage('test')
      expect(result).toBe(false)
      expect(mockSessionApi.sendMessage).not.toHaveBeenCalled()
    })

    it('无当前会话时自动创建会话后发送', async () => {
      // 重置 currentSessionId
      chat = useChat()
      mockSessionApi.createSession.mockResolvedValue('auto-s1')
      mockSessionApi.sendMessage.mockResolvedValue({ status: 'ok' })

      const result = await chat.sendMessage('你好')

      expect(result).toBe(true)
      expect(mockSessionApi.createSession).toHaveBeenCalled()
      expect(chat.currentSessionId.value).toBe('auto-s1')
      expect(mockSessionApi.sendMessage).toHaveBeenCalledWith({
        session_id: 'auto-s1',
        content: '你好',
      })
    })

    it('API 发送失败返回 false', async () => {
      mockSessionApi.sendMessage.mockResolvedValue(null)

      const result = await chat.sendMessage('Hello')
      expect(result).toBe(false)
      // 失败时占位消息被标记为非流式
      expect(chat.messages.value.find((m) => m.role === 'assistant')?.isStreaming).toBe(false)
    })

    it('发送异常时返回 false', async () => {
      mockSessionApi.sendMessage.mockRejectedValue(new Error('Network error'))

      const result = await chat.sendMessage('Hello')
      expect(result).toBe(false)
      expect(chat.messages.value.find((m) => m.role === 'assistant')?.isStreaming).toBe(false)
    })
  })

  // ==================== createNewSession ====================

  describe('createNewSession', () => {
    beforeEach(async () => {
      mockClient.apiGet.mockResolvedValue({
        local_sessions: [{ id: 's1', title: 'S1', date: '今日', preview: '' }],
      })
      await chat.loadSessions()
    })

    it('创建新会话并添加到列表头部', async () => {
      mockSessionApi.createSession.mockResolvedValue('s2')

      const sessionId = await chat.createNewSession('新会话')

      expect(sessionId).toBe('s2')
      expect(chat.sessions.value[0].id).toBe('s2')
      expect(chat.sessions.value[0].active).toBe(true)
      expect(chat.currentSessionId.value).toBe('s2')
      // 旧会话应标记为非活跃
      expect(chat.sessions.value.find((s) => s.id === 's1')?.active).toBe(false)
    })

    it('创建新会话时重置 token 显示 (C7)', async () => {
      mockSessionApi.createSession.mockResolvedValue('s2')

      await chat.createNewSession('新会话')

      expect(mockStreamingMethods.updateTokens).toHaveBeenCalledWith(null)
    })

    it('创建失败不重置 token 显示 (C7)', async () => {
      mockSessionApi.createSession.mockResolvedValue(null)

      await chat.createNewSession('测试')

      expect(mockStreamingMethods.updateTokens).not.toHaveBeenCalledWith(null)
    })

    it('API 创建失败返回 null', async () => {
      mockSessionApi.createSession.mockResolvedValue(null)

      const sessionId = await chat.createNewSession('测试')
      expect(sessionId).toBeNull()
    })
  })

  // ==================== loadChatHistory ====================

  describe('loadChatHistory', () => {
    it('加载会话消息 (包装对象)', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hi', timestamp: '2026-06-23T10:00:00' },
        { role: 'assistant' as const, content: 'Hello!', timestamp: '2026-06-23T10:00:05' },
      ]
      mockClient.apiGetVerbose.mockResolvedValue({ status: 200, ok: true, data: { messages } })

      await chat.loadChatHistory('s1')

      expect(chat.messages.value).toHaveLength(2)
      expect(chat.messages.value[0].role).toBe('user')
      expect(chat.messages.value[0].content).toBe('Hi')
      // 源码会把历史消息的 isStreaming 归一化为 false
      expect(chat.messages.value.every((m) => m.isStreaming === false)).toBe(true)
      expect(chat.loadingMessages.value).toBe(false)
    })

    it('裸数组响应也能解析 (FE-M9 容错)', async () => {
      mockClient.apiGetVerbose.mockResolvedValue({
        status: 200,
        ok: true,
        data: [{ role: 'user' as const, content: '裸数组' }],
      })

      await chat.loadChatHistory('s1')

      expect(chat.messages.value).toHaveLength(1)
      expect(chat.messages.value[0].content).toBe('裸数组')
    })

    it('归一化 OpenCode 原生消息: info.time.created → timestamp', async () => {
      const created = 1750663200000
      mockClient.apiGetVerbose.mockResolvedValue({
        status: 200,
        ok: true,
        data: {
          messages: [
            {
              info: { id: 'm1', role: 'user', time: { created } },
              parts: [{ type: 'text', text: 'Hi' }],
            },
          ],
        },
      })

      await chat.loadChatHistory('s1')

      expect(chat.messages.value).toHaveLength(1)
      expect(chat.messages.value[0].id).toBe('m1')
      expect(chat.messages.value[0].timestamp).toBe(new Date(created).toISOString())
      expect(chat.messages.value[0].info?.role).toBe('user')
    })

    it('从历史消息 info.tokens 提取 Token 用量', async () => {
      const tokens = { total: 10, input: 4, output: 6 }
      mockClient.apiGetVerbose.mockResolvedValue({
        status: 200,
        ok: true,
        data: {
          messages: [
            {
              info: { id: 'm1', role: 'assistant', time: { created: 1 }, tokens },
              parts: [],
            },
          ],
        },
      })

      await chat.loadChatHistory('s1')

      // C7: 归一化后与 SSE 路径同形 (含可选字段)
      expect(mockStreamingMethods.updateTokens).toHaveBeenCalledWith({
        total: 10,
        input: 4,
        output: 6,
        reasoning: undefined,
        cache: undefined,
      })
    })

    it('历史 tokens 仅有 input/output 时推导 total (C7)', async () => {
      mockClient.apiGetVerbose.mockResolvedValue({
        status: 200,
        ok: true,
        data: {
          messages: [
            {
              info: {
                id: 'm1',
                role: 'assistant',
                time: { created: 1 },
                tokens: { input: 4, output: 6 },
              },
              parts: [],
            },
          ],
        },
      })

      await chat.loadChatHistory('s1')

      expect(mockStreamingMethods.updateTokens).toHaveBeenCalledWith({
        total: 10,
        input: 4,
        output: 6,
        reasoning: undefined,
        cache: undefined,
      })
    })

    it('200 但结构异常时清空消息', async () => {
      mockClient.apiGetVerbose.mockResolvedValue({ status: 200, ok: true, data: null })

      await chat.loadChatHistory('s1')

      expect(chat.messages.value).toEqual([])
    })

    it('空 sessionId 不发送请求', async () => {
      await chat.loadChatHistory('')

      expect(mockClient.apiGetVerbose).not.toHaveBeenCalled()
    })

    it('500 时保留已有消息, 不清空 (FE-M1)', async () => {
      chat.messages.value = [{ role: 'user', content: '旧消息' }] as any[]
      mockClient.apiGetVerbose.mockResolvedValue({ status: 500, ok: false, data: null })

      await chat.loadChatHistory('s1')

      expect(chat.messages.value).toHaveLength(1)
      expect(chat.messages.value[0].content).toBe('旧消息')
    })

    it('网络错误 (status=0) 时保留已有消息', async () => {
      chat.messages.value = [{ role: 'user', content: '旧消息' }] as any[]
      mockClient.apiGetVerbose.mockResolvedValue({ status: 0, ok: false, data: null })

      await chat.loadChatHistory('s1')

      expect(chat.messages.value).toHaveLength(1)
    })

    it('404 时清空消息 (会话已删除)', async () => {
      chat.messages.value = [{ role: 'user', content: '旧消息' }] as any[]
      mockClient.apiGetVerbose.mockResolvedValue({ status: 404, ok: false, data: null })

      await chat.loadChatHistory('s1')

      expect(chat.messages.value).toEqual([])
    })

    it('请求抛异常时保留已有消息', async () => {
      chat.messages.value = [{ role: 'user', content: '旧消息' }] as any[]
      mockClient.apiGetVerbose.mockRejectedValue(new Error('boom'))

      await chat.loadChatHistory('s1')

      expect(chat.messages.value).toHaveLength(1)
    })

    it('历史 + SSE 占位符按 id 去重, 不产生重复 (C4)', async () => {
      // 1. 首次加载历史: 服务端已有 m1(用户) 与 m2(助手)
      mockClient.apiGetVerbose.mockResolvedValue({
        status: 200,
        ok: true,
        data: {
          messages: [
            { info: { id: 'm1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'Hi' }] },
            { info: { id: 'm2', role: 'assistant', time: { created: 2 } }, parts: [{ type: 'text', text: 'Hello' }] },
          ],
        },
      })
      await chat.loadChatHistory('s1')
      expect(chat.messages.value).toHaveLength(2)

      // 2. 模拟 SSE: 助手消息 m2 仍在流式, 占位符已按 messageID 绑定后端 id m2 并收到 delta
      chat.messages.value = [
        ...chat.messages.value,
        {
          id: 'm2',
          info: { role: 'assistant', id: 'm2' },
          role: 'assistant',
          parts: [{ type: 'text', text: 'Hello world' }],
          isStreaming: true,
          timestamp: '2026-06-23T10:00:10',
        },
      ]

      // 3. 再次加载历史 (重连重同步): 同 id 的历史消息与占位符应合并为一条
      await chat.loadChatHistory('s1')

      const assistantMsgs = chat.messages.value.filter(
        (m) => (m.info?.role || m.role) === 'assistant',
      )
      expect(assistantMsgs).toHaveLength(1)
      expect(chat.messages.value).toHaveLength(2)
    })

    it('合并历史时保留未出现在历史中的活跃流式占位符 (C4)', async () => {
      // 现有本地消息: 用户消息 + 尚未落库的流式占位符 (本地 id)
      chat.messages.value = [
        { role: 'user', content: '问题', timestamp: '2026-06-23T10:00:00' },
        {
          id: 'local-7',
          info: { role: 'assistant', id: 'local-7' },
          role: 'assistant',
          parts: [{ type: 'text', text: '正在输' }],
          isStreaming: true,
          timestamp: '2026-06-23T10:00:01',
        },
      ]

      // 历史仅包含用户消息 (助手回复尚未落库)
      mockClient.apiGetVerbose.mockResolvedValue({
        status: 200,
        ok: true,
        data: {
          messages: [
            { info: { id: 'm1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: '问题' }] },
          ],
        },
      })

      await chat.loadChatHistory('s1')

      const streaming = chat.messages.value.filter((m) => m.isStreaming === true)
      expect(streaming).toHaveLength(1)
      expect(streaming[0].id).toBe('local-7')
      expect(chat.messages.value).toHaveLength(2)
      // 占位符保留在末尾
      expect(chat.messages.value[chat.messages.value.length - 1].isStreaming).toBe(true)
    })
  })

  // ==================== loadMoreHistory ====================

  describe('loadMoreHistory', () => {
    /** 构造归一化前的历史消息 */
    function rawMsg(id: string, role: 'user' | 'assistant', text: string, created: number) {
      return { info: { id, role, time: { created } }, parts: [{ type: 'text', text }] }
    }

    beforeEach(() => {
      // 分页依赖当前会话 ID
      chat.currentSessionId.value = 's1'
    })

    it('前插更早消息并更新游标 (保持时间顺序)', async () => {
      // 首次加载最新一页
      mockClient.apiGetVerbose.mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: {
          messages: [rawMsg('m3', 'user', 'p3', 3), rawMsg('m4', 'assistant', 'p4', 4)],
          next_cursor: 'c1',
        },
      })
      await chat.loadChatHistory('s1')

      expect(chat.messages.value.map((m) => m.id)).toEqual(['m3', 'm4'])
      expect(chat.nextCursor.value).toBe('c1')
      expect(chat.hasMoreHistory.value).toBe(true)

      // 加载更早一页
      mockClient.apiGetVerbose.mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: {
          messages: [rawMsg('m1', 'user', 'p1', 1), rawMsg('m2', 'assistant', 'p2', 2)],
          next_cursor: 'c2',
        },
      })
      await chat.loadMoreHistory()

      // 更早消息在前, 现有消息在后
      expect(chat.messages.value.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
      expect(chat.nextCursor.value).toBe('c2')
      expect(chat.hasMoreHistory.value).toBe(true)
      // 分页请求带 before 游标
      expect(mockClient.apiGetVerbose).toHaveBeenLastCalledWith(
        '/api/screen/session/s1/messages?before=c1',
      )
    })

    it('更早页与现有消息按 id 去重', async () => {
      mockClient.apiGetVerbose.mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: {
          messages: [rawMsg('m2', 'assistant', 'p2', 2), rawMsg('m3', 'user', 'p3', 3)],
          next_cursor: 'c1',
        },
      })
      await chat.loadChatHistory('s1')

      // 更早一页在 m2 处与当前页重叠
      mockClient.apiGetVerbose.mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: {
          messages: [rawMsg('m1', 'user', 'p1', 1), rawMsg('m2', 'assistant', 'p2', 2)],
          next_cursor: null,
        },
      })
      await chat.loadMoreHistory()

      expect(chat.messages.value.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
      expect(chat.messages.value).toHaveLength(3)
    })

    it('游标为 null 时更新 hasMoreHistory 为 false', async () => {
      mockClient.apiGetVerbose.mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: {
          messages: [rawMsg('m2', 'assistant', 'p2', 2)],
          next_cursor: 'c1',
        },
      })
      await chat.loadChatHistory('s1')
      expect(chat.hasMoreHistory.value).toBe(true)

      mockClient.apiGetVerbose.mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: { messages: [rawMsg('m1', 'user', 'p1', 1)], next_cursor: null },
      })
      await chat.loadMoreHistory()

      expect(chat.nextCursor.value).toBeNull()
      expect(chat.hasMoreHistory.value).toBe(false)
    })

    it('无更早消息时不发请求 (hasMoreHistory false)', async () => {
      mockClient.apiGetVerbose.mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: { messages: [rawMsg('m1', 'user', 'p1', 1)], next_cursor: null },
      })
      await chat.loadChatHistory('s1')
      expect(chat.hasMoreHistory.value).toBe(false)

      mockClient.apiGetVerbose.mockClear()
      await chat.loadMoreHistory()

      expect(mockClient.apiGetVerbose).not.toHaveBeenCalled()
    })

    it('加载更早不触发骨架屏 (loadingMessages 保持 false)', async () => {
      mockClient.apiGetVerbose.mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: { messages: [rawMsg('m2', 'assistant', 'p2', 2)], next_cursor: 'c1' },
      })
      await chat.loadChatHistory('s1')

      mockClient.apiGetVerbose.mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: { messages: [rawMsg('m1', 'user', 'p1', 1)], next_cursor: null },
      })
      await chat.loadMoreHistory()

      expect(chat.loadingMessages.value).toBe(false)
    })
  })

  // ==================== clearMessages ====================

  describe('clearMessages', () => {
    it('清空本地消息', () => {
      chat.messages.value = [
        { role: 'user', content: 'test' },
      ] as any[]

      chat.clearMessages()

      expect(chat.messages.value).toEqual([])
    })
  })

  // ==================== currentSessionTitle ====================

  describe('currentSessionTitle', () => {
    it('返回当前会话标题', async () => {
      mockClient.apiGet.mockResolvedValue({
        local_sessions: [{ id: 's1', title: '测试会话', date: '今日', preview: '' }],
      })
      await chat.loadSessions()

      expect(chat.currentSessionTitle.value).toBe('测试会话')
    })

    it('无当前会话时返回空字符串', () => {
      expect(chat.currentSessionTitle.value).toBe('')
    })
  })

  // ==================== W45: 双通道分账路由 ====================

  describe('双通道分账 (W45)', () => {
    it('loadSessions 优先读 sessions 键并按条目 backend 填映射, sendMessage 出线带 backend', async () => {
      mockClient.apiGet.mockResolvedValue({
        sessions: [
          { id: 'w45_loom', title: 'L', date: '今日', preview: '', backend: 'loom' },
          { id: 'w45_open', title: 'O', date: '今日', preview: '', backend: 'opencode' },
        ],
        current_session: 'w45_loom',
      })
      mockSessionApi.sendMessage.mockResolvedValue({ status: 'ok' })

      await chat.loadSessions()

      expect(chat.sessions.value).toHaveLength(2)
      expect(chat.sessions.value[0].backend).toBe('loom')

      await chat.sendMessage('hi')

      expect(mockSessionApi.sendMessage).toHaveBeenCalledWith({
        session_id: 'w45_loom',
        content: 'hi',
        backend: 'loom',
      })
    })

    it('未标注会话 (老后端 local_sessions) 的 sendMessage body 完全不出现 backend 键', async () => {
      mockClient.apiGet.mockResolvedValue({
        local_sessions: [{ id: 'w45_plain', title: 'P', date: '今日', preview: '' }],
        current_session: 'w45_plain',
      })
      mockSessionApi.sendMessage.mockResolvedValue({ status: 'ok' })

      await chat.loadSessions()
      await chat.sendMessage('hi')

      const body = mockSessionApi.sendMessage.mock.calls[0][0] as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(body, 'backend')).toBe(false)
    })

    it('loadChatHistory 对已知归属会话拼 ?backend=', async () => {
      mockClient.apiGet.mockResolvedValue({
        sessions: [{ id: 'w45_hist', title: 'H', date: '今日', preview: '', backend: 'opencode' }],
        current_session: 'w45_hist',
      })
      mockClient.apiGetVerbose.mockResolvedValue({ status: 200, ok: true, data: { messages: [] } })

      await chat.loadSessions()
      await chat.loadChatHistory('w45_hist')

      expect(mockClient.apiGetVerbose).toHaveBeenCalledWith(
        '/api/screen/session/w45_hist/messages?backend=opencode',
      )
    })

    it('未映射会话的 loadChatHistory 路径不带 backend 查询串', async () => {
      mockClient.apiGetVerbose.mockResolvedValue({ status: 200, ok: true, data: { messages: [] } })

      await chat.loadChatHistory('w45_nomap')

      expect(mockClient.apiGetVerbose).toHaveBeenCalledWith('/api/screen/session/w45_nomap/messages')
    })

    it('createNewSession 乐观按 defaultBackend 入映射 (仅 GET 查询, 绝不 POST /backend)', async () => {
      mockClient.apiGet.mockResolvedValue({ local_sessions: [] })
      mockBackendApi.fetchWebBackend.mockResolvedValue({ backend: 'loom', options: ['opencode', 'loom'] })

      await chat.loadSessions()

      expect(mockBackendApi.fetchWebBackend).toHaveBeenCalled()

      mockSessionApi.createSession.mockResolvedValue('w45_new')
      const sid = await chat.createNewSession('新通道会话')
      expect(sid).toBe('w45_new')
      // 乐观列表行带默认通道标注, 供抽屉立即入组
      expect(chat.sessions.value[0].backend).toBe('loom')

      mockSessionApi.sendMessage.mockResolvedValue({ status: 'ok' })
      await chat.sendMessage('hi')

      const body = mockSessionApi.sendMessage.mock.calls[0][0] as Record<string, unknown>
      expect(body.backend).toBe('loom')
      // 绝不自动 POST 通道切换
      expect(mockClient.apiPost).not.toHaveBeenCalled()
    })
  })

  // ==================== W46: switch 出线携带会话归属 backend ====================

  describe('switchSession 携带 backend 归属 (W46)', () => {
    it('已登记归属的会话: apiSwitchSession 收到 (sid, backend), 历史腿照常带 ?backend=', async () => {
      mockClient.apiGet.mockResolvedValue({
        sessions: [
          { id: 'w46_eng', title: 'E', date: '今日', preview: '', backend: 'loom' },
        ],
      })
      mockSessionApi.switchSession.mockResolvedValue(true)
      mockClient.apiGetVerbose.mockResolvedValue({ status: 200, ok: true, data: { messages: [] } })

      await chat.loadSessions()
      await chat.switchSession('w46_eng')

      expect(mockSessionApi.switchSession).toHaveBeenCalledWith('w46_eng', 'loom')
      // 成功后的既有链路不动: loadChatHistory 仍经映射拼 ?backend=
      expect(mockClient.apiGetVerbose).toHaveBeenCalledWith(
        '/api/screen/session/w46_eng/messages?backend=loom',
      )
      expect(chat.currentSessionId.value).toBe('w46_eng')
    })

    it('未登记归属的会话: 第二参为 undefined (老形状, wire 键省略由 api 层两态用例锁定)', async () => {
      mockSessionApi.switchSession.mockResolvedValue(true)
      mockClient.apiGetVerbose.mockResolvedValue({ status: 200, ok: true, data: { messages: [] } })

      await chat.switchSession('w46_nomap')

      expect(mockSessionApi.switchSession).toHaveBeenCalledWith('w46_nomap', undefined)
      expect(mockClient.apiGetVerbose).toHaveBeenCalledWith(
        '/api/screen/session/w46_nomap/messages',
      )
    })

    it('切换失败 (!switched) 早退语义不动: 不加载历史不改当前会话', async () => {
      mockSessionApi.switchSession.mockResolvedValue(false)

      await chat.switchSession('w46_fail')

      expect(chat.currentSessionId.value).toBe('')
      expect(mockClient.apiGetVerbose).not.toHaveBeenCalled()
    })
  })
})
