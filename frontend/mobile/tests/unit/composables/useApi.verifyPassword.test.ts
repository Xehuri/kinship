/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyPassword } from '@/composables/useApi'
import { setToken } from '@/api/client'

const PASSWORD = 'gate-secret-123'

function mockResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: async () => body,
  }
}

function storageDump(): string {
  const parts: string[] = []
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key) parts.push(key, storage.getItem(key) ?? '')
    }
  }
  return parts.join('|')
}

describe('useApi.verifyPassword', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    setToken('user-token-abc')
    vi.restoreAllMocks()
  })

  afterEach(() => {
    setToken('')
    localStorage.clear()
    sessionStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns valid=true on 200 without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(200, { valid: true })),
    )

    const result = await verifyPassword(PASSWORD)

    expect(result).toEqual({ valid: true })
  })

  it('keeps the backend code and message on 403 password_invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse(403, { code: 'password_invalid', message: '密码错误' }),
      ),
    )

    const result = await verifyPassword(PASSWORD)

    expect(result.valid).toBe(false)
    expect(result.code).toBe('password_invalid')
    expect(result.message).toBe('密码错误')
  })

  it('exposes retry_after on 429 rate_limited', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse(429, {
          code: 'rate_limited',
          message: '尝试次数过多，请 17 秒后再试',
          retry_after: 17,
        }),
      ),
    )

    const result = await verifyPassword(PASSWORD)

    expect(result.valid).toBe(false)
    expect(result.code).toBe('rate_limited')
    expect(result.retry_after).toBe(17)
    expect(result.message).toContain('17')
  })

  it('sends the bearer token and the password in the request body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(200, { valid: true }))
    vi.stubGlobal('fetch', mockFetch)

    await verifyPassword(PASSWORD)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [path, init] = mockFetch.mock.calls[0]
    expect(path).toBe('/auth/verify-password')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer user-token-abc')
    expect(JSON.parse(init.body)).toEqual({ password: PASSWORD })
  })

  it('does not persist the password in localStorage or sessionStorage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(200, { valid: true })),
    )

    await verifyPassword(PASSWORD)

    expect(storageDump()).not.toContain(PASSWORD)
    expect(localStorage.getItem('mobile_credentials')).toBeNull()
  })

  it('maps a network failure to valid=false without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const result = await verifyPassword(PASSWORD)

    expect(result.valid).toBe(false)
    expect(result.code).toBe('network_error')
  })
})
