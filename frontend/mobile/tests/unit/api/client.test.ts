/// <reference types="vitest/globals" />

/**
 * client.ts 401 守卫测试
 *
 * 验证 401 只在请求所用 token 仍是当前 token 时触发 auth fail;
 * 请求在途期间 token 被轮换/清空时, 过期请求的 401 必须被忽略,
 * 否则刚注入的新 token 会被旧请求误清除。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  apiDelete,
  apiGet,
  apiGetVerbose,
  apiPost,
  apiPostVerbose,
  apiUpload,
  getToken,
  offAuthFail,
  onAuthFail,
  setToken,
} from '@/api/client'

interface DeferredResponse {
  promise: Promise<Response>
  resolve: (response: Response) => void
}

/** 构造一个由测试手动 resolve 的 fetch 响应 */
function deferResponse(): DeferredResponse {
  let resolveResponse: (response: Response) => void = () => {}
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve
  })
  return { promise, resolve: resolveResponse }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 取第 index 次 fetch 调用携带的 Authorization 头 */
function authHeader(fetchMock: ReturnType<typeof vi.fn>, index = 0): string | undefined {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
  const headers = init?.headers as Record<string, string> | undefined
  return headers?.['Authorization']
}

describe('client.ts 过期 401 守卫', () => {
  let authFailHandler: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setToken('')
    authFailHandler = vi.fn()
    onAuthFail(authFailHandler)
  })

  afterEach(() => {
    offAuthFail(authFailHandler)
    setToken('')
    vi.unstubAllGlobals()
  })

  it('token 未变化时 401 触发一次 auth fail, 返回 null 并携带 Bearer A', async () => {
    setToken('A')
    const deferred = deferResponse()
    const fetchMock = vi.fn(() => deferred.promise)
    vi.stubGlobal('fetch', fetchMock)

    const pending = apiGet('/api/test')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(authHeader(fetchMock)).toBe('Bearer A')

    deferred.resolve(jsonResponse(401, { detail: 'unauthorized' }))
    await expect(pending).resolves.toBeNull()

    expect(authFailHandler).toHaveBeenCalledTimes(1)
  })

  it('请求在途时 token 从 A 轮换为 B, 过期 401 不触发 auth fail', async () => {
    setToken('A')
    const deferred = deferResponse()
    const fetchMock = vi.fn(() => deferred.promise)
    vi.stubGlobal('fetch', fetchMock)

    const pending = apiGet('/api/test')
    setToken('B')

    deferred.resolve(jsonResponse(401, {}))
    await expect(pending).resolves.toBeNull()

    expect(authFailHandler).not.toHaveBeenCalled()
    expect(getToken()).toBe('B')
    expect(authHeader(fetchMock)).toBe('Bearer A')
  })

  it.each([
    ['apiPost', () => apiPost('/api/test', { a: 1 })],
    ['apiDelete', () => apiDelete('/api/test')],
    ['apiGetVerbose', () => apiGetVerbose('/api/test')],
    ['apiPostVerbose', () => apiPostVerbose('/api/test', { a: 1 })],
    ['apiUpload', () => apiUpload(new File(['x'], 'x.txt', { type: 'text/plain' }))],
  ] as const)('%s 的过期 401 被忽略', async (name, call) => {
    setToken('A')
    const deferred = deferResponse()
    vi.stubGlobal('fetch', vi.fn(() => deferred.promise))

    const pending = call()
    setToken('B')
    deferred.resolve(jsonResponse(401, { detail: 'unauthorized' }))
    const result = await pending

    expect(authFailHandler).not.toHaveBeenCalled()
    if (name.endsWith('Verbose')) {
      expect(result).toMatchObject({ status: 401, ok: false })
    } else {
      expect(result).toBeNull()
    }
  })

  it('apiPostVerbose 在 token 未变化时触发 auth fail 并返回解析后的 401 响应体', async () => {
    setToken('A')
    const deferred = deferResponse()
    vi.stubGlobal('fetch', vi.fn(() => deferred.promise))

    const pending = apiPostVerbose('/api/test', { a: 1 })
    deferred.resolve(jsonResponse(401, { detail: 'token expired' }))

    await expect(pending).resolves.toEqual({
      status: 401,
      ok: false,
      data: { detail: 'token expired' },
    })
    expect(authFailHandler).toHaveBeenCalledTimes(1)
  })

  it('空 token 发起的请求 401 时触发 auth fail', async () => {
    const deferred = deferResponse()
    const fetchMock = vi.fn(() => deferred.promise)
    vi.stubGlobal('fetch', fetchMock)

    const pending = apiGet('/api/test')
    expect(authHeader(fetchMock)).toBeUndefined()

    deferred.resolve(jsonResponse(401, {}))
    await expect(pending).resolves.toBeNull()

    expect(authFailHandler).toHaveBeenCalledTimes(1)
  })

  it('请求在途时 token 被清空, 过期 401 被忽略', async () => {
    setToken('A')
    const deferred = deferResponse()
    vi.stubGlobal('fetch', vi.fn(() => deferred.promise))

    const pending = apiPost('/api/test', {})
    setToken('')

    deferred.resolve(jsonResponse(401, {}))
    await expect(pending).resolves.toBeNull()

    expect(authFailHandler).not.toHaveBeenCalled()
  })
})
