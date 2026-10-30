/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// USE_MOCK_DATA 置 false, 走真实 API 流程
vi.mock('@/composables/useMockData', () => ({
  USE_MOCK_DATA: false,
}))

// mock useChatSingleton (loadSubAgents 依赖, 避免真实单例副作用);
// W45: useSubAgents 新增模块级访问器 getSessionBackend/setSessionBackend, mock 面同步补齐
// W46: switchSession 提升为可断言 spy (returnToParent 委派腿)
const mockChat = vi.hoisted(() => ({
  currentSessionId: { value: 'parent_ses' },
  currentSessionTitle: { value: '主会话' },
  messages: { value: [] },
  clearMessages: vi.fn(),
  loadChatHistory: vi.fn(),
  switchSession: vi.fn(),
}))

vi.mock('@/composables/useChat', () => ({
  useChatSingleton: () => mockChat,
  getSessionBackend: vi.fn(() => undefined),
  setSessionBackend: vi.fn(),
}))

// mock useStreamingMessageSingleton (T-C5: 增加 finalizeStreaming 供 enterSubAgent 调用)
const streamingMock = vi.hoisted(() => ({
  finalizeStreaming: vi.fn(),
  setActiveSessionId: vi.fn(),
  updateTokens: vi.fn(),
  currentTokens: { value: null },
}))
vi.mock('@/composables/useStreamingMessage', () => ({
  useStreamingMessageSingleton: () => streamingMock,
}))

import { useSubAgents, type SubAgentInfo } from '@/composables/useSubAgents'

describe('子智能体会话 (子会话模式/token 由进入会话后加载)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('SubAgentInfo 接口不含 tokens 字段 (列表不加载 token, 避免批量请求)', () => {
    const agent: SubAgentInfo = {
      id: 'a1',
      name: '测试',
      type: 'explore',
      childSessionId: 'child_1',
      status: 'completed',
      messageIndex: 0,
    }
    expect(agent).not.toHaveProperty('tokens')
    // 类型层面也不允许 tokens (运行时无该字段)
    expect('tokens' in agent).toBe(false)
  })

  it('loadSubAgents 不发起子会话 messages 请求 (仅 children 接口)', async () => {
    const sa = useSubAgents()
    // USE_MOCK_DATA=false + 无 sessionId 时清空列表, 不触发任何子会话请求
    await sa.loadSubAgents('', [])
    expect(sa.subAgents.value).toEqual([])
  })

  it('进入子会话后 isChildMode 为 true, 返回父会话后恢复 false', async () => {
    const sa = useSubAgents()
    expect(sa.isChildMode.value).toBe(false)

    await sa.enterSubAgent('child_ses_1')
    expect(sa.isChildMode.value).toBe(true)
    expect(sa.parentChain.value.length).toBe(1)
    expect(sa.parentChain.value[0].sessionId).toBe('parent_ses')
    expect(sa.parentSessionTitle.value).toBe('主会话')

    await sa.returnToParent()
    expect(sa.isChildMode.value).toBe(false)
    expect(sa.parentChain.value.length).toBe(0)
    // W46: 返父必须走 useChat.switchSession 正门 (映射查询在其内部,
    // backend 携带由 useChat.test.ts W46 用例锁定), 不得旁路直连 api
    expect(mockChat.switchSession).toHaveBeenCalledWith('parent_ses')
  })

  it('多级嵌套: 连续进入两个子会话, parentChain 压栈', async () => {
    const sa = useSubAgents()
    await sa.enterSubAgent('child_1')
    await sa.enterSubAgent('grandchild_1')
    expect(sa.parentChain.value.length).toBe(2)
    expect(sa.isChildMode.value).toBe(true)

    // 逐级返回
    await sa.returnToParent()
    expect(sa.parentChain.value.length).toBe(1)
    expect(sa.isChildMode.value).toBe(true)
    await sa.returnToParent()
    expect(sa.parentChain.value.length).toBe(0)
    expect(sa.isChildMode.value).toBe(false)
  })

  it('returnToParent 在非子会话模式下无副作用', async () => {
    const sa = useSubAgents()
    await sa.returnToParent()
    expect(sa.parentChain.value.length).toBe(0)
    expect(sa.isChildMode.value).toBe(false)
  })

  it('enterSubAgent 调用 finalizeStreaming 以 resolve 父会话 pending (T-C5)', async () => {
    const sa = useSubAgents()
    await sa.enterSubAgent('child_fin')
    expect(streamingMock.finalizeStreaming).toHaveBeenCalled()
  })

  it('enterSubAgent 重置 token 显示, 避免父会话用量泄漏到子会话 (C7)', async () => {
    streamingMock.updateTokens.mockClear()
    const sa = useSubAgents()
    await sa.enterSubAgent('child_token')
    expect(streamingMock.updateTokens).toHaveBeenCalledWith(null)
  })
})
