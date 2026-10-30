// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  resolveTransportServerUrl,
  validateSensorConfigPatch,
  validateServerUrlInput,
  validateTransportConfig,
} from '../../src/shared/validation'

describe('validateServerUrlInput', () => {
  it('returns the normalized origin for a valid address', () => {
    expect(validateServerUrlInput('example.com')).toEqual({
      ok: true,
      url: 'https://example.com',
    })
  })

  it('explains an empty address', () => {
    expect(validateServerUrlInput('   ')).toEqual({
      ok: false,
      code: 'EMPTY_URL',
      message: '请输入服务器地址',
    })
  })

  it('explains an unsupported scheme', () => {
    expect(validateServerUrlInput('ftp://host')).toEqual({
      ok: false,
      code: 'UNSUPPORTED_SCHEME',
      message: '仅支持 http:// 或 https:// 地址',
    })
  })

  it('explains embedded credentials', () => {
    expect(validateServerUrlInput('https://user:pass@host')).toEqual({
      ok: false,
      code: 'URL_HAS_CREDENTIALS',
      message: '服务器地址不能包含用户名或密码',
    })
  })

  it('explains a base path', () => {
    expect(validateServerUrlInput('https://host/mobile/')).toEqual({
      ok: false,
      code: 'URL_HAS_PATH',
      message: '服务器地址只能包含协议、主机和端口，不能带路径',
    })
  })

  it('uses the generic message for malformed input', () => {
    expect(validateServerUrlInput('https://exa mple.com')).toEqual({
      ok: false,
      code: 'URL_INVALID',
      message: '服务器地址格式不正确',
    })
  })
})

describe('validateSensorConfigPatch', () => {
  it('accepts an empty patch', () => {
    expect(validateSensorConfigPatch({})).toEqual({ ok: true })
  })

  it('accepts an offline collector without credentials', () => {
    expect(
      validateSensorConfigPatch({ agentId: 'desk-01', idleThreshold: 300 }),
    ).toEqual({ ok: true })
  })

  it.each([30, 300, 3600])('accepts idleThreshold %i', (threshold) => {
    expect(validateSensorConfigPatch({ idleThreshold: threshold })).toEqual({ ok: true })
  })

  it.each([0, 29, 3601, 30.5])('rejects idleThreshold %d', (threshold) => {
    expect(validateSensorConfigPatch({ idleThreshold: threshold })).toEqual({
      ok: false,
      message: '无人判定阈值需在 30-3600 秒之间',
    })
  })

  it('validates the trimmed agent id length', () => {
    expect(validateSensorConfigPatch({ agentId: '   ' })).toEqual({
      ok: false,
      message: '设备 ID 需为 1-64 个字符',
    })
    expect(validateSensorConfigPatch({ agentId: 'x'.repeat(64) })).toEqual({ ok: true })
    expect(validateSensorConfigPatch({ agentId: 'x'.repeat(65) })).toEqual({
      ok: false,
      message: '设备 ID 需为 1-64 个字符',
    })
  })

  it('validates the trimmed agent name length', () => {
    expect(validateSensorConfigPatch({ agentName: 'x'.repeat(64) })).toEqual({ ok: true })
    expect(validateSensorConfigPatch({ agentName: 'x'.repeat(65) })).toEqual({
      ok: false,
      message: '设备名称不能超过 64 个字符',
    })
  })

  it('validates an optional password length', () => {
    expect(validateSensorConfigPatch({ password: '' })).toEqual({
      ok: false,
      message: '密码需为 1-256 个字符',
    })
    expect(validateSensorConfigPatch({ password: 'p'.repeat(256) })).toEqual({ ok: true })
    expect(validateSensorConfigPatch({ password: 'p'.repeat(257) })).toEqual({
      ok: false,
      message: '密码需为 1-256 个字符',
    })
  })

  it('validates an optional backend token length', () => {
    expect(validateSensorConfigPatch({ backendToken: '' })).toEqual({
      ok: false,
      message: '后端令牌需为 1-512 个字符',
    })
    expect(validateSensorConfigPatch({ backendToken: 't'.repeat(512) })).toEqual({ ok: true })
    expect(validateSensorConfigPatch({ backendToken: 't'.repeat(513) })).toEqual({
      ok: false,
      message: '后端令牌需为 1-512 个字符',
    })
  })

  it('does not validate the shell-synced serverUrl', () => {
    expect(validateSensorConfigPatch({ serverUrl: 'javascript:alert(1)' })).toEqual({ ok: true })
  })
})

