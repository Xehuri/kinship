/// <reference types="vitest/globals" />

import { describe, it, expect, vi, afterEach } from 'vitest'
import { setToken } from '@/api/client'
import { fetchFileContentVerbose, getFileRawUrl } from '@/api/files'

/** 模拟 POST /auth/ws-ticket 响应 */
function mockResponse(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => '',
  }))
}

describe('api/files getFileRawUrl 一次性 ticket (FE-H2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setToken('')
  })

  it('URL 使用 ticket 而非长期 token', async () => {
    setToken('long-lived-token')
    vi.stubGlobal('fetch', mockResponse({ ticket: 'tk-file', expires_in: 30 }))

    const url = await getFileRawUrl('/reports/a.png')

    expect(url).toContain('/api/mobile/files/raw')
    expect(url).toContain('path=%2Freports%2Fa.png')
    expect(url).toContain('ticket=tk-file')
    expect(url).not.toContain('token=')
    expect(url).not.toContain('long-lived-token')
  })

  it('scope=data 时 URL 保留 scope 且附带 ticket', async () => {
    setToken('t')
    vi.stubGlobal('fetch', mockResponse({ ticket: 'tk2', expires_in: 30 }))

    const url = await getFileRawUrl('/a/b.wav', 'data')
    expect(url).toContain('scope=data')
    expect(url).toContain('ticket=tk2')
  })

  it('票据获取失败时降级为无凭证 URL (绝不回退长期 token)', async () => {
    setToken('long-lived-token')
    vi.stubGlobal('fetch', mockResponse({ success: false }, 500))

    const url = await getFileRawUrl('/a/b.png', 'data')

    expect(url).toContain('/api/mobile/files/raw')
    expect(url).toContain('scope=data')
    expect(url).not.toContain('ticket=')
    expect(url).not.toContain('token=')
    expect(url).not.toContain('long-lived-token')
  })
})

describe('api/files fetchFileContentVerbose', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setToken('')
  })

  it('returns the HTTP status and parsed content on success', async () => {
    const fetchMock = mockResponse({ content: '{"name":"kinship"}' })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchFileContentVerbose('opencode.json')

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/mobile/files/content?scope=root&path=opencode.json',
    )
    expect(result).toEqual({
      status: 200,
      ok: true,
      data: { content: '{"name":"kinship"}' },
    })
  })

  it('preserves the status for 404 and 401 responses', async () => {
    const fetchMock = mockResponse({ detail: 'not found' }, 404)
    vi.stubGlobal('fetch', fetchMock)

    const notFound = await fetchFileContentVerbose('data/opencode.json')
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/mobile/files/content?scope=root&path=data%2Fopencode.json',
    )
    expect(notFound.status).toBe(404)
    expect(notFound.ok).toBe(false)

    vi.stubGlobal('fetch', mockResponse({ detail: 'unauthorized' }, 401))
    const unauthorized = await fetchFileContentVerbose('opencode.json')
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.ok).toBe(false)
  })

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )

    const result = await fetchFileContentVerbose('opencode.json')

    expect(result).toEqual({ status: 0, ok: false, data: null })
  })
})
