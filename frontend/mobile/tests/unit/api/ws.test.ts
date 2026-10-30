/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** 捕获创建的 WebSocket 实例, 用于模拟连接/断开 */
class FakeWebSocket {
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  url: string
  closed = false
  static instances: FakeWebSocket[] = []

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.closed = true
  }
}

import { setToken } from '@/api/client'
import { createWsConnection, disconnectWs } from '@/api/ws'

/** 模拟 POST /auth/ws-ticket 成功返回指定 ticket */
function mockTicketSuccess(ticket: string) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ticket, expires_in: 30 }),
    text: async () => '',
  }))
}

/** 模拟 POST /auth/ws-ticket 失败 */
function mockTicketFailure(status: number) {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({ success: false }),
    text: async () => '',
  }))
}

describe('api/ws 一次性 ticket (FE-H2) + 重连生命周期 (FE-H4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    setToken('test-token')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    setToken('')
  })

  it('WebSocket URL 使用 ticket 而非 token', async () => {
    vi.stubGlobal('fetch', mockTicketSuccess('tk-ws'))

    await createWsConnection()

    expect(FakeWebSocket.instances).toHaveLength(1)
    const url = FakeWebSocket.instances[0].url
    expect(url).toContain('/ws?ticket=tk-ws')
    expect(url).not.toContain('token=')
    expect(url).not.toContain('test-token')
  })

  it('断开后清除重连定时器, 不再新建 WS', async () => {
    vi.stubGlobal('fetch', mockTicketSuccess('tk-ws'))

    const ws = await createWsConnection()
    expect(FakeWebSocket.instances).toHaveLength(1)

    // 模拟连接断开 -> 触发自动重连 (重连会重新换取 ticket)
    FakeWebSocket.instances[0].onclose?.(new Event('close'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakeWebSocket.instances).toHaveLength(2)

    // 主动断开应清除重连定时器并关闭当前活跃 socket
    disconnectWs(ws)

    // 即使再模拟断开, 也不应再新建连接
    FakeWebSocket.instances[1].onclose?.(new Event('close'))
    await vi.advanceTimersByTimeAsync(120000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('票据获取失败时优雅降级 (不立即建连, 但仍返回可管理的句柄)', async () => {
    vi.stubGlobal('fetch', mockTicketFailure(500))

    const ws = await createWsConnection()
    expect(ws).not.toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(0)

    // 句柄可正常关闭并停止后续重连
    disconnectWs(ws)
    await vi.advanceTimersByTimeAsync(120000)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('无 token 时返回 null', async () => {
    setToken('')
    const ws = await createWsConnection()
    expect(ws).toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})
