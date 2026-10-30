// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decidePermission } from '../../src/main/shell/permissions'

const ORIGIN = 'https://health.example:8768'

describe('decidePermission', () => {
  it('allows sanitized clipboard writes only for the configured origin', () => {
    expect(decidePermission('clipboard-sanitized-write', ORIGIN, ORIGIN)).toBe(true)
    expect(
      decidePermission('clipboard-sanitized-write', 'https://other.example', ORIGIN),
    ).toBe(false)
  })

  it('denies clipboard reads', () => {
    expect(decidePermission('clipboard-read', ORIGIN, ORIGIN)).toBe(false)
  })

  it('denies camera, microphone and notification permissions', () => {
    expect(decidePermission('media', ORIGIN, ORIGIN)).toBe(false)
    expect(decidePermission('notifications', ORIGIN, ORIGIN)).toBe(false)
    expect(decidePermission('geolocation', ORIGIN, ORIGIN)).toBe(false)
    expect(decidePermission('midi', ORIGIN, ORIGIN)).toBe(false)
    expect(decidePermission('display-capture', ORIGIN, ORIGIN)).toBe(false)
  })

  it('denies everything when no server origin is configured', () => {
    expect(decidePermission('clipboard-sanitized-write', ORIGIN, null)).toBe(false)
  })
})
