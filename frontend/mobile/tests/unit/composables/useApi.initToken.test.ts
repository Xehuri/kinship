/// <reference types="vitest/globals" />

/**
 * useApi initToken 的 URL token 剥离测试
 *
 * URL ?token= 被消费后必须从地址栏移除, 否则下次刷新时
 * 陈旧 URL token 会再次覆盖 localStorage 中刚注入的新 token。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('useApi initToken', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState(
      {},
      '',
      '/mobile/?token=url-tok&device_id=dev-1&client=web#/chat',
    )
  })

  afterEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    vi.resetModules()
  })

  it('消费 URL token 后写入 token/localStorage 并从地址栏剥离 token 参数', async () => {
    vi.resetModules()
    const { useApi } = await import('@/composables/useApi')
    const { getToken } = await import('@/api/client')

    useApi()

    expect(getToken()).toBe('url-tok')
    expect(localStorage.getItem('mobile_token')).toBe('url-tok')

    const params = new URLSearchParams(window.location.search)
    expect(params.get('token')).toBeNull()
    expect(params.get('device_id')).toBe('dev-1')
    expect(params.get('client')).toBe('web')
    expect(window.location.hash).toBe('#/chat')
  })

  it('仅 localStorage 有 token 时不改写 URL', async () => {
    window.history.replaceState({}, '', '/mobile/?device_id=dev-1#/chat')
    localStorage.setItem('mobile_token', 'stored-token')

    vi.resetModules()
    const { useApi } = await import('@/composables/useApi')
    const { getToken } = await import('@/api/client')

    useApi()

    expect(getToken()).toBe('stored-token')
    expect(window.location.search).toBe('?device_id=dev-1')
    expect(window.location.hash).toBe('#/chat')
  })
})
