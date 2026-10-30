// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  UrlValidationError,
  isLoopbackHost,
  normalizeServerUrl,
} from '../../src/main/lib/url'

function thrownError(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected function to throw')
}

describe('normalizeServerUrl', () => {
  it('rejects an empty input', () => {
    const error = thrownError(() => normalizeServerUrl('   '))
    expect(error).toBeInstanceOf(UrlValidationError)
    expect(error).toMatchObject({ code: 'EMPTY_URL', message: '请输入服务器地址' })
  })

  it('prepends https when the scheme is missing', () => {
    expect(normalizeServerUrl('example.com')).toBe('https://example.com')
    expect(normalizeServerUrl('  example.com  ')).toBe('https://example.com')
  })

  it('keeps an explicit https origin and non-default port', () => {
    expect(normalizeServerUrl('https://example.com:8768')).toBe(
      'https://example.com:8768',
    )
  })

  it('keeps an explicit http loopback origin', () => {
    expect(normalizeServerUrl('http://localhost:8769')).toBe('http://localhost:8769')
  })

  it('prepends https for a bracketed IPv6 host and port', () => {
    expect(normalizeServerUrl('[::1]:8768')).toBe('https://[::1]:8768')
    expect(normalizeServerUrl('https://[::1]:8768')).toBe('https://[::1]:8768')
  })

  it('rejects any base path', () => {
    const error = thrownError(() => normalizeServerUrl('https://host/mobile/#/chat'))
    expect(error).toMatchObject({
      code: 'URL_HAS_PATH',
      message: '服务器地址只能包含协议、主机和端口，不能带路径',
    })
    expect(() => normalizeServerUrl('https://host/mobile/')).toThrow(UrlValidationError)
  })

  it('rejects credentials', () => {
    const error = thrownError(() => normalizeServerUrl('https://user:pass@host:8768'))
    expect(error).toMatchObject({
      code: 'URL_HAS_CREDENTIALS',
      message: '服务器地址不能包含用户名或密码',
    })
    expect(() => normalizeServerUrl('https://user@host')).toThrow(UrlValidationError)
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi', 'ftp://host'])(
    'rejects the unsupported scheme in %s',
    (input) => {
      const error = thrownError(() => normalizeServerUrl(input))
      expect(error).toMatchObject({ code: 'UNSUPPORTED_SCHEME' })
    },
  )

  it('strips the query and hash', () => {
    expect(normalizeServerUrl('https://example.com:8768/?a=1#section')).toBe(
      'https://example.com:8768',
    )
  })

  it('omits default ports', () => {
    expect(normalizeServerUrl('https://example.com:443')).toBe('https://example.com')
    expect(normalizeServerUrl('http://example.com:80')).toBe('http://example.com')
  })

  it('rejects malformed hosts', () => {
    const error = thrownError(() => normalizeServerUrl('https://exa mple.com'))
    expect(error).toMatchObject({ code: 'URL_INVALID' })
    expect(() => normalizeServerUrl('https://')).toThrow(UrlValidationError)
  })
})

describe('isLoopbackHost', () => {
  it('recognizes loopback hostnames only', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('LOCALHOST')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('example.com')).toBe(false)
    expect(isLoopbackHost('127.0.0.2')).toBe(false)
  })
})
