// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildControlUrl } from '../../src/main/shell/control-url'

describe('buildControlUrl', () => {
  it('uses the bundled protocol when no renderer dev URL is configured', () => {
    expect(buildControlUrl('setup')).toBe('axeuh://bundle/index.html#/setup')
    expect(buildControlUrl('settings')).toBe('axeuh://bundle/index.html#/settings')
  })

  it('uses the renderer dev URL when configured', () => {
    expect(buildControlUrl('setup', undefined, 'http://localhost:5174')).toBe(
      'http://localhost:5174/#/setup',
    )
    expect(buildControlUrl('settings', undefined, 'http://localhost:5174/')).toBe(
      'http://localhost:5174/#/settings',
    )
  })

  it('encodes query values', () => {
    const url = buildControlUrl('error', {
      code: 'CERT_INVALID',
      message: '证书 无效/过期',
      url: 'https://health.example/mobile/',
    })
    const expected = new URLSearchParams({
      code: 'CERT_INVALID',
      message: '证书 无效/过期',
      url: 'https://health.example/mobile/',
    }).toString()

    expect(url).toBe(`axeuh://bundle/index.html#/error?${expected}`)
  })

  it('omits the query separator when there is no query', () => {
    expect(buildControlUrl('setup', {}, 'http://localhost:5174')).toBe(
      'http://localhost:5174/#/setup',
    )
  })
})
