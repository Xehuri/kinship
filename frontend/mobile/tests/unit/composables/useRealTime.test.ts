/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

// ==================== Mock API 模块 (隔离网络与 ticket 依赖) ====================

const sseMock = vi.hoisted(() => ({
  create: vi.fn(),
  disconnect: vi.fn(),
}))
const wsMock = vi.hoisted(() => ({
  create: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock('@/api/sse', () => ({
  createSSEConnection: sseMock.create,
  disconnectSSE: sseMock.disconnect,
}))

vi.mock('@/api/ws', () => ({
  createWsConnection: wsMock.create,
  disconnectWs: wsMock.disconnect,
}))

// T-C5: mock useChat (重连后 resync 依赖), 避免真实会话侧副作用
const chatMock = vi.hoisted(() => ({
  useChatSingleton: vi.fn(),
}))
vi.mock('@/composables/useChat', () => ({
  useChatSingleton: chatMock.useChatSingleton,
}))

// ==================== 测试 ====================

import { useRealTime, useRealTimeSingleton, configureSSEReconnect } from '@/composables/useRealTime'

/** 构造伪 EventSource 实例 */
function fakeSse(): EventSource {
  return { close: vi.fn() } as unknown as EventSource
}

/** 构造伪 WS 连接句柄 */
function fakeWs(): { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn() }
}

describe('useRealTime - 实例隔离 (FE-L1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sseMock.create.mockImplementation(async () => fakeSse())
    wsMock.create.mockImplementation(async () => fakeWs())
  })

  it('两个独立实例的连接互不干扰: 后建连不断开前者', async () => {
    const sseA = fakeSse()
    const sseB = fakeSse()
    sseMock.create.mockResolvedValueOnce(sseA).mockResolvedValueOnce(sseB)
    const wsA = fakeWs()
    const wsB = fakeWs()
    wsMock.create.mockResolvedValueOnce(wsA).mockResolvedValueOnce(wsB)

    const a = useRealTime()
    const b = useRealTime()

    a.connect()
    await flushPromises()
    b.connect()
    await flushPromises()

    // b 建连时不得断开 a 已有的连接 (共享模块级 _sse/_ws 时会被误断)
    expect(sseMock.disconnect).not.toHaveBeenCalledWith(sseA)
    expect(wsMock.disconnect).not.toHaveBeenCalledWith(wsA)
  })

  it('断开其中一个实例不影响另一个的连接', async () => {
    const sseA = fakeSse()
    const sseB = fakeSse()
    sseMock.create.mockResolvedValueOnce(sseA).mockResolvedValueOnce(sseB)
    const wsA = fakeWs()
    const wsB = fakeWs()
    wsMock.create.mockResolvedValueOnce(wsA).mockResolvedValueOnce(wsB)

    const a = useRealTime()
    const b = useRealTime()
    a.connect()
    await flushPromises()
    b.connect()
    await flushPromises()

    a.disconnect()

    // a 的连接被断开
    expect(sseMock.disconnect).toHaveBeenCalledWith(sseA)
    expect(wsMock.disconnect).toHaveBeenCalledWith(wsA)
    // b 的连接应保持, 不受 a 影响
    expect(sseMock.disconnect).not.toHaveBeenCalledWith(sseB)
    expect(wsMock.disconnect).not.toHaveBeenCalledWith(wsB)
  })

  it('消息处理器按实例隔离: 一个实例的消息不触达另一个实例', async () => {
    const sseA = fakeSse()
    sseMock.create.mockResolvedValueOnce(sseA)
    const wsA = fakeWs()
    wsMock.create.mockResolvedValueOnce(wsA)
    const sseB = fakeSse()
    sseMock.create.mockResolvedValueOnce(sseB)
    const wsB = fakeWs()
    wsMock.create.mockResolvedValueOnce(wsB)

    const a = useRealTime()
    const b = useRealTime()
    const handlerA = vi.fn()
    const handlerB = vi.fn()
    a.onSSEMessage(handlerA)
    b.onSSEMessage(handlerB)

    a.connect()
    await flushPromises()
    b.connect()
    await flushPromises()

    // 取出 a 实例建连时注册的 onMessage 回调并触发
    const aOnMessage = sseMock.create.mock.calls[0][0] as (e: MessageEvent) => void
    aOnMessage({ data: 'x' } as MessageEvent)

    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerB).not.toHaveBeenCalled()
  })

  it('useRealTimeSingleton 多次调用返回同一实例', () => {
    const s1 = useRealTimeSingleton()
    const s2 = useRealTimeSingleton()
    expect(s1).toBe(s2)
  })
})

// ==================== T-C5: SSE 重连与重连后 resync ====================

describe('useRealTime - SSE 重连 (T-C5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sseMock.create.mockImplementation(async () => fakeSse())
    wsMock.create.mockImplementation(async () => fakeWs())
    // 默认无活跃会话, 避免触发真实历史加载
    chatMock.useChatSingleton.mockReturnValue({
      currentSessionId: { value: '' },
      loadChatHistory: vi.fn(),
    })
  })

  afterEach(() => {
    // 恢复默认重连策略, 避免影响其他测试
    configureSSEReconnect({ delays: [3, 5, 10, 15, 30], maxAttempts: 30, resyncOnReconnect: true })
  })

  it('重连成功后重新同步当前会话历史', async () => {
    const loadChatHistory = vi.fn()
    chatMock.useChatSingleton.mockReturnValue({
      currentSessionId: { value: 'ses_active' },
      loadChatHistory,
    })
    // 重连延迟置 0, 便于测试
    configureSSEReconnect({ delays: [0], maxAttempts: 5, resyncOnReconnect: true })

    const rt = useRealTime()
    rt.connect()
    await flushPromises()

    // 首次连接成功: 不触发 resync
    const status = sseMock.create.mock.calls[0][1] as (c: boolean) => void
    status(true)
    expect(loadChatHistory).not.toHaveBeenCalled()

    // 断线 -> 调度重连
    status(false)
    await new Promise((r) => setTimeout(r, 10))
    await flushPromises()

    // 重连建连成功 -> 触发 resync
    const status2 = sseMock.create.mock.calls[1]?.[1] as ((c: boolean) => void) | undefined
    expect(typeof status2).toBe('function')
    status2!(true)

    expect(loadChatHistory).toHaveBeenCalledWith('ses_active')
  })

  it('configureSSEReconnect 提高最大重连次数 (不再固定 3 次后永久停止)', async () => {
    configureSSEReconnect({ delays: [0], maxAttempts: 10, resyncOnReconnect: false })

    const rt = useRealTime()
    rt.connect()
    await flushPromises()

    const status = sseMock.create.mock.calls[0][1] as (c: boolean) => void
    status(true)

    // 连续 4 次断线重连 (旧逻辑第 4 次会永久停止)
    for (let i = 0; i < 4; i++) {
      status(false)
      await new Promise((r) => setTimeout(r, 5))
      await flushPromises()
    }

    // 初始 1 次 + 至少 4 次重连
    expect(sseMock.create.mock.calls.length).toBeGreaterThanOrEqual(5)
  })
})
