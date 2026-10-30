/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { useApi, onTokenRefresh, offTokenRefresh } from '@/composables/useApi'
import type { TokenRefreshHandler } from '@/composables/useApi'
import { getToken, setToken } from '@/api/client'

/** 派发外部注入的 token 刷新事件 (桌面壳字符串 / Android 桥对象) */
function dispatchTokenRefresh(detail: unknown): void {
  window.dispatchEvent(new CustomEvent('axeuh-token-refresh', { detail }))
}

describe('外部 token 刷新事件', () => {
  /** 每个测试注册的订阅清理函数 */
  const cleanups: Array<() => void> = []

  function register(handler: TokenRefreshHandler): void {
    onTokenRefresh(handler)
    cleanups.push(() => offTokenRefresh(handler))
  }

  beforeEach(() => {
    localStorage.clear()
    useApi().logout()
    setToken('')
  })

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
    localStorage.clear()
    setToken('')
    vi.restoreAllMocks()
  })

  it('字符串 detail 在未登录时更新 token/localStorage/登录态并通知 wasLoggedIn=false', () => {
    const api = useApi()
    const handler = vi.fn()
    register(handler)
    expect(api.isLoggedIn.value).toBe(false)

    dispatchTokenRefresh('desktop-refreshed-token')

    expect(getToken()).toBe('desktop-refreshed-token')
    expect(localStorage.getItem('mobile_token')).toBe('desktop-refreshed-token')
    expect(api.isLoggedIn.value).toBe(true)
    expect(handler).toHaveBeenCalledWith({
      token: 'desktop-refreshed-token',
      wasLoggedIn: false,
    })
  })

  it('已登录时再次收到字符串刷新, 通知 wasLoggedIn=true', () => {
    const api = useApi()
    const handler = vi.fn()
    register(handler)

    dispatchTokenRefresh('first-token')
    dispatchTokenRefresh('second-token')

    expect(getToken()).toBe('second-token')
    expect(localStorage.getItem('mobile_token')).toBe('second-token')
    expect(api.isLoggedIn.value).toBe(true)
    expect(handler).toHaveBeenLastCalledWith({
      token: 'second-token',
      wasLoggedIn: true,
    })
  })

  it('对象 detail 显式 wasLoggedIn=true 在未登录时也被采纳', () => {
    const api = useApi()
    const handler = vi.fn()
    register(handler)
    expect(api.isLoggedIn.value).toBe(false)

    dispatchTokenRefresh({ token: 'android-token', wasLoggedIn: true })

    expect(getToken()).toBe('android-token')
    expect(localStorage.getItem('mobile_token')).toBe('android-token')
    expect(api.isLoggedIn.value).toBe(true)
    expect(handler).toHaveBeenCalledWith({
      token: 'android-token',
      wasLoggedIn: true,
    })
  })

  it('非法 detail 不改变任何状态也不通知订阅者', () => {
    const api = useApi()
    const handler = vi.fn()
    register(handler)
    setToken('existing-token')
    localStorage.setItem('mobile_token', 'existing-token')

    dispatchTokenRefresh('')
    dispatchTokenRefresh(undefined)
    dispatchTokenRefresh(123)
    dispatchTokenRefresh(null)
    dispatchTokenRefresh({ token: 123 })

    expect(getToken()).toBe('existing-token')
    expect(localStorage.getItem('mobile_token')).toBe('existing-token')
    expect(api.isLoggedIn.value).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('offTokenRefresh 移除订阅后不再收到通知', () => {
    const api = useApi()
    const handler = vi.fn()
    api.onTokenRefresh(handler)
    api.offTokenRefresh(handler)

    dispatchTokenRefresh('refreshed')

    expect(handler).not.toHaveBeenCalled()
    expect(getToken()).toBe('refreshed')
  })

  it('抛错的订阅者不影响后续订阅者', () => {
    useApi()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const throwing = vi.fn(() => {
      throw new Error('boom')
    })
    const later = vi.fn()
    register(throwing)
    register(later)

    expect(() => dispatchTokenRefresh('refreshed')).not.toThrow()

    expect(throwing).toHaveBeenCalledTimes(1)
    expect(later).toHaveBeenCalledWith({ token: 'refreshed', wasLoggedIn: false })
    expect(warn).toHaveBeenCalled()
  })

  it('多次调用 useApi 只安装一次监听器', async () => {
    vi.resetModules()
    const addEventListener = vi.spyOn(window, 'addEventListener')
    const { useApi: freshUseApi } = await import('@/composables/useApi')

    freshUseApi()
    freshUseApi()

    const refreshCalls = addEventListener.mock.calls.filter(
      ([eventName]) => eventName === 'axeuh-token-refresh',
    )
    expect(refreshCalls).toHaveLength(1)
  })
})