describe('validateTransportConfig', () => {
  it('defaults missing fields to auto mode with no candidates', () => {
    expect(validateTransportConfig({})).toEqual({
      ok: true,
      transport: { mode: 'auto', endpointCandidates: [] },
    })
  })

  it('normalizes candidate origins and keeps the selected endpoint', () => {
    expect(
      validateTransportConfig({
        mode: 'frp',
        endpointCandidates: [
          { name: ' ipv6 ', url: 'https://ipv6.example:8443/', priority: 10 },
          { name: 'frp', url: 'frp.example', priority: 90 },
        ],
        currentEndpoint: ' frp ',
      }),
    ).toEqual({
      ok: true,
      transport: {
        mode: 'frp',
        endpointCandidates: [
          { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
          { name: 'frp', url: 'https://frp.example', priority: 90 },
        ],
        currentEndpoint: 'frp',
      },
    })
  })

  it('drops a stale current endpoint instead of failing the whole config', () => {
    expect(
      validateTransportConfig({
        mode: 'auto',
        endpointCandidates: [{ name: 'ipv6', url: 'https://ipv6.example', priority: 10 }],
        currentEndpoint: 'missing',
      }),
    ).toEqual({
      ok: true,
      transport: {
        mode: 'auto',
        endpointCandidates: [{ name: 'ipv6', url: 'https://ipv6.example', priority: 10 }],
      },
    })
  })

  it.each([
    [{ mode: 'turbo' }, '传输模式只能是 auto 或 frp'],
    [{ endpointCandidates: {} }, '端点候选必须是数组'],
    [{ endpointCandidates: [{ name: '', url: 'https://host', priority: 1 }] }, '第 1 个端点的名称需为 1-64 个字符'],
    [
      { endpointCandidates: [{ name: 'ipv6', url: 'http://example.com', priority: 1 }] },
      '端点 ipv6 必须使用 https（仅 localhost 允许 http）',
    ],
    [
      {
        endpointCandidates: [
          { name: 'dup', url: 'https://one.example', priority: 1 },
          { name: 'dup', url: 'https://two.example', priority: 2 },
        ],
      },
      '端点名称重复：dup',
    ],
    [
      { endpointCandidates: [{ name: 'ipv6', url: 'https://ipv6.example', priority: 1.5 }] },
      '端点 ipv6 的优先级必须是整数',
    ],
  ])('rejects invalid transport config %#', (value, message) => {
    expect(validateTransportConfig(value)).toEqual({ ok: false, message })
  })
})

describe('resolveTransportServerUrl', () => {
  it('returns the selected candidate url', () => {
    expect(
      resolveTransportServerUrl(
        {
          mode: 'auto',
          endpointCandidates: [
            { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
            { name: 'frp', url: 'https://frp.example:8443', priority: 90 },
          ],
          currentEndpoint: 'frp',
        },
        'https://server.example',
      ),
    ).toBe('https://frp.example:8443')
  })

  it('falls back to the server url when no endpoint is selected', () => {
    expect(
      resolveTransportServerUrl(
        {
          mode: 'auto',
          endpointCandidates: [{ name: 'ipv6', url: 'https://ipv6.example', priority: 10 }],
        },
        ' https://server.example ',
      ),
    ).toBe('https://server.example')
  })
})
