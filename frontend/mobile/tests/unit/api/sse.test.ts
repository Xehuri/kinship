/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** 捕获创建的 EventSource 实例 */
class FakeEventSource {
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  url: string
  closed = false
  static instances: FakeEventSource[] = []

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
  }
}

import { setToken } from '@/api/client'
import { createSSEConnection, disconnectSSE } from '@/api/sse'

/** 模拟 POST /auth/ws-ticket 成功返回指定 ticket */
function mockTicketSuccess(ticket: string) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ticket, expires_in: 30 }),
    text: async () => '',
  }))
}

/** 模拟 POST /auth/ws-ticket 失败 (HTTP 状态码) */
function mockTicketFailure(status: number) {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({ success: false }),
    text: async () => '',
  }))
}

describe('api/sse 一次性 ticket (FE-H2) + 不自动重连 (FE-H3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    setToken('test-token')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    setToken('')
  })

  it('EventSource URL 使用 ticket 而非 token', async () => {
    vi.stubGlobal('fetch', mockTicketSuccess('tk-abc'))

    await createSSEConnection()

    expect(FakeEventSource.instances).toHaveLength(1)
    const url = FakeEventSource.instances[0].url
    expect(url).toContain('/api/screen/events/stream')
    expect(url).toContain('ticket=tk-abc')
    expect(url).not.toContain('token=')
    expect(url).not.toContain('test-token')
  })

  it('票据获取失败时返回 null 且不建连 (优雅降级)', async () => {
    vi.stubGlobal('fetch', mockTicketFailure(500))

    const sse = await createSSEConnection()
    expect(sse).toBeNull()
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('创建单条连接且 onerror 不产生新连接 (重连交给上层)', async () => {
    vi.stubGlobal('fetch', mockTicketSuccess('tk-1'))

    const statuses: boolean[] = []
    await createSSEConnection(undefined, (c) => statuses.push(c))

    expect(FakeEventSource.instances).toHaveLength(1)

    // 触发错误: 应关闭当前连接并通知 false, 但不自行重连
    FakeEventSource.instances[0].onerror?.(new Event('error'))
    vi.advanceTimersByTime(60000)

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].closed).toBe(true)
    expect(statuses).toContain(false)
  })

  it('disconnectSSE 关闭连接', async () => {
    vi.stubGlobal('fetch', mockTicketSuccess('tk-2'))

    const sse = await createSSEConnection(undefined, () => {})
    disconnectSSE(sse)
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })
})
