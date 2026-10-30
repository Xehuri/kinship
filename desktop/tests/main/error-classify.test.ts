// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { classifyLoadError } from '../../src/main/shell/error-classify'

describe('classifyLoadError', () => {
  it('classifies authority failures as untrusted certificates', () => {
    expect(classifyLoadError(-202, 'ERR_CERT_AUTHORITY_INVALID')).toEqual({
      code: 'CERT_UNTRUSTED',
      message: '服务器证书不受系统信任',
    })
    expect(classifyLoadError(-3, 'ERR_CERT_AUTHORITY_INVALID')).toEqual({
      code: 'CERT_UNTRUSTED',
      message: '服务器证书不受系统信任',
    })
  })

  it('classifies hostname and validity failures as invalid certificates', () => {
    for (const code of [-200, -201, -203]) {
      expect(classifyLoadError(code, '').code).toBe('CERT_INVALID')
    }
    expect(classifyLoadError(-999, 'ERR_CERT_REVOKED')).toEqual({
      code: 'CERT_INVALID',
      message: '服务器证书无效（主机名或有效期不匹配）',
    })
  })

  it('classifies DNS and connection failures as unreachable', () => {
    for (const code of [-105, -106, -102, -118]) {
      expect(classifyLoadError(code, '').code).toBe('UNREACHABLE')
    }
    expect(classifyLoadError(-999, 'ERR_NAME_NOT_RESOLVED').code).toBe('UNREACHABLE')
    expect(classifyLoadError(-999, 'ERR_INTERNET_DISCONNECTED').code).toBe('UNREACHABLE')
    expect(classifyLoadError(-999, 'ERR_CONNECTION_REFUSED').code).toBe('UNREACHABLE')
    expect(classifyLoadError(-312, 'ERR_UNSAFE_PORT').code).toBe('UNREACHABLE')
  })

  it('falls back to UNKNOWN', () => {
    expect(classifyLoadError(-2, 'ERR_FAILED')).toEqual({
      code: 'UNKNOWN',
      message: '无法加载服务器页面',
    })
  })
})
