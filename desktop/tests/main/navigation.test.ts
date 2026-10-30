// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  decideMainNavigation,
  isAllowedControlUrl,
  isHttpUrl,
  isOpenSettingsAction,
  isSameOrigin,
} from '../../src/main/shell/navigation'

const ORIGIN = 'https://health.example:8768'

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true)
    expect(isHttpUrl('http://example.com')).toBe(true)
  })

  it('rejects non-http schemes and malformed values', () => {
    expect(isHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('axeuh://bundle/index.html')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })
})

describe('isSameOrigin', () => {
  it('compares scheme, host and port', () => {
    expect(isSameOrigin(`${ORIGIN}/mobile/`, ORIGIN)).toBe(true)
    expect(isSameOrigin('https://health.example/mobile/', ORIGIN)).toBe(false)
    expect(isSameOrigin('http://health.example:8768/mobile/', ORIGIN)).toBe(false)
    expect(isSameOrigin('https://other.example/mobile/', ORIGIN)).toBe(false)
  })

  it('never matches when no origin is configured', () => {
    expect(isSameOrigin(`${ORIGIN}/mobile/`, null)).toBe(false)
  })
})

describe('isOpenSettingsAction', () => {
  it('accepts the open-settings scheme with optional query', () => {
    expect(isOpenSettingsAction('axeuh://open-settings')).toBe(true)
    expect(isOpenSettingsAction('axeuh://open-settings?from=mobile')).toBe(true)
  })

  it('rejects http urls and other axeuh actions', () => {
    expect(isOpenSettingsAction('https://health.example/open-settings')).toBe(false)
    expect(isOpenSettingsAction('axeuh://open-debug')).toBe(false)
    expect(isOpenSettingsAction('axeuh://bundle/index.html#/settings')).toBe(false)
  })
})

describe('decideMainNavigation', () => {
  it('allows same-origin navigation', () => {
    expect(decideMainNavigation(`${ORIGIN}/mobile/settings`, ORIGIN)).toBe('allow')
  })

  it('sends other http(s) destinations to the system browser', () => {
    expect(decideMainNavigation('https://example.com/', ORIGIN)).toBe('external')
    expect(decideMainNavigation('http://example.com/', ORIGIN)).toBe('external')
  })

  it('blocks file and javascript navigation', () => {
    expect(decideMainNavigation('file:///etc/passwd', ORIGIN)).toBe('block')
    expect(decideMainNavigation('javascript:alert(1)', ORIGIN)).toBe('block')
    expect(decideMainNavigation('axeuh://bundle/index.html', ORIGIN)).toBe('block')
  })
})

describe('isAllowedControlUrl', () => {
  const prefixes = ['axeuh://bundle/', 'http://localhost:5174']

  it('allows the bundle protocol and the renderer dev server', () => {
    expect(isAllowedControlUrl('axeuh://bundle/index.html#/setup', prefixes)).toBe(true)
    expect(isAllowedControlUrl('http://localhost:5174/#/settings', prefixes)).toBe(true)
    expect(isAllowedControlUrl('http://localhost:5174', prefixes)).toBe(true)
  })

  it('rejects look-alike hosts and other paths', () => {
    expect(isAllowedControlUrl('http://localhost:51740/#/setup', prefixes)).toBe(false)
    expect(isAllowedControlUrl('http://localhost:5174.evil.example/', prefixes)).toBe(false)
    expect(isAllowedControlUrl('https://example.com/', prefixes)).toBe(false)
    expect(isAllowedControlUrl('file:///etc/passwd', prefixes)).toBe(false)
  })
})
