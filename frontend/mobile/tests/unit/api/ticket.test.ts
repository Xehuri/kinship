/// <reference types="vitest/globals" />

import { describe, it, expect, vi, afterEach } from 'vitest'
import { setToken } from '@/api/client'
import { fetchWsTicket } from '@/api/ticket'

/** 模拟 POST /auth/ws-ticket 响应 */
function mockResponse(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => '',
  }))
}

describe('api/ticket fetchWsTicket (FE-H2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setToken('')
  })

  it('成功时返回 ticket', async () => {
    setToken('bearer-token')
    vi.stubGlobal('fetch', mockResponse({ ticket: 'abc123', expires_in: 30 }))

    expect(await fetchWsTicket()).toBe('abc123')
  })

  it('HTTP 失败时返回 null (不抛异常)', async () => {
    setToken('bearer-token')
    vi.stubGlobal('fetch', mockResponse({ success: false }, 500))

    expect(await fetchWsTicket()).toBeNull()
  })

  it('网络异常时返回 null (优雅降级)', async () => {
    setToken('bearer-token')
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))

    expect(await fetchWsTicket()).toBeNull()
  })

  it('响应缺少 ticket 字段时返回 null', async () => {
    setToken('bearer-token')
    vi.stubGlobal('fetch', mockResponse({ expires_in: 30 }))

    expect(await fetchWsTicket()).toBeNull()
  })

  it('票据接口 401 时返回 null (并触发 auth fail)', async () => {
    setToken('')
    vi.stubGlobal('fetch', mockResponse({ detail: 'unauthorized' }, 401))

    expect(await fetchWsTicket()).toBeNull()
  })
})
