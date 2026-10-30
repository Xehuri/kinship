/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * FE-H1: 明文凭证不再写入 localStorage, 仅持久化 token。
 *
 * 这里不直接 import useApi 的旧凭据函数 (已删除), 而是通过登录/登出行为,
 * 断言 localStorage 中既没有 mobile_credentials 键, 也没有任何值包含明文密码。
 */

/** 断言 localStorage 中不存在凭据键, 且任意值都不含明文密码 */
function assertNoPasswordInStorage(password: string): void {
  expect(localStorage.getItem('mobile_credentials')).toBeNull()
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key) continue
    expect(localStorage.getItem(key) || '').not.toContain(password)
  }
}

describe('凭证持久化安全 (FE-H1)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('login 成功后仅持久化 token, 不写入任何密码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: async () => ({ success: true, token: 'new-token-abc' }),
      }),
    )

    const { useApi } = await import('@/composables/useApi')
    const api = useApi()
    const result = await api.login('admin', 'secret123')

    expect(result?.success).toBe(true)
    expect(localStorage.getItem('mobile_token')).toBe('new-token-abc')
    assertNoPasswordInStorage('secret123')
  })

  it('login 失败不写入 token, 也不残留密码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: async () => ({ success: false, message: '用户名或密码错误' }),
      }),
    )

    const { useApi } = await import('@/composables/useApi')
    const api = useApi()
    const result = await api.login('admin', 'wrong-password')

    expect(result?.success).toBe(false)
    expect(localStorage.getItem('mobile_token')).toBeNull()
    assertNoPasswordInStorage('wrong-password')
  })

  it('logout 清除 token 且不残留密码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: async () => ({ success: true, token: 'tok-1' }),
      }),
    )
    const { useApi } = await import('@/composables/useApi')
    const api = useApi()
    await api.login('admin', 'secret123')
    expect(localStorage.getItem('mobile_token')).toBe('tok-1')

    api.logout()

    expect(localStorage.getItem('mobile_token')).toBeNull()
    assertNoPasswordInStorage('secret123')
  })
})
